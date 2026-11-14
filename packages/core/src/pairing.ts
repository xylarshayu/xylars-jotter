/**
 * Device pairing (ADR-0016, ADR-0019). The new device makes a one-time key pair, registers the
 * public half with the Worker (no sign-in needed) and shows a QR holding the pairing id and a hash
 * of that public key. A signed-in device that has the open key checks the hash against what the
 * Worker returns, shows a code to compare with the new device's screen and where the new device
 * is, then approves: it seals the open key to the one-time key. The new device claims that, with
 * a secret the QR doesn't carry, together with a device session. The Worker only relays an age
 * file it can't open, and can't swap the key without the hash failing.
 */
import {
  type AgeIdentity,
  decryptTextWith,
  encryptTo,
  fromBase64,
  generateKeyPair,
  isHybridIdentity,
  parseIdentity,
  toBase64,
} from "@jot/crypto"
import type { Api } from "./api.ts"
import type { DeviceRow } from "./model.ts"

export class PairingError extends Error {
  override name = "PairingError"
  constructor(readonly code: "bad_link" | "mismatch" | "bad_key") {
    super(`pairing: ${code}`)
  }
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
}

function b64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** What the QR commits to: SHA-256 of the one-time recipient, base64url (43 chars). */
export async function pairingCommit(recipient: string): Promise<string> {
  return b64url(await sha256(recipient))
}

/** Six digits both screens show, e.g. "042 917". Derived from the id and the one-time key. */
export async function pairingCode(id: string, recipient: string): Promise<string> {
  const h = await sha256(`jot-pair-v1\n${id}\n${recipient}`)
  const n = new DataView(h.buffer, h.byteOffset, 4).getUint32(0) % 1_000_000
  const s = n.toString().padStart(6, "0")
  return `${s.slice(0, 3)} ${s.slice(3)}`
}

const LINK_RE = /#\/pair\/([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/

/** The QR's content: a link into the app, so a phone camera can open it too. */
export function pairingLink(origin: string, id: string, commit: string): string {
  return `${origin.replace(/\/$/, "")}/#/pair/${id}.${commit}`
}

/** Accepts a full pairing link or just its `#/pair/…` part. */
export function parsePairingLink(text: string): { id: string; commit: string } | null {
  const m = LINK_RE.exec(text.trim())
  return m ? { id: m[1]!, commit: m[2]! } : null
}

/* ------------------------- the new device ------------------------- */

export interface PairingRequest {
  id: string
  /** Proves to the Worker that this is the device that started the pairing. Memory only. */
  secret: string
  /** One-time identity. Memory only; dropped once the key arrives or the pairing ends. */
  identity: AgeIdentity
  recipient: string
  temporary: boolean
  expiresAt: number
  link: string
  code: string
}

export async function startPairing(
  api: Api,
  origin: string,
  opts: { temporary: boolean },
): Promise<PairingRequest> {
  const kp = await generateKeyPair()
  const p = await api.startPairing(kp.recipient, opts.temporary)
  return {
    id: p.id,
    secret: p.secret,
    identity: kp.identity,
    recipient: kp.recipient,
    temporary: opts.temporary,
    expiresAt: p.expiresAt,
    link: pairingLink(origin, p.id, await pairingCommit(kp.recipient)),
    code: await pairingCode(p.id, kp.recipient),
  }
}

export interface Paired {
  /** The open key. */
  key: string
  /** The device session's bearer token. */
  token: string
  device: DeviceRow
}

/** Null until a signed-in device approves; then the open key and a session, handed out once. */
export async function receivePairing(api: Api, req: PairingRequest): Promise<Paired | null> {
  const r = await api.claimPairing(req.id, req.secret)
  if (r.status === "pending") return null
  let key: string
  try {
    key = parseIdentity(await decryptTextWith(req.identity, fromBase64(r.key)))
  } catch {
    throw new PairingError("bad_key")
  }
  if (!isHybridIdentity(key)) throw new PairingError("bad_key")
  return { key, token: r.token, device: r.device }
}

/* ------------------------ the signed-in device ---------------------- */

export interface PairingOffer {
  id: string
  recipient: string
  code: string
  expiresAt: number
  approved: boolean
  temporary: boolean
  /** What the Worker saw of the new device, e.g. "Chrome on macOS" and "Pune, IN". */
  agent: string
  place: string
}

/** Fetches the pairing a QR points at and checks the one-time key against the QR's hash. */
export async function checkPairing(api: Api, link: string): Promise<PairingOffer> {
  const parsed = parsePairingLink(link)
  if (!parsed) throw new PairingError("bad_link")
  const p = await api.getPairing(parsed.id)
  if ((await pairingCommit(p.recipient)) !== parsed.commit) throw new PairingError("mismatch")
  return {
    id: p.id,
    recipient: p.recipient,
    code: await pairingCode(p.id, p.recipient),
    expiresAt: p.expiresAt,
    approved: p.approved,
    temporary: p.temporary,
    agent: p.agent,
    place: p.place,
  }
}

/**
 * Signs the new device in: seals the open key to its one-time key (hybrid PQ age) and approves
 * the pairing with it.
 */
export async function approvePairing(
  api: Api,
  offer: Pick<PairingOffer, "id" | "recipient">,
  openIdentity: AgeIdentity,
): Promise<void> {
  await api.approvePairing(
    offer.id,
    toBase64(await encryptTo(offer.recipient, openIdentity.trim())),
  )
}
