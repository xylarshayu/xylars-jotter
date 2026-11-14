/**
 * `jot migrate`: copies a whole store (e.g. the local server) into a fresh deployment, as
 * ciphertext, and rotates the open key on the way (ADR-0015).
 *
 * Kept as-is: note bodies, history, attachments, ids, timestamps, sync sequence, import source
 * hashes, locked channels' passphrase-wrapped keys, and their notes' previews.
 * Changed: open channels' keys are re-wrapped to the new open key, and channel names are
 * re-sealed to their channel and the new open key (ADR-0014). A locked channel whose name the
 * old open key can't read keeps its name as-is until it is next unlocked in the app. In open
 * channels, link previews with an oversized image are re-sealed with the image shrunk (ADR-0020).
 *
 * The rotation happens here, before upload, so nothing wrapped to the old key reaches the
 * new server. Prints counts only; never keys, names or note content.
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  Api,
  ApiError,
  type ChannelRow,
  type DumpRow,
  type DumpTable,
  fitPreviewImage,
  isOpenChannel,
  MAX_PREVIEW_IMAGE,
  type NoteRow,
  openPreview,
  openText,
  sealChannelName,
  sealPreview,
} from "@jot/core"
import {
  type AgeIdentity,
  type AgeRecipient,
  fromBase64,
  parseIdentity,
  recipientOf,
  toBase64,
  unwrapWithIdentity,
  wrapForRecipient,
} from "@jot/crypto"
import { accessHeaders, CliError, type Io, loadConfig, readOpenKey } from "./context.ts"
import { shrinkPreviewImage } from "./images.ts"

const PAGE = 100
const CONCURRENCY = 4
/**
 * Restore requests stay small: on the Workers free plan a request gets 10 ms of CPU, and the
 * Worker parses and checks every ciphertext it is sent.
 */
const RESTORE_BYTES = 96 * 1024
const RESTORE_ROWS = 25

/** Splits rows into runs of at most RESTORE_ROWS rows and about RESTORE_BYTES of JSON. */
export function restoreChunks<T>(rows: T[]): T[][] {
  const out: T[][] = []
  let chunk: T[] = []
  let bytes = 0
  for (const row of rows) {
    const size = JSON.stringify(row).length
    if (chunk.length && (chunk.length >= RESTORE_ROWS || bytes + size > RESTORE_BYTES)) {
      out.push(chunk)
      chunk = []
      bytes = 0
    }
    chunk.push(row)
    bytes += size
  }
  if (chunk.length) out.push(chunk)
  return out
}

async function* pages<T extends DumpTable>(api: Api, table: T): AsyncGenerator<DumpRow<T>[]> {
  let after = 0
  for (;;) {
    const page = await api.dump(table, after, PAGE)
    if (page.rows.length) yield page.rows
    if (page.next === null) return
    after = page.next
  }
}

export interface MigrateCounts {
  channels: number
  openRewrapped: number
  lockedNamesShared: number
  lockedNamesPending: number
  notes: number
  versions: number
  attachments: number
  missingAttachments: number
  previewsShrunk: number
}

/**
 * Re-seals a note's link previews if one has an image over MAX_PREVIEW_IMAGE, with that image
 * shrunk (or dropped if it can't be). Only open channels: `identity` is the channel's key.
 */
async function fitPreviews<T extends NoteRow>(
  row: T,
  identity: AgeIdentity | undefined,
  recipient: AgeRecipient,
  counts: MigrateCounts,
): Promise<T> {
  // The ciphertext is longer than any image inside it, so short previews are skipped unopened.
  if (!identity || !row.preview || row.preview.length <= MAX_PREVIEW_IMAGE) return row
  const body = await openPreview(identity, row.preview)
  const items = await Promise.all(body.items.map((i) => fitPreviewImage(i, shrinkPreviewImage)))
  if (items.every((item, i) => item.image === body.items[i]!.image)) return row
  counts.previewsShrunk++
  return { ...row, preview: await sealPreview(recipient, { v: 1, items }) }
}

/** Re-wraps an open channel's key and re-seals its name for the new open key. */
async function rotateChannel(
  row: ChannelRow,
  oldKey: AgeIdentity,
  newRecipient: AgeRecipient,
  counts: MigrateCounts,
  identities: Map<string, AgeIdentity>,
): Promise<ChannelRow> {
  if (isOpenChannel(row)) {
    let identity: AgeIdentity
    try {
      identity = await unwrapWithIdentity(fromBase64(row.wrappedKey), oldKey)
    } catch {
      throw new CliError(
        `open channel ${row.id} can't be unwrapped with the old key; nothing finished`,
      )
    }
    if ((await recipientOf(identity)) !== row.recipient)
      throw new CliError(`open channel ${row.id} has a mismatched key; nothing finished`)
    const name = await openText(identity, row.name)
    identities.set(row.id, identity)
    counts.openRewrapped++
    return {
      ...row,
      wrappedKey: toBase64(await wrapForRecipient(identity, newRecipient)),
      name: await sealChannelName(row.recipient, newRecipient, name),
    }
  }
  // Locked: the passphrase-wrapped key is untouched. The name moves to the new open key if the
  // old one could read it.
  let name: string
  try {
    name = await openText(oldKey, row.name)
  } catch {
    counts.lockedNamesPending++
    return row
  }
  counts.lockedNamesShared++
  return { ...row, name: await sealChannelName(row.recipient, newRecipient, name) }
}

export async function migrate(
  io: Io,
  opts: { from: string; fromKeyFile: string; dryRun?: boolean },
): Promise<void> {
  const cfg = loadConfig(io)
  const from = opts.from.replace(/\/$/, "")
  if (from === cfg.server) throw new CliError("--from is the configured server; nothing to do")
  const oldPath = resolve(io.cwd, opts.fromKeyFile)
  if (!existsSync(oldPath)) throw new CliError(`old open key file not found: ${oldPath}`)
  const oldKey = parseIdentity(readFileSync(oldPath, "utf8"))
  const newKey = readOpenKey(io, cfg)
  if (!newKey)
    throw new CliError("no new open key: create one with `jot keygen -o <file>` and configure it")
  const newRecipient = await recipientOf(newKey)
  if (newRecipient === (await recipientOf(oldKey)))
    throw new CliError(
      "the new open key is the old one; create a new key with `jot keygen -o <file>`",
    )

  // The source is usually the local server: no Access headers go there.
  const source = new Api({ baseUrl: from })
  const target = new Api({ baseUrl: cfg.server, headers: accessHeaders(io) })
  if (!opts.dryRun) await target.restore({}) // fails with account_not_empty before any work

  const counts: MigrateCounts = {
    channels: 0,
    openRewrapped: 0,
    lockedNamesShared: 0,
    lockedNamesPending: 0,
    notes: 0,
    versions: 0,
    attachments: 0,
    missingAttachments: 0,
    previewsShrunk: 0,
  }
  const progress = (what: string) => io.err(`migrate: ${what}`)

  // Channels first, all of them, so a bad open channel stops the run before any note moves.
  const channels: ChannelRow[] = []
  const identities = new Map<string, AgeIdentity>() // open channels' keys, for their previews
  for await (const rows of pages(source, "channels")) {
    for (const row of rows)
      channels.push(await rotateChannel(row, oldKey, newRecipient, counts, identities))
  }
  const recipients = new Map(channels.map((c) => [c.id, c.recipient]))
  counts.channels = channels.length
  // Check the result before uploading: every open channel must open with the new key.
  for (const row of channels) {
    if (!isOpenChannel(row)) continue
    const identity = await unwrapWithIdentity(fromBase64(row.wrappedKey), newKey)
    if ((await recipientOf(identity)) !== row.recipient)
      throw new CliError("re-wrapped key check failed; nothing finished")
  }
  if (!opts.dryRun)
    for (const chunk of restoreChunks(channels)) await target.restore({ channels: chunk })
  progress(`${counts.channels} channels`)

  for await (const page of pages(source, "notes")) {
    const rows = []
    for (const row of page)
      rows.push(
        await fitPreviews(
          row,
          identities.get(row.channelId),
          recipients.get(row.channelId)!,
          counts,
        ),
      )
    if (!opts.dryRun)
      for (const chunk of restoreChunks(rows)) await target.restore({ notes: chunk })
    counts.notes += rows.length
  }
  progress(`${counts.notes} notes (${counts.previewsShrunk} link previews shrunk)`)
  for await (const rows of pages(source, "versions")) {
    if (!opts.dryRun)
      for (const chunk of restoreChunks(rows)) await target.restore({ versions: chunk })
    counts.versions += rows.length
  }
  progress(`${counts.versions} earlier versions`)

  const attachments: DumpRow<"attachments">[] = []
  for await (const rows of pages(source, "attachments")) attachments.push(...rows)
  let next = 0
  const worker = async () => {
    while (next < attachments.length) {
      const info = attachments[next++]!
      let bytes: Uint8Array
      try {
        bytes = await source.downloadAttachment(info.id)
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e
        counts.missingAttachments++
        continue
      }
      if (!opts.dryRun) await target.restoreAttachment(info, bytes)
      counts.attachments++
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  progress(`${counts.attachments} attachments`)

  if (!opts.dryRun) {
    await target.restoreFinish()
    // Verify: the target holds as many rows as the source.
    for (const [table, want] of [
      ["channels", counts.channels],
      ["notes", counts.notes],
      ["versions", counts.versions],
      ["attachments", counts.attachments],
    ] as const) {
      let got = 0
      for await (const rows of pages(target, table)) got += rows.length
      if (got !== want) throw new CliError(`verify failed: ${table} ${got} of ${want}`)
    }
  }

  const c = counts
  io.out(
    `${opts.dryRun ? "dry run: would migrate" : "migrated"} ${c.channels} channels ` +
      `(${c.openRewrapped} open re-wrapped to the new key), ${c.notes} notes, ` +
      `${c.versions} earlier versions, ${c.attachments} attachments; ` +
      `${c.previewsShrunk} link previews with a large image re-sealed with it shrunk`,
  )
  if (c.lockedNamesShared + c.lockedNamesPending)
    io.out(
      `locked channel names: ${c.lockedNamesShared} re-sealed to the new key, ` +
        `${c.lockedNamesPending} still hidden (unlock each once in the app to show its name)`,
    )
  if (c.missingAttachments)
    io.out(`warning: ${c.missingAttachments} attachments were missing on the source and skipped`)
}
