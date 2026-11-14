/**
 * Wire types shared by the Worker, the web app and the CLI.
 *
 * Binary fields (age files) travel as base64 strings. Timestamps are Unix ms.
 * The only plaintext metadata is ids, timestamps, sizes, versions and a
 * channel's lock kind (brief, invariant 1).
 */
import { z } from "zod"

export const LOCK_KINDS = ["open", "locked"] as const
export type LockKind = (typeof LOCK_KINDS)[number]

/** Fail closed: anything that is not exactly "open" is treated as locked. */
export function normalizeLock(value: unknown): LockKind {
  return value === "open" ? "open" : "locked"
}

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "expected a ULID")
// Checked where it is decoded (the Worker answers 422 invalid_base64), not by a regex over every
// byte of a large payload.
const b64 = z.string()
const recipient = z
  .string()
  .regex(/^age1pq1[02-9ac-hj-np-z]+$/, "expected a hybrid age1pq1 recipient")
const ms = z.number().int().nonnegative()

export const MAX_NOTE_BYTES = 256 * 1024
export const MAX_PREVIEW_BYTES = 512 * 1024
/**
 * Attachments of any type (ADR-0017). One upload is one request, and Workers accept request bodies
 * up to 100 MB, so the ciphertext stays under that with room to spare.
 */
export const MAX_ATTACHMENT_BYTES = 95 * 1024 * 1024
/** The largest file that still fits once encrypted (age adds 16 bytes per 64 KiB plus a header). */
export const MAX_ATTACHMENT_PLAIN_BYTES = MAX_ATTACHMENT_BYTES - 256 * 1024
/** A name sealed to two hybrid recipients is about 3.3 KB before the name itself. */
export const MAX_NAME_BYTES = 8 * 1024

export const ChannelRow = z.object({
  id,
  lock: z.unknown().transform(normalizeLock),
  recipient,
  wrappedKey: b64,
  name: b64,
  createdAt: ms,
  updatedAt: ms,
  deletedAt: ms.nullable(),
  seq: z.number().int(),
})
export type ChannelRow = z.output<typeof ChannelRow>

export const NoteRow = z.object({
  id,
  channelId: id,
  version: z.number().int().positive(),
  body: b64,
  preview: b64.nullable(),
  size: z.number().int().nonnegative(),
  createdAt: ms,
  updatedAt: ms,
  deletedAt: ms.nullable(),
  seq: z.number().int(),
})
export type NoteRow = z.output<typeof NoteRow>

export const SyncPage = z.object({
  channels: z.array(ChannelRow),
  notes: z.array(NoteRow),
  cursor: z.number().int().nonnegative(),
  more: z.boolean(),
  /** Asked for with `count`: notes changed after `since`, this page included. */
  remaining: z.number().int().nonnegative().optional(),
})
export type SyncPage = z.output<typeof SyncPage>

export const CreateChannel = z.object({
  id,
  lock: z.enum(LOCK_KINDS),
  recipient,
  wrappedKey: b64,
  name: b64,
})
export type CreateChannel = z.output<typeof CreateChannel>

export const UpdateChannel = z.object({ name: b64.optional(), wrappedKey: b64.optional() })
export type UpdateChannel = z.output<typeof UpdateChannel>

export const CreateNote = z.object({
  id,
  channelId: id,
  body: b64,
  preview: b64.nullable().optional(),
  createdAt: ms.optional(),
  sourceHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
})
export type CreateNote = z.output<typeof CreateNote>

export const UpdateNote = z.object({
  baseVersion: z.number().int().positive(),
  body: b64,
  channelId: id.optional(),
  /** Drop stored history and preview (required when moving into a locked channel). */
  purgeHistory: z.boolean().optional(),
  preview: b64.nullable().optional(),
})
export type UpdateNote = z.output<typeof UpdateNote>

export const UpdatePreview = z.object({ preview: b64.nullable() })

export const NoteVersion = z.object({
  version: z.number().int(),
  channelId: id,
  body: b64,
  createdAt: ms,
})
export type NoteVersion = z.output<typeof NoteVersion>

export const AttachmentInfo = z.object({ id, channelId: id, size: z.number().int(), createdAt: ms })
export type AttachmentInfo = z.output<typeof AttachmentInfo>

/* ---------- Store copy (jot migrate): ciphertext rows exactly as stored ---------- */

export const DumpNote = NoteRow.extend({
  sourceHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
})
export type DumpNote = z.output<typeof DumpNote>

export const DumpVersion = z.object({
  noteId: id,
  version: z.number().int().positive(),
  channelId: id,
  body: b64,
  createdAt: ms,
})
export type DumpVersion = z.output<typeof DumpVersion>

export const DUMP_TABLES = ["channels", "notes", "versions", "attachments"] as const
export type DumpTable = (typeof DUMP_TABLES)[number]
export const DumpRows = {
  channels: ChannelRow,
  notes: DumpNote,
  versions: DumpVersion,
  attachments: AttachmentInfo,
} as const
export type DumpRow<T extends DumpTable> = z.output<(typeof DumpRows)[T]>

export const MAX_RESTORE_ROWS = 200
export const RestoreBatch = z.object({
  channels: z.array(ChannelRow).default([]),
  notes: z.array(DumpNote).default([]),
  versions: z.array(DumpVersion).default([]),
})
export type RestoreBatch = z.input<typeof RestoreBatch>

export const Unfurl = z.object({
  url: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  site: z.string().optional(),
  image: z.string().optional(),
})
export type Unfurl = z.output<typeof Unfurl>

export const CreateResult = z.object({ note: NoteRow, duplicate: z.boolean() })

/* ---------- Device pairing and sessions (ADR-0016, ADR-0019) ---------- */

/** A pairing lasts this long, then the Worker deletes it. */
export const PAIRING_TTL_MS = 5 * 60_000
/** Pairings in progress, across everyone: bounds what an unauthenticated caller can store. */
export const MAX_PENDING_PAIRINGS = 100
/** Pairings in progress from one IP address (one /64 for IPv6). */
export const MAX_PAIRINGS_PER_SOURCE = 3
/** The open key sealed to one hybrid recipient is about 1.7 KB. */
export const MAX_PAIRING_KEY_BYTES = 8 * 1024
export const PAIRING_ID_RE = /^[A-Za-z0-9_-]{22}$/
/** A device session ends after this long unused (sliding), or when revoked. */
export const DEVICE_IDLE_MS = 30 * 24 * 3600_000
/** A temporary device's session: 1 hour unused, 12 hours at most. Its tab forgets it sooner. */
export const TEMPORARY_IDLE_MS = 3600_000
export const TEMPORARY_MAX_MS = 12 * 3600_000

const pairingId = z.string().regex(PAIRING_ID_RE)
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
/** The new device's one-time public key. Never the open key. */
const pairingRecipient = recipient.max(4096)

/** Unauthenticated: a new device asks to be paired. */
export const StartPairing = z.object({ recipient: pairingRecipient, temporary: z.boolean() })
/** `secret` goes only to the new device; the QR carries the id. */
export const PairingStarted = z.object({ id: pairingId, secret, expiresAt: ms })
export const ClaimPairing = z.object({ secret })
export const DeviceRow = z.object({
  id: z.string(),
  temporary: z.boolean(),
  agent: z.string(),
  place: z.string(),
  createdAt: ms,
  lastSeenAt: ms,
  expiresAt: ms,
  /** The device making the request. */
  current: z.boolean(),
})
export type DeviceRow = z.output<typeof DeviceRow>
export const PairingClaimed = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.literal("ready"),
    /** The open key, sealed to the pairing's recipient. */
    key: b64,
    /** Bearer token for /device-api. Shown once; the Worker keeps only its hash. */
    token: z.string(),
    device: DeviceRow,
  }),
])
export type PairingClaimed = z.output<typeof PairingClaimed>
/** What a signed-in device sees before approving. */
export const Pairing = z.object({
  id: pairingId,
  recipient: pairingRecipient,
  temporary: z.boolean(),
  agent: z.string(),
  place: z.string(),
  expiresAt: ms,
  approved: z.boolean(),
})
export type Pairing = z.output<typeof Pairing>
/** The open key, as an age file sealed to the pairing's recipient. */
export const ApprovePairing = z.object({ key: b64 })
export const Me = z.object({
  userId: z.string(),
  /** Set when the request came with a device session rather than through Access. */
  device: z.object({ id: z.string(), temporary: z.boolean() }).nullable(),
})
export type Me = z.output<typeof Me>

/* ---------- Encrypted payloads (plaintext shapes, only ever inside age files) ---------- */

export const AttachmentRef = z.object({
  id,
  mime: z.string(),
  size: z.number().int().nonnegative(),
  name: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
})
export type AttachmentRef = z.output<typeof AttachmentRef>

export const NoteBody = z.object({
  v: z.literal(1),
  text: z.string(),
  links: z.array(z.string()).default([]),
  attachments: z.array(AttachmentRef).default([]),
})
export type NoteBody = z.output<typeof NoteBody>

export const PreviewItem = Unfurl
export type PreviewItem = Unfurl

export const PreviewBody = z.object({ v: z.literal(1), items: z.array(PreviewItem) })
export type PreviewBody = z.output<typeof PreviewBody>
