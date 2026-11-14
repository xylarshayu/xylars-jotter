import { Hono } from "hono"
import {
  CreateChannel,
  CreateNote,
  DUMP_TABLES,
  MAX_ATTACHMENT_BYTES,
  MAX_NAME_BYTES,
  MAX_NOTE_BYTES,
  MAX_PREVIEW_BYTES,
  MAX_RESTORE_ROWS,
  RestoreBatch,
  type DumpTable,
  UpdateChannel,
  UpdateNote,
  UpdatePreview,
  type ChannelRow,
  type NoteRow,
} from "@jot/core/model"
import { isHybridAgeFile, isPassphraseAgeFile } from "./age.ts"
import type { AppEnv } from "./env.ts"
import { b64decode, type C, hexToB64, HttpError, parse } from "./http.ts"
import { unfurl, UnfurlError } from "./unfurl.ts"

const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * Ciphertext columns are read as hex text (`hex(col) AS col`) and sent as base64. D1 hands text
 * to the Worker far more cheaply than blobs, and both conversions are native (ADR-0020).
 */
type Hex = string
const hex = (col: string) => `hex(${col}) AS ${col}`

interface ChannelDb {
  id: string
  lock: string
  recipient: string
  wrapped_key: Hex
  name: Hex
  created_at: number
  updated_at: number
  deleted_at: number | null
  seq: number
}

interface NoteDb {
  id: string
  channel_id: string
  version: number
  body: Hex
  preview: Hex | null
  size: number
  created_at: number
  updated_at: number
  deleted_at: number | null
  seq: number
}

const channelOut = (r: ChannelDb): ChannelRow => ({
  id: r.id,
  lock: r.lock === "open" ? "open" : "locked",
  recipient: r.recipient,
  wrappedKey: hexToB64(r.wrapped_key),
  name: hexToB64(r.name),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
  seq: r.seq,
})

const noteOut = (r: NoteDb): NoteRow => ({
  id: r.id,
  channelId: r.channel_id,
  version: r.version,
  body: hexToB64(r.body),
  preview: r.preview === null ? null : hexToB64(r.preview),
  size: r.size,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
  seq: r.seq,
})

const CHANNEL_COLS = `id, lock, recipient, ${hex("wrapped_key")}, ${hex("name")}, created_at, updated_at, deleted_at, seq`
const NOTE_COLS = `id, channel_id, version, ${hex("body")},
  iif(preview IS NULL, NULL, hex(preview)) AS preview, size, created_at, updated_at, deleted_at, seq`

function hybridBlob(b64: string, max: number, what: string): Uint8Array {
  // Refuse oversized payloads before decoding them: 4 characters carry 3 bytes.
  if (b64.length > Math.ceil(max / 3) * 4) throw new HttpError(413, `${what}_too_large`)
  const bytes = b64decode(b64)
  if (bytes.length > max) throw new HttpError(413, `${what}_too_large`)
  if (!isHybridAgeFile(bytes)) throw new HttpError(422, `${what}_not_pq_age`)
  return bytes
}

/** Statement that bumps the user's change counter; the next statement reads it. */
function bump(c: C) {
  return c.env.DB.prepare(
    "INSERT INTO users (id, seq, created_at) VALUES (?1, 1, ?2) ON CONFLICT(id) DO UPDATE SET seq = users.seq + 1",
  ).bind(c.get("userId"), Date.now())
}

const SEQ = "(SELECT seq FROM users WHERE id = ?1)"

async function getChannel(c: C, id: string): Promise<ChannelDb | null> {
  return c.env.DB.prepare(`SELECT ${CHANNEL_COLS} FROM channels WHERE user_id = ? AND id = ?`)
    .bind(c.get("userId"), id)
    .first<ChannelDb>()
}

async function getNote(c: C, id: string): Promise<NoteDb | null> {
  return c.env.DB.prepare(`SELECT ${NOTE_COLS} FROM notes WHERE user_id = ? AND id = ?`)
    .bind(c.get("userId"), id)
    .first<NoteDb>()
}

async function liveChannel(c: C, id: string): Promise<ChannelDb> {
  const ch = await getChannel(c, id)
  if (!ch || ch.deleted_at !== null) throw new HttpError(404, "channel_not_found")
  return ch
}

function param(c: C, name: string): string {
  const v = c.req.param(name) ?? ""
  if (!ID_RE.test(v)) throw new HttpError(404, "not_found")
  return v
}

/**
 * Routes served to both kinds of session: through Access at /api, and with a paired device's
 * session at /device-api (ADR-0019). index.ts mounts them behind the right check.
 */
export const api = new Hono<AppEnv>()

/** Routes only an Access session (the owner's browser or the CLI's service token) reaches. */
export const accessOnly = new Hono<AppEnv>()

export function onError(err: Error, c: C) {
  if (err instanceof HttpError) return c.json({ error: err.code }, err.status)
  if (err instanceof UnfurlError) return c.json({ error: err.code }, 422)
  // Never log request bodies or URLs; they may be sensitive.
  console.error("internal error", err.name)
  return c.json({ error: "internal" }, 500)
}

api.get("/me", (c) => c.json({ userId: c.get("userId"), device: c.get("device") }))

// The web app sends the browser here to sign in. Access signs the user in on the way; the
// Worker just returns to the app.
accessOnly.get("/login", (c) => c.redirect("/", 302))

/* ------------------------------- sync ------------------------------- */

/**
 * Pages end at a row count or once about PAGE_BYTES of ciphertext is in (always at least one
 * row), whichever comes first. Reading blobs from D1 and encoding them costs about 25 ms of CPU
 * per MB, and a request gets 10 ms on the free plan (measured, ADR-0020).
 */
export const PAGE_BYTES = 192 * 1024
const NOTE_BYTES = "length(body) + ifnull(length(preview), 0)"

/** A paged row, with the running total of ciphertext bytes up to and including it. */
type Paged<T> = T & { upto: number }

/**
 * The next page of `table` after `?2` in `order`, for user `?1`: at most `?3` rows, cut once the
 * running total of `bytes` reaches PAGE_BYTES. SQLite reads only the row headers to add up the
 * sizes, and only the selected rows in full. All arguments are constants from this file.
 */
function pageSql(cols: string, table: string, order: string, bytes: string): string {
  return `SELECT ${cols}, p.upto FROM ${table} t JOIN (
    SELECT k, upto FROM (
      SELECT k, size, SUM(size) OVER (ORDER BY o) AS upto FROM (
        SELECT rowid AS k, ${order} AS o, ${bytes} AS size FROM ${table}
        WHERE user_id = ?1 AND ${order} > ?2 ORDER BY ${order} LIMIT ?3))
    WHERE upto - size < ${PAGE_BYTES}) p ON t.rowid = p.k
  ORDER BY t.${order}`
}

api.get("/sync", async (c) => {
  const since = Math.max(0, Number(c.req.query("since") ?? 0) | 0)
  const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit") ?? 500) | 0))
  const count = c.req.query("count") === "1"
  const uid = c.get("userId")
  // One batch = one consistent snapshot. `count` (a first sync's progress) reads only the index.
  const [user, channels, notes, remaining] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT seq FROM users WHERE id = ?").bind(uid),
    c.env.DB.prepare(
      `SELECT ${CHANNEL_COLS} FROM channels WHERE user_id = ? AND seq > ? ORDER BY seq`,
    ).bind(uid, since),
    c.env.DB.prepare(pageSql(NOTE_COLS, "notes", "seq", NOTE_BYTES)).bind(uid, since, limit + 1),
    ...(count
      ? [
          c.env.DB.prepare("SELECT count(*) AS n FROM notes WHERE user_id = ? AND seq > ?").bind(
            uid,
            since,
          ),
        ]
      : []),
  ])
  const head = (user!.results[0] as { seq: number } | undefined)?.seq ?? 0
  const noteRows = notes!.results as unknown as Paged<NoteDb>[]
  const page = noteRows.slice(0, limit)
  const more = noteRows.length > limit || (page.at(-1)?.upto ?? 0) >= PAGE_BYTES
  const cursor = more ? page[page.length - 1]!.seq : Math.max(head, since)
  return c.json({
    channels: (channels!.results as unknown as ChannelDb[])
      .filter((r) => r.seq <= cursor)
      .map(channelOut),
    notes: page.map(noteOut),
    cursor,
    more,
    ...(remaining && { remaining: (remaining.results[0] as { n: number }).n }),
  })
})

/* ----------------------------- channels ----------------------------- */

api.post("/channels", async (c) => {
  const req = await parse(c, CreateChannel)
  const wrapped = b64decode(req.wrappedKey)
  // Fail closed: the wrapping must match the declared lock kind.
  if (req.lock === "open" ? !isHybridAgeFile(wrapped) : !isPassphraseAgeFile(wrapped)) {
    throw new HttpError(422, "wrapped_key_mismatch")
  }
  const name = hybridBlob(req.name, MAX_NAME_BYTES, "name")
  if (await getChannel(c, req.id)) throw new HttpError(409, "channel_exists")
  const now = Date.now()
  await c.env.DB.batch([
    bump(c),
    c.env.DB.prepare(
      `INSERT INTO channels (user_id, id, lock, recipient, wrapped_key, name, created_at, updated_at, deleted_at, seq)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, NULL, ${SEQ})`,
    ).bind(c.get("userId"), req.id, req.lock, req.recipient, wrapped, name, now),
  ])
  return c.json(channelOut((await getChannel(c, req.id))!), 201)
})

api.patch("/channels/:id", async (c) => {
  const id = param(c, "id")
  const req = await parse(c, UpdateChannel)
  const ch = await liveChannel(c, id)
  const sets: string[] = []
  const vals: unknown[] = []
  if (req.name !== undefined) {
    sets.push("name = ?")
    vals.push(hybridBlob(req.name, MAX_NAME_BYTES, "name"))
  }
  if (req.wrappedKey !== undefined) {
    const wrapped = b64decode(req.wrappedKey)
    // Only a passphrase change on a locked channel; the lock kind never changes in place.
    if (ch.lock !== "locked" || !isPassphraseAgeFile(wrapped))
      throw new HttpError(422, "wrapped_key_mismatch")
    sets.push("wrapped_key = ?")
    vals.push(wrapped)
  }
  if (sets.length === 0) return c.json(channelOut(ch))
  await c.env.DB.batch([
    bump(c),
    c.env.DB.prepare(
      `UPDATE channels SET ${sets.join(", ")}, updated_at = ?, seq = (SELECT seq FROM users WHERE id = ?) WHERE user_id = ? AND id = ?`,
    ).bind(...vals, Date.now(), c.get("userId"), c.get("userId"), id),
  ])
  return c.json(channelOut((await getChannel(c, id))!))
})

api.delete("/channels/:id", async (c) => {
  const id = param(c, "id")
  await liveChannel(c, id)
  const live = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM notes WHERE user_id = ? AND channel_id = ? AND deleted_at IS NULL",
  )
    .bind(c.get("userId"), id)
    .first<{ n: number }>()
  if ((live?.n ?? 0) > 0) throw new HttpError(409, "channel_not_empty")
  await c.env.DB.batch([
    bump(c),
    c.env.DB.prepare(
      `UPDATE channels SET deleted_at = ?2, updated_at = ?2, seq = ${SEQ} WHERE user_id = ?1 AND id = ?3`,
    ).bind(c.get("userId"), Date.now(), id),
  ])
  return c.json(channelOut((await getChannel(c, id))!))
})

/* ------------------------------- notes ------------------------------ */

api.post("/notes", async (c) => {
  const req = await parse(c, CreateNote)
  const uid = c.get("userId")
  await liveChannel(c, req.channelId)
  const body = hybridBlob(req.body, MAX_NOTE_BYTES, "body")
  const preview = req.preview ? hybridBlob(req.preview, MAX_PREVIEW_BYTES, "preview") : null
  // Idempotency: by note id (outbox retries) and by import source hash.
  const existing = await getNote(c, req.id)
  if (existing) {
    if (existing.channel_id !== req.channelId) throw new HttpError(409, "note_exists")
    return c.json({ note: noteOut(existing), duplicate: true })
  }
  if (req.sourceHash) {
    const dup = await c.env.DB.prepare(
      `SELECT ${NOTE_COLS} FROM notes WHERE user_id = ? AND source_hash = ?`,
    )
      .bind(uid, req.sourceHash)
      .first<NoteDb>()
    if (dup) return c.json({ note: noteOut(dup), duplicate: true })
  }
  const now = Date.now()
  await c.env.DB.batch([
    bump(c),
    c.env.DB.prepare(
      `INSERT INTO notes (user_id, id, channel_id, version, body, preview, size, source_hash, created_at, updated_at, deleted_at, seq)
       VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ${SEQ})`,
    ).bind(
      uid,
      req.id,
      req.channelId,
      body,
      preview,
      body.length,
      req.sourceHash ?? null,
      req.createdAt ?? now,
      now,
    ),
  ])
  return c.json({ note: noteOut((await getNote(c, req.id))!), duplicate: false }, 201)
})

api.put("/notes/:id", async (c) => {
  const id = param(c, "id")
  const req = await parse(c, UpdateNote)
  const uid = c.get("userId")
  const note = await getNote(c, id)
  if (!note || note.deleted_at !== null) throw new HttpError(404, "note_not_found")
  if (note.version !== req.baseVersion) throw new HttpError(409, "version_conflict")
  const target = await liveChannel(c, req.channelId ?? note.channel_id)
  if (target.id !== note.channel_id && target.lock === "locked" && !req.purgeHistory) {
    // Moving into a locked channel must not leave older copies readable elsewhere.
    throw new HttpError(422, "purge_required")
  }
  const body = hybridBlob(req.body, MAX_NOTE_BYTES, "body")
  // Left out of the request: the stored preview stays as it is.
  const keepPreview = req.preview === undefined
  const preview = req.preview ? hybridBlob(req.preview, MAX_PREVIEW_BYTES, "preview") : null
  const now = Date.now()
  const stmts = [bump(c)]
  if (req.purgeHistory) {
    stmts.push(
      c.env.DB.prepare("DELETE FROM note_versions WHERE user_id = ? AND note_id = ?").bind(uid, id),
    )
  } else {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO note_versions (user_id, note_id, version, channel_id, body, created_at)
         SELECT user_id, id, version, channel_id, body, updated_at FROM notes WHERE user_id = ? AND id = ? AND version = ?`,
      ).bind(uid, id, req.baseVersion),
    )
  }
  stmts.push(
    c.env.DB.prepare(
      `UPDATE notes SET channel_id = ?3, version = version + 1, body = ?4, preview = ${keepPreview ? "preview" : "?5"}, size = ?6, updated_at = ?7, seq = ${SEQ}
       WHERE user_id = ?1 AND id = ?2 AND version = ?8 AND deleted_at IS NULL`,
    ).bind(uid, id, target.id, body, preview, body.length, now, req.baseVersion),
  )
  const results = await c.env.DB.batch(stmts)
  if (results[results.length - 1]!.meta.changes !== 1) throw new HttpError(409, "version_conflict")
  return c.json(noteOut((await getNote(c, id))!))
})

api.put("/notes/:id/preview", async (c) => {
  const id = param(c, "id")
  const req = await parse(c, UpdatePreview)
  const note = await getNote(c, id)
  if (!note || note.deleted_at !== null) throw new HttpError(404, "note_not_found")
  const preview =
    req.preview === null ? null : hybridBlob(req.preview, MAX_PREVIEW_BYTES, "preview")
  await c.env.DB.batch([
    bump(c),
    c.env.DB.prepare(
      `UPDATE notes SET preview = ?3, seq = ${SEQ} WHERE user_id = ?1 AND id = ?2`,
    ).bind(c.get("userId"), id, preview),
  ])
  return c.json(noteOut((await getNote(c, id))!))
})

api.delete("/notes/:id", async (c) => {
  const id = param(c, "id")
  const uid = c.get("userId")
  const note = await getNote(c, id)
  if (!note) throw new HttpError(404, "note_not_found")
  if (note.deleted_at !== null) return c.json(noteOut(note))
  const now = Date.now()
  // Soft delete: the last body moves to history; the live row becomes an empty tombstone.
  await c.env.DB.batch([
    bump(c),
    c.env.DB.prepare(
      `INSERT OR REPLACE INTO note_versions (user_id, note_id, version, channel_id, body, created_at)
       SELECT user_id, id, version, channel_id, body, updated_at FROM notes WHERE user_id = ? AND id = ?`,
    ).bind(uid, id),
    c.env.DB.prepare(
      `UPDATE notes SET body = x'', preview = NULL, size = 0, deleted_at = ?3, updated_at = ?3, seq = ${SEQ} WHERE user_id = ?1 AND id = ?2`,
    ).bind(uid, id, now),
  ])
  return c.json(noteOut((await getNote(c, id))!))
})

api.get("/notes/:id/versions", async (c) => {
  const id = param(c, "id")
  const rows = await c.env.DB.prepare(
    `SELECT version, channel_id, ${hex("body")}, created_at FROM note_versions WHERE user_id = ? AND note_id = ? ORDER BY version`,
  )
    .bind(c.get("userId"), id)
    .all<{ version: number; channel_id: string; body: Hex; created_at: number }>()
  return c.json(
    rows.results.map((r) => ({
      version: r.version,
      channelId: r.channel_id,
      body: hexToB64(r.body),
      createdAt: r.created_at,
    })),
  )
})

/* ---------------------------- attachments --------------------------- */

const r2key = (uid: string, id: string) => `u/${uid}/a/${id}`

/** Enough to hold any age header this app writes (one or two hybrid stanzas, ~1.7 KB each). */
const AGE_HEAD_BYTES = 16 * 1024

/**
 * Streams an attachment upload into R2. Workers have 128 MB of memory and uploads can be 95 MB, so
 * the body is never buffered: the declared length is enforced, the age header is checked from
 * the first bytes, and the rest is piped through. Returns the stored size.
 */
async function storeAgeUpload(c: C, key: string): Promise<number> {
  const length = Number(c.req.header("content-length"))
  const body = c.req.raw.body
  if (!body || !Number.isSafeInteger(length) || length <= 0)
    throw new HttpError(411, "length_required")
  if (length > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "attachment_too_large")
  const reader = body.getReader()
  const head: Uint8Array[] = []
  let got = 0
  while (got < Math.min(length, AGE_HEAD_BYTES)) {
    const r = await reader.read()
    if (r.done) break
    head.push(r.value)
    got += r.value.length
  }
  const first = new Uint8Array(got)
  head.reduce((at, chunk) => (first.set(chunk, at), at + chunk.length), 0)
  if (!isHybridAgeFile(first)) {
    await reader.cancel().catch(() => {})
    throw new HttpError(422, "attachment_not_pq_age")
  }
  const { readable, writable } = new FixedLengthStream(length)
  const pump = (async () => {
    const w = writable.getWriter()
    try {
      await w.write(first)
      for (;;) {
        const r = await reader.read()
        if (r.done) break
        await w.write(r.value)
      }
      await w.close()
    } catch (e) {
      await w.abort(e).catch(() => {})
    }
  })()
  try {
    await Promise.all([c.env.FILES.put(key, readable), pump])
  } catch {
    // Body shorter or longer than declared. R2 keeps nothing from a failed put.
    throw new HttpError(400, "length_mismatch")
  }
  return length
}

api.put("/attachments/:id", async (c) => {
  const id = param(c, "id")
  const uid = c.get("userId")
  const channelId = c.req.query("channelId") ?? ""
  if (!ID_RE.test(channelId)) throw new HttpError(400, "invalid_request")
  await liveChannel(c, channelId)
  const existing = await c.env.DB.prepare(
    "SELECT id, channel_id, size, created_at FROM attachments WHERE user_id = ? AND id = ?",
  )
    .bind(uid, id)
    .first<{ id: string; channel_id: string; size: number; created_at: number }>()
  if (existing)
    return c.json({
      id,
      channelId: existing.channel_id,
      size: existing.size,
      createdAt: existing.created_at,
    })
  const size = await storeAgeUpload(c, r2key(uid, id))
  const now = Date.now()
  await c.env.DB.prepare(
    "INSERT INTO attachments (user_id, id, channel_id, size, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(uid, id, channelId, size, now)
    .run()
  return c.json({ id, channelId, size, createdAt: now }, 201)
})

api.get("/attachments/:id", async (c) => {
  const id = param(c, "id")
  const obj = await c.env.FILES.get(r2key(c.get("userId"), id))
  if (!obj) throw new HttpError(404, "attachment_not_found")
  return new Response(obj.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(obj.size),
      // A temporary device (ADR-0016) asks that not even ciphertext stays in the browser cache.
      "cache-control": c.req.header("x-jot-no-store")
        ? "no-store"
        : "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  })
})

/* ------------------- store copy (jot migrate, ADR-0015) ------------------- */

// The dump is read-only and returns the same ciphertext as sync, plus history, attachment rows
// and import source hashes. Rows are paged by SQLite rowid.
const DUMP_SQL: Record<DumpTable, string> = {
  channels: pageSql(`t.rowid AS r, ${CHANNEL_COLS}`, "channels", "rowid", "length(name)"),
  notes: pageSql(`t.rowid AS r, ${NOTE_COLS}, source_hash`, "notes", "rowid", NOTE_BYTES),
  versions: pageSql(
    `t.rowid AS r, note_id, version, channel_id, ${hex("body")}, created_at`,
    "note_versions",
    "rowid",
    "length(body)",
  ),
  attachments: pageSql(
    "t.rowid AS r, id, channel_id, size, created_at",
    "attachments",
    "rowid",
    "0",
  ),
}

type DumpDb = Paged<{ r: number } & Record<string, unknown>>
const dumpOut: Record<DumpTable, (r: DumpDb) => unknown> = {
  channels: (r) => channelOut(r as unknown as ChannelDb),
  notes: (r) => ({ ...noteOut(r as unknown as NoteDb), sourceHash: r.source_hash ?? null }),
  versions: (r) => ({
    noteId: r.note_id,
    version: r.version,
    channelId: r.channel_id,
    body: hexToB64(r.body as Hex),
    createdAt: r.created_at,
  }),
  attachments: (r) => ({
    id: r.id,
    channelId: r.channel_id,
    size: r.size,
    createdAt: r.created_at,
  }),
}

accessOnly.get("/dump/:table", async (c) => {
  const table = c.req.param("table") as DumpTable
  if (!DUMP_TABLES.includes(table)) throw new HttpError(404, "not_found")
  const after = Math.max(0, Number(c.req.query("after") ?? 0) | 0)
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 200) | 0))
  const res = (
    await c.env.DB.prepare(DUMP_SQL[table]).bind(c.get("userId"), after, limit).all<DumpDb>()
  ).results
  const last = res.at(-1)
  return c.json({
    rows: res.map(dumpOut[table]),
    next: last && (res.length === limit || last.upto >= PAGE_BYTES) ? last.r : null,
  })
})

// Restore writes rows exactly as given (ids, versions, timestamps, sync sequence, source hashes),
// so it only works on an account that has never been written to: no users row yet. Normal
// writes create that row, and so does /restore/finish, which closes restore for good.
async function assertRestorable(c: C): Promise<void> {
  const user = await c.env.DB.prepare("SELECT 1 AS x FROM users WHERE id = ?")
    .bind(c.get("userId"))
    .first()
  if (user) throw new HttpError(409, "account_not_empty")
}

accessOnly.post("/restore", async (c) => {
  await assertRestorable(c)
  const req = await parse(c, RestoreBatch)
  if (req.channels.length + req.notes.length + req.versions.length > MAX_RESTORE_ROWS)
    throw new HttpError(413, "too_many_rows")
  const uid = c.get("userId")
  const stmts = []
  for (const ch of req.channels) {
    const wrapped = b64decode(ch.wrappedKey)
    if (ch.lock === "open" ? !isHybridAgeFile(wrapped) : !isPassphraseAgeFile(wrapped))
      throw new HttpError(422, "wrapped_key_mismatch")
    stmts.push(
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO channels (user_id, id, lock, recipient, wrapped_key, name, created_at, updated_at, deleted_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        uid,
        ch.id,
        ch.lock,
        ch.recipient,
        wrapped,
        hybridBlob(ch.name, MAX_NAME_BYTES, "name"),
        ch.createdAt,
        ch.updatedAt,
        ch.deletedAt,
        ch.seq,
      ),
    )
  }
  for (const n of req.notes) {
    // A deleted note is an empty tombstone; everything else must be hybrid age.
    const body =
      n.deletedAt !== null && n.body === ""
        ? new Uint8Array()
        : hybridBlob(n.body, MAX_NOTE_BYTES, "body")
    const preview = n.preview ? hybridBlob(n.preview, MAX_PREVIEW_BYTES, "preview") : null
    stmts.push(
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO notes (user_id, id, channel_id, version, body, preview, size, source_hash, created_at, updated_at, deleted_at, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        uid,
        n.id,
        n.channelId,
        n.version,
        body,
        preview,
        body.length,
        n.sourceHash,
        n.createdAt,
        n.updatedAt,
        n.deletedAt,
        n.seq,
      ),
    )
  }
  for (const v of req.versions) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO note_versions (user_id, note_id, version, channel_id, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        uid,
        v.noteId,
        v.version,
        v.channelId,
        hybridBlob(v.body, MAX_NOTE_BYTES, "body"),
        v.createdAt,
      ),
    )
  }
  if (stmts.length) await c.env.DB.batch(stmts)
  return c.json({
    channels: req.channels.length,
    notes: req.notes.length,
    versions: req.versions.length,
  })
})

accessOnly.put("/restore/attachments/:id", async (c) => {
  await assertRestorable(c)
  const id = param(c, "id")
  const channelId = c.req.query("channelId") ?? ""
  const createdAt = Number(c.req.query("createdAt"))
  if (!ID_RE.test(channelId) || !Number.isSafeInteger(createdAt) || createdAt < 0)
    throw new HttpError(400, "invalid_request")
  const uid = c.get("userId")
  const size = await storeAgeUpload(c, r2key(uid, id))
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO attachments (user_id, id, channel_id, size, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(uid, id, channelId, size, createdAt)
    .run()
  return c.json({ id, channelId, size, createdAt })
})

accessOnly.post("/restore/finish", async (c) => {
  await assertRestorable(c)
  const uid = c.get("userId")
  const top = await c.env.DB.prepare(
    `SELECT MAX(seq) AS seq FROM (SELECT seq FROM channels WHERE user_id = ?1
       UNION ALL SELECT seq FROM notes WHERE user_id = ?1)`,
  )
    .bind(uid)
    .first<{ seq: number | null }>()
  const seq = top?.seq ?? 0
  await c.env.DB.prepare("INSERT INTO users (id, seq, created_at) VALUES (?, ?, ?)")
    .bind(uid, seq, Date.now())
    .run()
  return c.json({ seq })
})

/* ------------------------------ unfurl ------------------------------ */

api.get("/unfurl", async (c) => {
  const url = c.req.query("url") ?? ""
  return c.json(await unfurl(url))
})
