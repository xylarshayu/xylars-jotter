/**
 * Pairing and device sessions (ADR-0019). A new device starts a pairing without signing in. A
 * signed-in device approves it by sealing the open key to the new device's one-time key. The new
 * device then claims, with a secret only it holds, the sealed key and a device session: a bearer
 * token for /device-api. The Worker stores only hashes of the secret and the token, and can't open
 * the sealed key. Nothing here is logged.
 */
import { Hono, type MiddlewareHandler } from "hono"
import {
  ApprovePairing,
  ClaimPairing,
  DEVICE_IDLE_MS,
  type DeviceRow,
  MAX_PAIRING_KEY_BYTES,
  MAX_PAIRINGS_PER_SOURCE,
  MAX_PENDING_PAIRINGS,
  PAIRING_ID_RE,
  PAIRING_TTL_MS,
  StartPairing,
  TEMPORARY_IDLE_MS,
  TEMPORARY_MAX_MS,
} from "@jot/core/model"
import { b64decode, b64encode, stanzaTypes } from "./age.ts"
import type { AppEnv } from "./env.ts"
import { type C, HttpError, parse, randomB64url, sha256 } from "./http.ts"

const TOKEN_RE = /^Bearer (jotd_[A-Za-z0-9_-]{43})$/
/** Revoked and expired sessions are kept this long, so the device learns why it was signed out. */
const KEEP_ENDED_MS = 30 * 24 * 3600_000
const SEEN_EVERY_MS = 60_000

/* ------------------------------ helpers ----------------------------- */

/** Browser family and OS from a fixed list, so the approval screen never shows caller text. */
export function agentOf(ua: string): string {
  const os = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iOS"
      : /CrOS/.test(ua)
        ? "ChromeOS"
        : /Macintosh|Mac OS X/.test(ua)
          ? "macOS"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : ""
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser/.test(ua)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS/.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS/.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : ""
  if (browser && os) return `${browser} on ${os}`
  if (browser) return browser
  return os ? `A browser on ${os}` : "Unknown browser"
}

const printable = (v: unknown) =>
  typeof v === "string"
    ? [...v]
        .filter((ch) => ch >= " " && ch !== "\u007f")
        .join("")
        .trim()
        .slice(0, 60)
    : ""

/** Where Cloudflare places the request, e.g. "Pune, IN". Empty when unknown. */
function placeOf(c: C): string {
  const cf = c.req.raw.cf as { city?: unknown; country?: unknown } | undefined
  return [printable(cf?.city), printable(cf?.country)].filter(Boolean).join(", ")
}

/** The client's IP, or its /64 for IPv6, which one host can fill with addresses. */
export function sourceOf(ip: string): string {
  if (!ip.includes(":")) return ip
  const [head = "", tail] = ip.split("::")
  const left = head.split(":").filter(Boolean)
  const right = tail === undefined ? [] : tail.split(":").filter(Boolean)
  const all = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
  return all
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")
}

function idParam(c: C, what: "pairing" | "device"): string {
  const v = c.req.param("id") ?? ""
  if (!PAIRING_ID_RE.test(v)) throw new HttpError(404, `${what}_not_found`)
  return v
}

/** Temporary sessions read and write notes, but can't add or remove other devices. */
function notTemporary(c: C) {
  if (c.get("device")?.temporary) throw new HttpError(403, "temporary_device")
}

interface DeviceDb {
  id: string
  user_id: string
  temporary: number
  agent: string
  place: string
  created_at: number
  last_seen_at: number
  expires_at: number
  revoked_at: number | null
}

const deviceOut = (r: DeviceDb, currentId: string | undefined): DeviceRow => ({
  id: r.id,
  temporary: !!r.temporary,
  agent: r.agent,
  place: r.place,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  expiresAt: r.expires_at,
  current: r.id === currentId,
})

function slide(r: Pick<DeviceDb, "temporary" | "created_at">, now: number): number {
  return r.temporary
    ? Math.min(now + TEMPORARY_IDLE_MS, r.created_at + TEMPORARY_MAX_MS)
    : now + DEVICE_IDLE_MS
}

/* ---------------------------- the session ---------------------------- */

/** Checks `Authorization: Bearer jotd_…` against the devices table. */
export const deviceAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = TOKEN_RE.exec(c.req.header("authorization") ?? "")
  if (!m) return c.json({ error: "unauthenticated" }, 401)
  const row = await c.env.DB.prepare(
    `SELECT id, user_id, temporary, agent, place, created_at, last_seen_at, expires_at, revoked_at
     FROM devices WHERE token_hash = ?`,
  )
    .bind(await sha256(m[1]!))
    .first<DeviceDb>()
  if (!row) return c.json({ error: "unauthenticated" }, 401)
  if (row.revoked_at !== null) return c.json({ error: "session_revoked" }, 401)
  const now = Date.now()
  if (row.expires_at <= now) return c.json({ error: "session_expired" }, 401)
  if (now - row.last_seen_at >= SEEN_EVERY_MS)
    await c.env.DB.prepare(
      "UPDATE devices SET last_seen_at = ?, expires_at = ? WHERE user_id = ? AND id = ?",
    )
      .bind(now, slide(row, now), row.user_id, row.id)
      .run()
  c.set("userId", row.user_id)
  c.set("device", { id: row.id, temporary: !!row.temporary })
  return next()
}

/* ------------------- public: the device being paired ------------------ */

export const publicPairing = new Hono<AppEnv>()

/**
 * JSON only: another site can't send that cross-origin without a CORS preflight, which the Worker
 * never grants. So a web page can't start pairings from its visitors' browsers.
 */
function publicBody<T extends Parameters<typeof parse>[1]>(c: C, schema: T) {
  if (!/^application\/json\b/i.test(c.req.header("content-type") ?? ""))
    throw new HttpError(415, "json_required")
  return parse(c, schema)
}

publicPairing.post("/pairings", async (c) => {
  const { recipient, temporary } = await publicBody(c, StartPairing)
  const now = Date.now()
  await c.env.DB.prepare("DELETE FROM pairings WHERE expires_at <= ?").bind(now).run()
  const id = randomB64url(16)
  const secret = randomB64url(32)
  const source = await sha256(`jot-source\n${sourceOf(c.req.header("cf-connecting-ip") ?? "")}`)
  const expiresAt = now + PAIRING_TTL_MS
  // One statement, so the caps hold under concurrent requests. Nothing is written past them.
  const r = await c.env.DB.prepare(
    `INSERT INTO pairings (id, secret_hash, source_hash, recipient, temporary, agent, place, created_at, expires_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
     WHERE (SELECT COUNT(*) FROM pairings) < ?10
       AND (SELECT COUNT(*) FROM pairings WHERE source_hash = ?3) < ?11`,
  )
    .bind(
      id,
      await sha256(secret),
      source,
      recipient,
      temporary ? 1 : 0,
      agentOf(c.req.header("user-agent") ?? ""),
      placeOf(c),
      now,
      expiresAt,
      MAX_PENDING_PAIRINGS,
      MAX_PAIRINGS_PER_SOURCE,
    )
    .run()
  if (!r.meta.changes) throw new HttpError(429, "too_many_pairings")
  return c.json({ id, secret, expiresAt }, 201)
})

// The new device polls this. Unknown id, wrong secret and expired all answer the same 404.
publicPairing.post("/pairings/:id/claim", async (c) => {
  const id = idParam(c, "pairing")
  const hash = await sha256((await publicBody(c, ClaimPairing)).secret)
  const now = Date.now()
  const live = "id = ?1 AND secret_hash = ?2 AND expires_at > ?3"
  const row = await c.env.DB.prepare(
    `SELECT user_id IS NOT NULL AS approved FROM pairings WHERE ${live}`,
  )
    .bind(id, hash, now)
    .first<{ approved: number }>()
  if (!row) throw new HttpError(404, "pairing_not_found")
  if (!row.approved) return c.json({ status: "pending" })

  const token = `jotd_${randomB64url(32)}`
  const deviceId = randomB64url(16)
  // One transaction: the session is created and the pairing deleted together, or neither.
  const [, taken] = await c.env.DB.batch<{
    key_ciphertext: ArrayBuffer
    user_id: string
    temporary: number
    agent: string
    place: string
  }>([
    c.env.DB.prepare(
      `INSERT INTO devices (user_id, id, token_hash, temporary, agent, place, created_at, last_seen_at, expires_at)
       SELECT user_id, ?4, ?5, temporary, agent, place, ?3, ?3,
              ?3 + CASE WHEN temporary THEN ?6 ELSE ?7 END
       FROM pairings WHERE ${live} AND user_id IS NOT NULL`,
    ).bind(id, hash, now, deviceId, await sha256(token), TEMPORARY_IDLE_MS, DEVICE_IDLE_MS),
    c.env.DB.prepare(
      `DELETE FROM pairings WHERE ${live} AND user_id IS NOT NULL
       RETURNING key_ciphertext, user_id, temporary, agent, place`,
    ).bind(id, hash, now),
  ])
  const p = taken?.results[0]
  if (!p) throw new HttpError(404, "pairing_not_found")
  const device: DeviceDb = {
    id: deviceId,
    user_id: p.user_id,
    temporary: p.temporary,
    agent: p.agent,
    place: p.place,
    created_at: now,
    last_seen_at: now,
    expires_at: slide({ temporary: p.temporary, created_at: now }, now),
    revoked_at: null,
  }
  return c.json({
    status: "ready",
    key: b64encode(p.key_ciphertext),
    token,
    device: deviceOut(device, deviceId),
  })
})

publicPairing.post("/pairings/:id/cancel", async (c) => {
  const id = idParam(c, "pairing")
  const hash = await sha256((await publicBody(c, ClaimPairing)).secret)
  await c.env.DB.prepare("DELETE FROM pairings WHERE id = ? AND secret_hash = ?")
    .bind(id, hash)
    .run()
  return c.json({ ok: true })
})

/* --------------- signed in: approving devices, and the list --------------- */

export const sessionRoutes = new Hono<AppEnv>()

// An unapproved pairing is visible to any signed-in user (there is one per deployment); an
// approved one only to the user who approved it.
const VISIBLE = "id = ?1 AND expires_at > ?2 AND (user_id IS NULL OR user_id = ?3)"

sessionRoutes.get("/pairings/:id", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT id, recipient, temporary, agent, place, expires_at, user_id IS NOT NULL AS approved
     FROM pairings WHERE ${VISIBLE}`,
  )
    .bind(idParam(c, "pairing"), Date.now(), c.get("userId"))
    .first<{
      id: string
      recipient: string
      temporary: number
      agent: string
      place: string
      expires_at: number
      approved: number
    }>()
  if (!row) throw new HttpError(404, "pairing_not_found")
  return c.json({
    id: row.id,
    recipient: row.recipient,
    temporary: !!row.temporary,
    agent: row.agent,
    place: row.place,
    expiresAt: row.expires_at,
    approved: !!row.approved,
  })
})

sessionRoutes.post("/pairings/:id/approve", async (c) => {
  notTemporary(c)
  const id = idParam(c, "pairing")
  const bytes = b64decode((await parse(c, ApprovePairing)).key)
  if (bytes.length > MAX_PAIRING_KEY_BYTES) throw new HttpError(413, "key_too_large")
  // Sealed to exactly one hybrid recipient: the new device's one-time key.
  const types = stanzaTypes(bytes)
  if (types?.length !== 1 || types[0] !== "mlkem768x25519")
    throw new HttpError(422, "key_not_pq_age")
  const now = Date.now()
  const r = await c.env.DB.prepare(
    `UPDATE pairings SET user_id = ?, key_ciphertext = ?
     WHERE id = ? AND user_id IS NULL AND expires_at > ?`,
  )
    .bind(c.get("userId"), bytes, id, now)
    .run()
  if (!r.meta.changes) {
    const seen = await c.env.DB.prepare(`SELECT 1 AS x FROM pairings WHERE ${VISIBLE}`)
      .bind(id, now, c.get("userId"))
      .first()
    throw seen ? new HttpError(409, "pairing_used") : new HttpError(404, "pairing_not_found")
  }
  return c.json({ ok: true })
})

sessionRoutes.post("/pairings/:id/reject", async (c) => {
  await c.env.DB.prepare(`DELETE FROM pairings WHERE ${VISIBLE}`)
    .bind(idParam(c, "pairing"), Date.now(), c.get("userId"))
    .run()
  return c.json({ ok: true })
})

sessionRoutes.get("/devices", async (c) => {
  const uid = c.get("userId")
  const now = Date.now()
  await c.env.DB.prepare(
    `DELETE FROM devices WHERE user_id = ?1 AND
     (expires_at < ?2 OR (revoked_at IS NOT NULL AND revoked_at < ?2))`,
  )
    .bind(uid, now - KEEP_ENDED_MS)
    .run()
  const rows = await c.env.DB.prepare(
    `SELECT id, user_id, temporary, agent, place, created_at, last_seen_at, expires_at, revoked_at
     FROM devices WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
     ORDER BY last_seen_at DESC`,
  )
    .bind(uid, now)
    .all<DeviceDb>()
  return c.json(rows.results.map((r) => deviceOut(r, c.get("device")?.id)))
})

// Signs a device out. A temporary device may only sign itself out.
sessionRoutes.delete("/devices/:id", async (c) => {
  const id = idParam(c, "device")
  if (id !== c.get("device")?.id) notTemporary(c)
  const r = await c.env.DB.prepare(
    "UPDATE devices SET revoked_at = ? WHERE user_id = ? AND id = ? AND revoked_at IS NULL",
  )
    .bind(Date.now(), c.get("userId"), id)
    .run()
  if (!r.meta.changes) throw new HttpError(404, "device_not_found")
  return c.json({ ok: true })
})
