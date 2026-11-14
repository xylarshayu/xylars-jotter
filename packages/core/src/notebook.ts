/**
 * The notebook: one replica, one key ring, one API. Shared by the web app and the CLI.
 *
 * Writes go through an outbox so the web app can capture offline. Everything
 * the outbox holds is already ciphertext.
 */
import {
  type AgeIdentity,
  decryptWith,
  encryptTo,
  fromBase64,
  sha256Hex,
  toBase64,
  wrapWithPassphrase,
} from "@jot/crypto"
import { type Api, ApiError } from "./api.ts"
import {
  extractLinks,
  newChannel,
  openNoteBody,
  openPreview,
  openText,
  sealNoteBody,
  sealPreview,
  sealChannelName,
  type NewChannelOptions,
} from "./codec.ts"
import { newId } from "./ids.ts"
import { isOpenChannel, KeyRing, LockedError } from "./keyring.ts"
import type {
  AttachmentRef,
  ChannelRow,
  CreateNote,
  LockKind,
  NoteBody,
  NoteRow,
  PreviewItem,
  UpdateNote,
} from "./model.ts"
import { MAX_ATTACHMENT_PLAIN_BYTES } from "./model.ts"
import { fitPreviewImage, type ImageShrinker } from "./previews.ts"
import { PENDING_SEQ, Replica } from "./replica.ts"
import { search } from "./search.ts"

export type OutboxOp =
  | { kind: "createNote"; req: CreateNote }
  | { kind: "updateNote"; id: string; req: UpdateNote }
  | { kind: "updatePreview"; id: string; preview: string | null }
  | { kind: "deleteNote"; id: string }
  /** `data` is the ciphertext; older outboxes stored it as base64. */
  | { kind: "uploadAttachment"; id: string; channelId: string; data: Uint8Array | string }

const bytesOf = (d: Uint8Array | string): Uint8Array => (typeof d === "string" ? fromBase64(d) : d)

export interface OutboxEntry {
  key: string
  op: OutboxOp
}

/** Persistence hook for pending writes. Default keeps them in memory. */
export interface OutboxStore {
  load(): Promise<OutboxEntry[]>
  put(entry: OutboxEntry): Promise<void>
  remove(key: string): Promise<void>
}

export class MemoryOutbox implements OutboxStore {
  #items = new Map<string, OutboxEntry>()
  async load() {
    return [...this.#items.values()]
  }
  async put(e: OutboxEntry) {
    this.#items.set(e.key, e)
  }
  async remove(key: string) {
    this.#items.delete(key)
  }
}

export interface ChannelView {
  id: string
  lock: LockKind
  /** The channel key is in memory (open channel, or locked and unlocked). */
  readable: boolean
  unlocked: boolean
  /**
   * Decrypted name. Locked channels' names are sealed to the open key too (ADR-0014); null only
   * for a locked channel whose name was sealed before that and that hasn't been unlocked since.
   */
  name: string | null
  createdAt: number
  noteCount: number
}

export interface NoteView {
  id: string
  channelId: string
  version: number
  createdAt: number
  updatedAt: number
  text: string
  links: string[]
  attachments: AttachmentRef[]
  previews: PreviewItem[]
  pending: boolean
  /** True if the note lives in a locked channel (never persist or mirror its plaintext). */
  locked: boolean
}

/** Decrypted note, cached by version. Exportable for open channels only. */
/** First-sync progress: notes received so far, of about `total`. */
export interface SyncProgress {
  received: number
  total: number
}

export interface PlainEntry {
  id: string
  version: number
  channelId: string
  body: NoteBody
  /** Fingerprint of the preview ciphertext the previews were decrypted from. */
  previewFp: string | null
  previews: PreviewItem[]
}

type Cached = Omit<PlainEntry, "id">

/** Cheap identity for a ciphertext: age files end in a random-keyed tag, so collisions don't happen in practice. */
const fp = (b64: string | null) => (b64 === null ? null : `${b64.length}:${b64.slice(-48)}`)

export interface NotebookOptions {
  api: Api
  replica?: Replica
  keys?: KeyRing
  outbox?: OutboxStore
  /** Called after the replica changes (sync, local writes). */
  onChange?: () => void
  /** Re-encodes large link preview images (ADR-0020). Without one, they are dropped. */
  shrinkImage?: ImageShrinker
}

export interface AddNoteOptions {
  links?: string[]
  attachments?: AttachmentRef[]
  createdAt?: number
  /** Import idempotency key. Only its SHA-256 is sent to the server. */
  sourceId?: string
  previews?: PreviewItem[]
}

export class Notebook {
  readonly api: Api
  readonly replica: Replica
  readonly keys: KeyRing
  readonly outbox: OutboxStore
  #cache = new Map<string, Cached>()
  #names = new Map<string, { b64: string; name: string }>()
  /** "<open recipient>|<name ciphertext>" pairs the open key can't read (not shared yet). */
  #unshared = new Set<string>()
  #onChange: (() => void) | undefined
  #shrinkImage: ImageShrinker | undefined
  #flushing: Promise<FlushResult> | undefined

  constructor(opts: NotebookOptions) {
    this.api = opts.api
    this.replica = opts.replica ?? new Replica()
    this.keys = opts.keys ?? new KeyRing()
    this.outbox = opts.outbox ?? new MemoryOutbox()
    this.#onChange = opts.onChange
    this.#shrinkImage = opts.shrinkImage
    this.keys.onChange((channelId) => this.#forget(channelId))
  }

  /** Drops decrypted plaintext of locked channels once they are locked again. */
  #forget(channelId: string | null): void {
    const stale = (chId: string) => {
      if (channelId !== null && chId !== channelId) return false
      const row = this.replica.channels.get(chId)
      return !row || (!isOpenChannel(row) && !this.keys.isUnlocked(chId))
    }
    for (const [id, c] of this.#cache) if (stale(c.channelId)) this.#cache.delete(id)
    for (const id of [...this.#names.keys()]) if (stale(id)) this.#names.delete(id)
    this.#changed()
  }

  #changed(): void {
    this.#onChange?.()
  }

  /* ------------------------------ sync ------------------------------ */

  /**
   * Pulls every change since the cursor. With `onProgress`, the first page also asks how many
   * notes are coming, and each page reports how many have arrived.
   */
  async sync(
    opts: { onProgress?: (p: SyncProgress) => void } = {},
  ): Promise<{ channels: number; notes: number }> {
    let channels = 0
    let notes = 0
    let total: number | undefined
    let received = 0
    for (;;) {
      const page = await this.api.sync(this.replica.cursor, {
        count: !!opts.onProgress && total === undefined,
      })
      total ??= page.remaining
      received += page.notes.length
      const changed = this.replica.apply(page)
      channels += changed.channels.length
      notes += changed.notes.length
      this.replica.cursor = page.cursor
      opts.onProgress?.({ received, total: Math.max(total ?? 0, received) })
      if (!page.more) break
    }
    if (channels + notes > 0) this.#changed()
    return { channels, notes }
  }

  /* ---------------------------- channels ---------------------------- */

  channel(id: string): ChannelRow {
    const row = this.replica.channels.get(id)
    if (!row || row.deletedAt !== null) throw new Error("unknown channel")
    return row
  }

  async channelName(row: ChannelRow): Promise<string | null> {
    const hit = this.#names.get(row.id)
    if (hit && hit.b64 === row.name) return hit.name
    let name = await this.#openKeyName(row)
    if (name === null) {
      const identity = await this.keys.identityFor(row)
      if (!identity) return null
      try {
        name = await openText(identity, row.name)
      } catch {
        return null
      }
    }
    this.#names.set(row.id, { b64: row.name, name })
    return name
  }

  /** The channel name if it is sealed to the open key, else null. */
  async #openKeyName(row: ChannelRow): Promise<string | null> {
    const key = this.keys.openIdentity
    if (!key) return null
    const tag = `${this.keys.openRecipient}|${row.name}`
    if (this.#unshared.has(tag)) return null
    try {
      return await openText(key, row.name)
    } catch {
      this.#unshared.add(tag)
      return null
    }
  }

  /**
   * After an unlock: if the locked channel's name isn't sealed to the open key yet, re-seal it
   * to both, so devices and agents with the open key can show it (ADR-0014). Best effort.
   */
  async #shareName(id: string): Promise<void> {
    const row = this.replica.channels.get(id)
    const open = this.keys.openRecipient
    if (!row || row.deletedAt !== null || !open || isOpenChannel(row)) return
    if ((await this.#openKeyName(row)) !== null) return
    const identity = await this.keys.identityFor(row)
    if (!identity) return
    try {
      const name = await openText(identity, row.name)
      const updated = await this.api.updateChannel(id, {
        name: await sealChannelName(row.recipient, open, name),
      })
      this.replica.apply({ channels: [updated], notes: [] })
      this.#changed()
    } catch {
      /* offline or unreadable: tried again on the next unlock */
    }
  }

  async channelViews(): Promise<ChannelView[]> {
    const counts = new Map<string, number>()
    for (const n of this.replica.notes.values()) {
      if (n.deletedAt === null) counts.set(n.channelId, (counts.get(n.channelId) ?? 0) + 1)
    }
    const out: ChannelView[] = []
    for (const row of this.replica.channels.values()) {
      if (row.deletedAt !== null) continue
      const identity = await this.keys.identityFor(row)
      out.push({
        id: row.id,
        lock: isOpenChannel(row) ? "open" : "locked",
        readable: identity !== undefined,
        unlocked: this.keys.isUnlocked(row.id),
        name: await this.channelName(row),
        createdAt: row.createdAt,
        noteCount: counts.get(row.id) ?? 0,
      })
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Finds a channel by id, or by exact (case-insensitive) decrypted name among readable channels. */
  async findChannel(ref: string): Promise<ChannelRow | undefined> {
    const r = ref.replace(/^#/, "")
    const byId = this.replica.channels.get(r.toUpperCase())
    if (byId && byId.deletedAt === null) return byId
    const matches: ChannelRow[] = []
    for (const row of this.replica.channels.values()) {
      if (row.deletedAt !== null) continue
      const name = await this.channelName(row)
      if (name !== null && name.toLowerCase() === r.toLowerCase()) matches.push(row)
    }
    if (matches.length > 1) throw new Error(`channel name "${ref}" is ambiguous; use its id`)
    return matches[0]
  }

  async createChannel(opts: Omit<NewChannelOptions, "openRecipient">): Promise<ChannelRow> {
    const { request } = await newChannel({ ...opts, openRecipient: this.keys.openRecipient })
    const row = await this.api.createChannel(request)
    this.replica.apply({ channels: [row], notes: [] })
    this.#changed()
    return row
  }

  async renameChannel(id: string, name: string): Promise<void> {
    const row = this.channel(id)
    // Renaming needs only public keys; ask for a readable channel or the open key so the user
    // can see what they rename. With the open key, a locked channel can be renamed while locked.
    const open = this.keys.openRecipient
    if (!open && !(await this.keys.identityFor(row))) throw new LockedError()
    const updated = await this.api.updateChannel(id, {
      name: await sealChannelName(row.recipient, open, name),
    })
    this.replica.apply({ channels: [updated], notes: [] })
    this.#changed()
  }

  /**
   * Re-wraps a locked channel's key with a new passphrase. Both passphrases are dropped after use.
   * `scryptLogN` defaults to age's work factor; tests lower it, as with createChannel.
   */
  async changePassphrase(
    id: string,
    oldPassphrase: string,
    newPassphrase: string,
    scryptLogN?: number,
  ): Promise<void> {
    const row = this.channel(id)
    if (isOpenChannel(row)) throw new Error("open channels have no passphrase")
    const scratch = new KeyRing()
    await scratch.unlock(row, oldPassphrase)
    const identity = await scratch.identityFor(row)
    if (!identity) throw new LockedError()
    const wrapped = await wrapWithPassphrase(identity, newPassphrase, scryptLogN)
    const updated = await this.api.updateChannel(id, { wrappedKey: toBase64(wrapped) })
    this.replica.apply({ channels: [updated], notes: [] })
    this.#changed()
  }

  async deleteChannel(id: string): Promise<void> {
    const row = await this.api.deleteChannel(id)
    this.replica.apply({ channels: [row], notes: [] })
    this.#changed()
  }

  async unlock(channelId: string, passphrase: string): Promise<void> {
    await this.keys.unlock(this.channel(channelId), passphrase)
    await this.#shareName(channelId)
  }

  /** Tries a passphrase against every locked channel. Returns the ids it unlocked. */
  async unlockAny(passphrase: string): Promise<string[]> {
    const ok: string[] = []
    for (const row of this.replica.channels.values()) {
      if (row.deletedAt !== null || isOpenChannel(row) || this.keys.isUnlocked(row.id)) continue
      try {
        await this.keys.unlock(row, passphrase)
        ok.push(row.id)
        await this.#shareName(row.id)
      } catch {
        /* not this one */
      }
    }
    return ok
  }

  /* ------------------------------ notes ----------------------------- */

  async #identity(channelId: string): Promise<AgeIdentity> {
    const identity = await this.keys.identityFor(this.channel(channelId))
    if (!identity) throw new LockedError()
    return identity
  }

  /** Decrypts a note row, or returns null if its channel is not readable. */
  async noteView(row: NoteRow): Promise<NoteView | null> {
    if (row.deletedAt !== null) return null
    const channel = this.replica.channels.get(row.channelId)
    if (!channel || channel.deletedAt !== null) return null
    const identity = await this.keys.identityFor(channel)
    if (!identity) return null
    let c = this.#cache.get(row.id)
    if (!c || c.version !== row.version || c.channelId !== row.channelId) {
      try {
        c = {
          version: row.version,
          channelId: row.channelId,
          body: await openNoteBody(identity, row.body),
          previewFp: null,
          previews: [],
        }
      } catch {
        return null
      }
      this.#cache.set(row.id, c)
    }
    if (c.previewFp !== fp(row.preview)) {
      c.previewFp = fp(row.preview)
      c.previews = []
      if (row.preview) {
        try {
          c.previews = (await openPreview(identity, row.preview)).items
        } catch {
          /* ignore a bad preview */
        }
      }
    }
    return {
      id: row.id,
      channelId: row.channelId,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      text: c.body.text,
      links: c.body.links,
      attachments: c.body.attachments,
      previews: c.previews,
      pending: row.seq === PENDING_SEQ,
      locked: !isOpenChannel(channel),
    }
  }

  /**
   * Readable notes, newest first. With a channel id: that channel. Without:
   * every open channel (the "all open" feed; locked channels never mix in).
   * Rows are sorted before decryption, so `offset` and `limit` keep big feeds cheap. `skip`
   * leaves channels out of the all-channels feed.
   */
  async notes(
    channelId?: string,
    opts: { limit?: number; offset?: number; before?: number; skip?: ReadonlySet<string> } = {},
  ): Promise<NoteView[]> {
    const rows = this.#feedRows(channelId, opts.before, opts.skip).slice(opts.offset ?? 0)
    const out: NoteView[] = []
    for (const row of rows) {
      if (opts.limit !== undefined && out.length >= opts.limit) break
      const v = await this.noteView(row)
      if (v) out.push(v)
    }
    return out
  }

  /** Where a note sits in `notes(channelId)` (an `offset` that starts at it), or -1. */
  notePosition(noteId: string, channelId?: string): number {
    return this.#feedRows(channelId).findIndex((r) => r.id === noteId)
  }

  /** The rows `notes()` reads, in its order: newest first, ties broken by id. */
  #feedRows(channelId?: string, before?: number, skip?: ReadonlySet<string>): NoteRow[] {
    const rows: NoteRow[] = []
    for (const row of this.replica.notes.values()) {
      if (row.deletedAt !== null) continue
      if (channelId !== undefined && row.channelId !== channelId) continue
      if (skip?.has(row.channelId)) continue
      if (before !== undefined && row.createdAt >= before) continue
      if (channelId === undefined) {
        const ch = this.replica.channels.get(row.channelId)
        if (!ch || !isOpenChannel(ch)) continue
      }
      rows.push(row)
    }
    return rows.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
  }

  /**
   * Decrypted open-channel notes, for a local plaintext cache. Never includes locked
   * channels, and only live notes at their current version (deleted or edited text
   * doesn't linger on disk).
   */
  exportPlainCache(): PlainEntry[] {
    const out: PlainEntry[] = []
    for (const [id, c] of this.#cache) {
      const row = this.replica.notes.get(id)
      const ch = this.replica.channels.get(c.channelId)
      if (
        !row ||
        row.deletedAt !== null ||
        row.version !== c.version ||
        row.channelId !== c.channelId
      )
        continue
      if (ch && isOpenChannel(ch)) out.push({ id, ...c })
    }
    return out
  }

  /** Loads a plaintext cache. Entries are used only while they match the row's version and an open channel. */
  importPlainCache(entries: PlainEntry[]): void {
    for (const { id, ...c } of entries) {
      const ch = this.replica.channels.get(c.channelId)
      if (ch && isOpenChannel(ch)) this.#cache.set(id, c)
    }
  }

  /** Searches every readable note: open channels plus unlocked locked channels. */
  async search(query: string, channelId?: string): Promise<NoteView[]> {
    const views: (NoteView & { text: string; raw: string })[] = []
    for (const row of this.replica.notes.values()) {
      if (channelId !== undefined && row.channelId !== channelId) continue
      const v = await this.noteView(row)
      if (!v) continue
      const hay = [
        v.text,
        ...v.links,
        ...v.attachments.map((a) => a.name ?? ""),
        ...v.previews.flatMap((p) => [p.title ?? "", p.description ?? "", p.site ?? "", p.url]),
      ].join("\n")
      views.push({ ...v, raw: v.text, text: hay })
    }
    return search(views, query).map(({ raw, ...v }) => ({ ...v, text: raw }))
  }

  async addNote(channelId: string, text: string, opts: AddNoteOptions = {}): Promise<NoteView> {
    const channel = this.channel(channelId)
    const links = [...new Set([...extractLinks(text), ...(opts.links ?? [])])]
    const body: NoteBody = { v: 1, text, links, attachments: opts.attachments ?? [] }
    const now = Date.now()
    const req: CreateNote = {
      id: newId(opts.createdAt ?? now),
      channelId,
      body: await sealNoteBody(channel.recipient, body),
      createdAt: opts.createdAt ?? now,
    }
    if (opts.previews?.length)
      req.preview = await sealPreview(channel.recipient, { v: 1, items: opts.previews })
    if (opts.sourceId !== undefined)
      req.sourceHash = await sha256Hex("jot-source:v1:" + opts.sourceId)
    const optimistic: NoteRow = {
      id: req.id,
      channelId,
      version: 1,
      body: req.body,
      preview: req.preview ?? null,
      size: fromBase64(req.body).length,
      createdAt: req.createdAt!,
      updatedAt: now,
      deletedAt: null,
      seq: PENDING_SEQ,
    }
    this.replica.putPending(optimistic)
    const readable = (await this.keys.identityFor(channel)) !== undefined
    if (readable)
      this.#cache.set(req.id, {
        version: 1,
        channelId,
        body,
        previewFp: fp(optimistic.preview),
        previews: opts.previews ?? [],
      })
    this.#changed()
    await this.#enqueue({ kind: "createNote", req })
    // Append-without-unlock: a note in a locked channel is encrypted to the
    // channel's public recipient and can't be read back while locked.
    const view = (readable ? await this.noteView(optimistic) : null) ?? {
      id: req.id,
      channelId,
      version: 1,
      createdAt: optimistic.createdAt,
      updatedAt: now,
      text: "",
      links: [],
      attachments: [],
      previews: [],
      pending: true,
      locked: true,
    }
    return view
  }

  async editNote(id: string, text: string): Promise<void> {
    const row = this.#note(id)
    const view = await this.noteView(row)
    if (!view) throw new LockedError()
    const channel = this.channel(row.channelId)
    const links = [...new Set(extractLinks(text))]
    const body: NoteBody = { v: 1, text, links, attachments: view.attachments }
    const req: UpdateNote = {
      baseVersion: row.version,
      body: await sealNoteBody(channel.recipient, body),
    }
    this.#applyLocalUpdate(row, req, body)
    await this.#enqueue({ kind: "updateNote", id, req })
  }

  /**
   * Moves a note by re-encrypting it to the target channel. Moving into a
   * locked channel purges history and preview so no older copy stays readable
   * with the open key.
   */
  async moveNote(id: string, toChannelId: string): Promise<void> {
    const row = this.#note(id)
    if (row.channelId === toChannelId) return
    const view = await this.noteView(row)
    if (!view) throw new LockedError()
    const target = this.channel(toChannelId)
    const intoLocked = !isOpenChannel(target)
    const attachments: AttachmentRef[] = []
    for (const a of view.attachments) {
      const data = await this.readAttachment(row.channelId, a)
      attachments.push(
        await this.addAttachment(toChannelId, data, a.mime, {
          name: a.name,
          width: a.width,
          height: a.height,
        }),
      )
    }
    const body: NoteBody = { v: 1, text: view.text, links: view.links, attachments }
    const req: UpdateNote = {
      baseVersion: row.version,
      channelId: toChannelId,
      body: await sealNoteBody(target.recipient, body),
      preview: view.previews.length
        ? await sealPreview(target.recipient, { v: 1, items: view.previews })
        : null,
    }
    if (intoLocked) req.purgeHistory = true
    this.#applyLocalUpdate(row, req, body)
    await this.#enqueue({ kind: "updateNote", id, req })
  }

  async deleteNote(id: string): Promise<void> {
    const row = this.#note(id)
    this.replica.putPending({ ...row, deletedAt: Date.now() })
    this.#cache.delete(id)
    this.#changed()
    await this.#enqueue({ kind: "deleteNote", id })
  }

  async setPreviews(id: string, items: PreviewItem[]): Promise<void> {
    const row = this.#note(id)
    const channel = this.channel(row.channelId)
    const preview = items.length ? await sealPreview(channel.recipient, { v: 1, items }) : null
    this.replica.putPending({ ...row, preview })
    this.#changed()
    await this.#enqueue({ kind: "updatePreview", id, preview })
  }

  /** Decrypted history (oldest first), excluding the current version. */
  async history(id: string): Promise<{ version: number; createdAt: number; text: string }[]> {
    const versions = await this.api.versions(id)
    const out = []
    for (const v of versions) {
      const ch = this.replica.channels.get(v.channelId)
      const identity = ch ? await this.keys.identityFor(ch) : undefined
      if (!identity) continue
      try {
        out.push({
          version: v.version,
          createdAt: v.createdAt,
          text: (await openNoteBody(identity, v.body)).text,
        })
      } catch {
        /* skip unreadable */
      }
    }
    return out
  }

  /** Fetches link previews through the Worker. Never call this for locked channels unless the user asked. */
  async fetchPreviews(links: string[]): Promise<PreviewItem[]> {
    const items: PreviewItem[] = []
    for (const url of links.slice(0, 3)) {
      try {
        const u = await fitPreviewImage(await this.api.unfurl(url), this.#shrinkImage)
        if (u.title || u.description || u.image) items.push(u)
      } catch {
        /* previews are best effort */
      }
    }
    return items
  }

  /* --------------------------- attachments -------------------------- */

  async addAttachment(
    channelId: string,
    data: Uint8Array,
    mime: string,
    meta: {
      name?: string | undefined
      width?: number | undefined
      height?: number | undefined
    } = {},
  ): Promise<AttachmentRef> {
    const channel = this.channel(channelId)
    // Same limit the Worker enforces, checked before the work of encrypting and queueing.
    if (data.length > MAX_ATTACHMENT_PLAIN_BYTES) throw new ApiError(413, "attachment_too_large")
    const id = newId()
    const ct = await encryptTo(channel.recipient, data)
    await this.#enqueue({ kind: "uploadAttachment", id, channelId, data: ct })
    const ref: AttachmentRef = { id, mime, size: data.length }
    if (meta.name) ref.name = meta.name
    if (meta.width) ref.width = meta.width
    if (meta.height) ref.height = meta.height
    return ref
  }

  async readAttachment(channelId: string, ref: AttachmentRef): Promise<Uint8Array> {
    const identity = await this.#identity(channelId)
    const pending = (await this.outbox.load()).find(
      (e) => e.op.kind === "uploadAttachment" && e.op.id === ref.id,
    )
    const ct =
      pending?.op.kind === "uploadAttachment"
        ? bytesOf(pending.op.data)
        : await this.api.downloadAttachment(ref.id)
    return decryptWith(identity, ct)
  }

  /* ------------------------------ outbox ---------------------------- */

  #note(id: string): NoteRow {
    const row = this.replica.notes.get(id)
    if (!row || row.deletedAt !== null) throw new Error("unknown note")
    return row
  }

  #applyLocalUpdate(row: NoteRow, req: UpdateNote, body: NoteBody): void {
    const next: NoteRow = {
      ...row,
      version: row.version + 1,
      channelId: req.channelId ?? row.channelId,
      body: req.body,
      preview: req.preview !== undefined ? req.preview : row.preview,
      updatedAt: Date.now(),
    }
    this.replica.putPending(next)
    this.#cache.set(row.id, {
      version: next.version,
      channelId: next.channelId,
      body,
      previewFp: null,
      previews: [],
    })
    this.#changed()
  }

  /**
   * Rebuilds optimistic rows from the outbox. The outbox is written before a
   * write returns; the replica may be saved later, so after a reload or crash
   * this brings back pending notes, edits and deletes. Ciphertext only.
   */
  async restorePending(): Promise<void> {
    let changed = false
    const entries = (await this.outbox.load()).sort((a, b) => (a.key < b.key ? -1 : 1))
    for (const { op } of entries) {
      if (op.kind === "uploadAttachment") continue
      const id = op.kind === "createNote" ? op.req.id : op.id
      const row = this.replica.notes.get(id)
      const now = Date.now()
      if (op.kind === "createNote") {
        if (row) continue
        this.replica.putPending({
          id,
          channelId: op.req.channelId,
          version: 1,
          body: op.req.body,
          preview: op.req.preview ?? null,
          size: fromBase64(op.req.body).length,
          createdAt: op.req.createdAt ?? now,
          updatedAt: op.req.createdAt ?? now,
          deletedAt: null,
          seq: PENDING_SEQ,
        })
      } else if (!row) {
        continue
      } else if (op.kind === "updateNote") {
        if (row.version !== op.req.baseVersion) continue
        this.replica.putPending({
          ...row,
          version: row.version + 1,
          channelId: op.req.channelId ?? row.channelId,
          body: op.req.body,
          preview: op.req.preview !== undefined ? op.req.preview : row.preview,
          updatedAt: now,
        })
      } else if (op.kind === "updatePreview") {
        if (row.preview === op.preview) continue
        this.replica.putPending({ ...row, preview: op.preview })
      } else {
        if (row.deletedAt !== null) continue
        this.replica.putPending({ ...row, deletedAt: now })
      }
      changed = true
    }
    if (changed) this.#changed()
  }

  /** Outbox keys sort in write order, even for several writes in the same millisecond. */
  #lastKeyTime = 0

  async #enqueue(op: OutboxOp): Promise<void> {
    const t = (this.#lastKeyTime = Math.max(Date.now(), this.#lastKeyTime + 1))
    await this.outbox.put({ key: `${t.toString().padStart(15, "0")}-${newId()}`, op })
    await this.flush()
  }

  /** Sends pending writes in order. Stops at the first network failure; drops rejected ops. */
  flush(): Promise<FlushResult> {
    this.#flushing ??= this.#flush().finally(() => (this.#flushing = undefined))
    return this.#flushing
  }

  async #flush(): Promise<FlushResult> {
    const result: FlushResult = { sent: 0, pending: 0, rejected: [] }
    const entries = (await this.outbox.load()).sort((a, b) => (a.key < b.key ? -1 : 1))
    // Attachments first so notes never reference a blob that isn't there yet.
    entries.sort(
      (a, b) => Number(b.op.kind === "uploadAttachment") - Number(a.op.kind === "uploadAttachment"),
    )
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!
      try {
        await this.#send(e.op)
        await this.outbox.remove(e.key)
        result.sent++
      } catch (err) {
        if (
          err instanceof ApiError &&
          (err.status === 0 || err.status === 401 || err.status >= 500)
        ) {
          result.pending = entries.length - i
          break
        }
        await this.outbox.remove(e.key)
        result.rejected.push({ op: e.op.kind, error: err instanceof ApiError ? err.code : "error" })
      }
    }
    if (result.rejected.length) await this.#repair()
    if (result.sent || result.rejected.length) this.#changed()
    return result
  }

  /**
   * After the server rejected a write: drop optimistic rows that nothing in the
   * outbox will confirm, then resync from scratch to restore the server's copies.
   */
  async #repair(): Promise<void> {
    const waiting = new Set<string>()
    for (const { op } of await this.outbox.load())
      waiting.add(op.kind === "createNote" ? op.req.id : op.id)
    for (const [id, row] of this.replica.notes) {
      if (row.seq === PENDING_SEQ && !waiting.has(id)) this.replica.notes.delete(id)
    }
    this.replica.cursor = 0
    try {
      await this.sync()
    } catch {
      /* the next sync starts from 0 anyway */
    }
  }

  async #send(op: OutboxOp): Promise<void> {
    switch (op.kind) {
      case "createNote": {
        const { note } = await this.api.createNote(op.req)
        if (note.id !== op.req.id) this.replica.notes.delete(op.req.id) // import duplicate
        this.replica.apply({ channels: [], notes: [note] })
        return
      }
      case "updateNote":
        this.replica.apply({ channels: [], notes: [await this.api.updateNote(op.id, op.req)] })
        return
      case "updatePreview":
        this.replica.apply({
          channels: [],
          notes: [await this.api.updatePreview(op.id, op.preview)],
        })
        return
      case "deleteNote":
        this.replica.apply({ channels: [], notes: [await this.api.deleteNote(op.id)] })
        return
      case "uploadAttachment":
        await this.api.uploadAttachment(op.id, op.channelId, bytesOf(op.data))
        return
    }
  }

  async pendingCount(): Promise<number> {
    return (await this.outbox.load()).length
  }
}

export interface FlushResult {
  sent: number
  pending: number
  rejected: { op: string; error: string }[]
}
