import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, extname, join, resolve } from "node:path"
import {
  type AttachmentRef,
  type ChannelRow,
  type ChannelView,
  fitPreviewImage,
  type ImportLine,
  isOpenChannel,
  MAX_ATTACHMENT_PLAIN_BYTES,
  MAX_PREVIEW_IMAGE,
  type NoteView,
  parseImportLine,
} from "@jot/core"
import { generateKeyPair } from "@jot/crypto"
import { CliError, type Context, type Io, writePrivate } from "./context.ts"
import { shrinkPreviewImage } from "./images.ts"

export interface OutputOpts {
  json?: boolean
}

/* ------------------------------ formatting ----------------------------- */

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** Local time for people; --json output keeps ISO-8601 UTC. */
function short(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function channelLabel(ctx: Context, id: string): Promise<string> {
  const row = ctx.nb.replica.channels.get(id)
  const name = row ? await ctx.nb.channelName(row) : null
  return name ?? `locked:${id}`
}

async function noteJson(ctx: Context, n: NoteView) {
  return {
    id: n.id,
    channel: await channelLabel(ctx, n.channelId),
    channelId: n.channelId,
    locked: n.locked,
    createdAt: iso(n.createdAt),
    updatedAt: iso(n.updatedAt),
    version: n.version,
    text: n.text,
    links: n.links,
    previews: n.previews.map(({ image: _image, ...p }) => p),
    attachments: n.attachments,
  }
}

async function printNotes(ctx: Context, notes: NoteView[], o: OutputOpts): Promise<void> {
  if (o.json) {
    ctx.io.out(JSON.stringify(await Promise.all(notes.map((n) => noteJson(ctx, n))), null, 2))
    return
  }
  for (const n of [...notes].reverse()) {
    const firstLine = n.text.split("\n")[0] ?? ""
    const extra = n.text.includes("\n") ? " …" : ""
    const title = n.previews[0]?.title ? `  [${n.previews[0].title}]` : ""
    ctx.io.out(
      `${short(n.createdAt)}  ${n.id}  #${await channelLabel(ctx, n.channelId)}  ${firstLine}${extra}${title}`,
    )
  }
}

async function resolveChannel(ctx: Context, ref: string | undefined): Promise<ChannelRow> {
  const r = ref ?? ctx.cfg.defaultChannel
  if (!r) throw new CliError("no channel given (-c <name|id>) and no defaultChannel configured")
  const row = await ctx.nb.findChannel(r)
  // Fail closed: never create or guess a channel.
  if (!row) throw new CliError(`no such channel: ${r} (locked channels can be addressed by id)`)
  return row
}

/* ------------------------------- commands ------------------------------ */

export async function keygen(io: Io, out: string | undefined): Promise<void> {
  const kp = await generateKeyPair()
  const text = `# jot open key (hybrid ML-KEM-768 + X25519 age identity)\n# public key: ${kp.recipient}\n${kp.identity}\n`
  if (!out) {
    if (io.stdinIsTty) io.err("warning: printing a secret key to the terminal")
    io.out(text.trimEnd())
    return
  }
  const path = resolve(io.cwd, out)
  if (existsSync(path)) throw new CliError(`refusing to overwrite ${path}`)
  writePrivate(path, text)
  io.err(`wrote ${path}`)
}

export async function channels(ctx: Context, o: OutputOpts): Promise<void> {
  const views = await ctx.nb.channelViews()
  if (o.json) {
    ctx.io.out(JSON.stringify(views, null, 2))
    return
  }
  for (const v of views) ctx.io.out(fmtChannel(v))
}

function fmtChannel(v: ChannelView): string {
  const name = v.name ?? "(locked)"
  const kind = v.lock === "open" ? "open  " : v.unlocked ? "locked (unlocked)" : "locked"
  return `${v.id}  ${kind.padEnd(17)}  ${String(v.noteCount).padStart(5)}  ${name}`
}

export async function createChannel(
  ctx: Context,
  name: string,
  opts: { locked?: boolean },
  passphrase?: string,
): Promise<void> {
  if (opts.locked) {
    if (!passphrase) throw new CliError("a locked channel needs a passphrase on stdin")
    const row = await ctx.nb.createChannel({ name, lock: "locked", passphrase })
    ctx.io.out(row.id)
    return
  }
  if (!ctx.nb.keys.hasOpenKey) throw new CliError("open channels need the open key")
  const row = await ctx.nb.createChannel({ name, lock: "open" })
  ctx.io.out(row.id)
}

const MIME: Record<string, string> = {
  ".gif": "image/gif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

/** A file's type from its extension; anything unknown is a plain download. */
export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream"
}

export async function add(
  ctx: Context,
  text: string,
  opts: { channel?: string; preview?: boolean; json?: boolean; file?: string[] },
): Promise<void> {
  const files = (opts.file ?? []).map((f) => resolve(ctx.io.cwd, f))
  if (!text.trim() && !files.length) throw new CliError("empty note")
  // Check every file before anything is uploaded.
  for (const f of files) {
    if (!existsSync(f) || !statSync(f).isFile()) throw new CliError(`not a file: ${basename(f)}`)
    if (statSync(f).size > MAX_ATTACHMENT_PLAIN_BYTES)
      throw new CliError(
        `${basename(f)} is too large (${Math.floor(MAX_ATTACHMENT_PLAIN_BYTES / 2 ** 20)} MB max)`,
      )
  }
  const ch = await resolveChannel(ctx, opts.channel)
  const open = isOpenChannel(ch)
  const attachments: AttachmentRef[] = []
  for (const f of files)
    attachments.push(
      await ctx.nb.addAttachment(ch.id, readFileSync(f), mimeFor(f), { name: basename(f) }),
    )
  const note = await ctx.nb.addNote(ch.id, text, { attachments })
  // Previews: on by default for open channels, only on request for locked ones.
  const wantPreview = opts.preview ?? open
  if (wantPreview && note.links.length && (open || ctx.nb.keys.isUnlocked(ch.id) || opts.preview)) {
    const items = await ctx.nb.fetchPreviews(note.links)
    if (items.length) await ctx.nb.setPreviews(note.id, items)
  }
  const pending = await ctx.nb.pendingCount()
  if (pending) throw new CliError("the server did not accept the note")
  ctx.io.out(opts.json ? JSON.stringify({ id: note.id, channelId: ch.id }) : note.id)
}

export async function list(
  ctx: Context,
  opts: OutputOpts & { channel?: string; limit?: string },
): Promise<void> {
  const ch = opts.channel ? await resolveChannel(ctx, opts.channel) : undefined
  if (ch && !(await ctx.nb.keys.identityFor(ch)))
    throw new CliError("channel is locked; use `jot unlock <channel> list ...`")
  const notes = await ctx.nb.notes(ch?.id, { limit: Number(opts.limit ?? 20) })
  await printNotes(ctx, notes, opts)
}

export async function searchCmd(
  ctx: Context,
  query: string,
  opts: OutputOpts & { channel?: string; limit?: string },
) {
  const ch = opts.channel ? await resolveChannel(ctx, opts.channel) : undefined
  const results = (await ctx.nb.search(query, ch?.id)).slice(0, Number(opts.limit ?? 50))
  await printNotes(ctx, results, opts)
}

export async function read(
  ctx: Context,
  id: string,
  opts: OutputOpts & { history?: boolean },
): Promise<void> {
  const row = ctx.nb.replica.notes.get(id.toUpperCase())
  if (!row || row.deletedAt !== null) throw new CliError("no such note")
  const view = await ctx.nb.noteView(row)
  if (!view) throw new CliError("note is in a locked channel; use `jot unlock <channel> read <id>`")
  const history = opts.history ? await ctx.nb.history(view.id) : undefined
  if (opts.json) {
    ctx.io.out(
      JSON.stringify({ ...(await noteJson(ctx, view)), ...(history ? { history } : {}) }, null, 2),
    )
    return
  }
  ctx.io.out(
    `# ${view.id}  #${await channelLabel(ctx, view.channelId)}  ${iso(view.createdAt)}  v${view.version}`,
  )
  for (const p of view.previews)
    ctx.io.out(`# preview: ${p.title ?? ""} — ${p.site ?? ""} <${p.url}>`)
  for (const a of view.attachments) ctx.io.out(`# attachment: ${a.id} ${a.mime} ${a.name ?? ""}`)
  ctx.io.out("")
  ctx.io.out(view.text)
  for (const h of history ?? []) ctx.io.out(`\n--- v${h.version} (${iso(h.createdAt)})\n${h.text}`)
}

/** A safe local file name from an attachment's stored name. */
function localName(name: string | undefined, id: string): string {
  const clean = [...basename(name ?? "")]
    .map((ch) => (ch < " " || ch === "/" || ch === "\\" ? "_" : ch))
    .join("")
    .replace(/^\.+/, "")
  return clean || id
}

/**
 * Saves a note's attachments into a directory. Open channels only: like `mirror` and `export`,
 * the CLI never writes locked plaintext to disk. Never overwrites; adds " (2)" and so on.
 */
export async function files(
  ctx: Context,
  id: string,
  opts: OutputOpts & { out?: string },
): Promise<void> {
  const row = ctx.nb.replica.notes.get(id.toUpperCase())
  if (!row || row.deletedAt !== null) throw new CliError("no such note")
  const ch = ctx.nb.replica.channels.get(row.channelId)
  if (!ch || !isOpenChannel(ch))
    throw new CliError("note is in a locked channel; the CLI never writes locked files to disk")
  const view = await ctx.nb.noteView(row)
  if (!view) throw new CliError("cannot read that note")
  const dir = resolve(ctx.io.cwd, opts.out ?? ".")
  const saved: { id: string; path: string; size: number }[] = []
  for (const a of view.attachments) {
    const name = localName(a.name, a.id)
    const ext = extname(name)
    let path = join(dir, name)
    for (let i = 2; existsSync(path); i++)
      path = join(dir, `${name.slice(0, name.length - ext.length)} (${i})${ext}`)
    const data = await ctx.nb.readAttachment(row.channelId, a)
    writePrivate(path, data)
    saved.push({ id: a.id, path, size: data.length })
  }
  if (opts.json) ctx.io.out(JSON.stringify(saved))
  else if (!saved.length) ctx.io.err("no attachments")
  else for (const s of saved) ctx.io.out(s.path)
}

export async function edit(ctx: Context, id: string, text: string): Promise<void> {
  await ctx.nb.editNote(id.toUpperCase(), text)
  await assertFlushed(ctx)
}

export async function move(ctx: Context, id: string, channel: string): Promise<void> {
  const to = await resolveChannel(ctx, channel)
  await ctx.nb.moveNote(id.toUpperCase(), to.id)
  await assertFlushed(ctx)
}

export async function remove(ctx: Context, id: string): Promise<void> {
  await ctx.nb.deleteNote(id.toUpperCase())
  await assertFlushed(ctx)
}

async function assertFlushed(ctx: Context): Promise<void> {
  if (await ctx.nb.pendingCount()) throw new CliError("the server did not accept the change")
}

/* -------------------------------- import ------------------------------- */

export async function importJsonl(
  ctx: Context,
  file: string,
  opts: { dryRun?: boolean; previews?: boolean },
): Promise<void> {
  const previews = opts.previews ?? true
  const path = resolve(ctx.io.cwd, file)
  const base = dirname(path)
  const lines = readFileSync(path, "utf8").split(/\r?\n/)
  const parsed: { line: number; item: ImportLine; channel: ChannelRow }[] = []
  const errors: string[] = []
  const channelCache = new Map<string, ChannelRow | undefined>()
  // Validate everything first; write nothing unless the whole file is valid.
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim()
    if (!raw) continue
    let item: ImportLine
    try {
      item = parseImportLine(raw)
    } catch {
      errors.push(`line ${i + 1}: invalid record`) // never echo content
      continue
    }
    if (!channelCache.has(item.channel))
      channelCache.set(item.channel, await ctx.nb.findChannel(item.channel))
    const channel = channelCache.get(item.channel)
    if (!channel) {
      errors.push(`line ${i + 1}: unknown channel (create it first; import never creates channels)`)
      continue
    }
    for (const a of item.attachments ?? []) {
      if (!existsSync(resolve(base, a.path)))
        errors.push(`line ${i + 1}: attachment file not found`)
    }
    parsed.push({ line: i + 1, item, channel })
  }
  if (errors.length) throw new CliError(`import aborted, nothing written:\n${errors.join("\n")}`)
  if (opts.dryRun) {
    ctx.io.out(`ok: ${parsed.length} notes would be imported`)
    return
  }
  let created = 0
  let duplicates = 0
  const toPreview: { id: string; links: string[] }[] = []
  for (const { item, channel } of parsed) {
    const before = ctx.nb.replica.notes.size
    const attachments: AttachmentRef[] = []
    for (const a of item.attachments ?? []) {
      const p = resolve(base, a.path)
      attachments.push(
        await ctx.nb.addAttachment(channel.id, readFileSync(p), a.mime, {
          name: p.split("/").pop(),
        }),
      )
    }
    const note = await ctx.nb.addNote(channel.id, item.text, {
      createdAt: Date.parse(item.created_at),
      sourceId: item.source_id,
      links: item.links ?? [],
      attachments,
    })
    if (await ctx.nb.pendingCount())
      throw new CliError(`import stopped: the server did not accept a note (${created} imported)`)
    const duplicate = ctx.nb.replica.notes.size === before
    if (duplicate) duplicates++
    else created++
    // Previews: open channels only (locked channels never unfurl on import).
    if (!duplicate && previews && isOpenChannel(channel) && note.links.length)
      toPreview.push({ id: note.id, links: note.links })
  }
  ctx.io.out(`imported ${created}, skipped ${duplicates} already present`)
  if (toPreview.length) {
    const r = await fillPreviews(ctx, toPreview)
    ctx.io.out(`previews: ${r.found} of ${r.checked} notes with links`)
  }
}

/* ------------------------------- previews ------------------------------ */

const PREVIEW_CONCURRENCY = 4

/**
 * Runs `update` on the given notes, a few at a time, then uploads the results. `update` returns
 * whether it changed the note. Progress goes to stderr as counts only.
 */
async function updatePreviews<T>(
  ctx: Context,
  notes: T[],
  update: (n: T) => Promise<boolean>,
  progressEvery = 50,
): Promise<{ checked: number; found: number }> {
  let next = 0
  let checked = 0
  let found = 0
  const worker = async () => {
    while (next < notes.length) {
      if (await update(notes[next++]!)) found++
      if (++checked % progressEvery === 0) {
        ctx.save()
        ctx.io.err(`previews: ${checked}/${notes.length} checked, ${found} updated`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PREVIEW_CONCURRENCY, notes.length) }, worker))
  await ctx.nb.flush()
  if ((await ctx.nb.pendingCount()) > 0)
    throw new CliError("some previews were not uploaded; run `jot previews` again")
  return { checked, found }
}

/** Fetches and stores link previews. Best effort: a link that fails is skipped. */
function fillPreviews(ctx: Context, notes: Pick<NoteView, "id" | "links">[]) {
  return updatePreviews(ctx, notes, async (n) => {
    const items = await ctx.nb.fetchPreviews(n.links)
    if (items.length) await ctx.nb.setPreviews(n.id, items)
    return items.length > 0
  })
}

const hasLargeImage = (n: NoteView) =>
  n.previews.some((p) => (p.image?.length ?? 0) > MAX_PREVIEW_IMAGE)

/** Re-seals stored previews with their large images shrunk (ADR-0020). Fetches nothing. */
function shrinkPreviews(ctx: Context, notes: NoteView[]) {
  return updatePreviews(ctx, notes, async (n) => {
    const items = await Promise.all(n.previews.map((p) => fitPreviewImage(p, shrinkPreviewImage)))
    await ctx.nb.setPreviews(n.id, items)
    return true
  })
}

/**
 * `jot previews`: backfills link previews. Without -c it covers every open channel.
 * A locked channel needs an explicit -c, --locked and `jot unlock` (previews send
 * the links to the server's unfurl endpoint, so locked channels are opt-in only).
 * With --shrink it fetches nothing: it re-seals stored previews whose images are too large, and
 * a locked channel only needs `jot unlock`.
 */
export async function previewsCmd(
  ctx: Context,
  opts: {
    channel?: string
    locked?: boolean
    refresh?: boolean
    shrink?: boolean
    limit?: string
    json?: boolean
  },
): Promise<void> {
  if (opts.shrink && opts.refresh) throw new CliError("--shrink and --refresh don't go together")
  let channels: ChannelRow[]
  if (opts.channel) {
    const ch = await resolveChannel(ctx, opts.channel)
    if (!isOpenChannel(ch)) {
      if (!opts.locked && !opts.shrink)
        throw new CliError(
          "locked channel: previews send its links to the unfurl endpoint; pass --locked to opt in",
        )
      if (!ctx.nb.keys.isUnlocked(ch.id))
        throw new CliError("locked channel: run it under `jot unlock <channel> previews ...`")
    }
    channels = [ch]
  } else {
    if (opts.locked) throw new CliError("--locked needs -c <locked channel>")
    channels = [...ctx.nb.replica.channels.values()].filter(
      (c) => c.deletedAt === null && isOpenChannel(c),
    )
  }
  const limit = opts.limit === undefined ? Infinity : Number(opts.limit)
  if (!(limit > 0)) throw new CliError("--limit must be a positive number")
  const wanted = opts.shrink
    ? hasLargeImage
    : (n: NoteView) => n.links.length > 0 && (opts.refresh || !n.previews.length)
  const todo: NoteView[] = []
  for (const ch of channels)
    for (const n of await ctx.nb.notes(ch.id)) if (!n.pending && wanted(n)) todo.push(n)
  const batch = todo.slice(0, limit)
  const run = opts.shrink ? shrinkPreviews : fillPreviews
  const r = batch.length ? await run(ctx, batch) : { checked: 0, found: 0 }
  const left = todo.length - batch.length
  const more = left ? `; ${left} left` : ""
  if (opts.json) ctx.io.out(JSON.stringify({ ...r, remaining: left }))
  else if (opts.shrink) ctx.io.out(`previews: shrank images in ${r.found} notes${more}`)
  else ctx.io.out(`previews: ${r.found} of ${r.checked} notes with links${more}`)
}
