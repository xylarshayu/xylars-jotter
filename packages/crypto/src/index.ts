/**
 * Thin, opinionated wrapper around typage (age-encryption).
 *
 * Everything the app stores is an age file. Asymmetric encryption only ever
 * targets hybrid ML-KEM-768 + X25519 recipients (`age1pq1…`); this module
 * refuses classic X25519 recipients so content can never be encrypted to a
 * pre-quantum key by accident.
 */
import { Decrypter, Encrypter, generateHybridIdentity, identityToRecipient } from "age-encryption"

export type AgeIdentity = string
export type AgeRecipient = string

export interface KeyPair {
  identity: AgeIdentity
  recipient: AgeRecipient
}

const HYBRID_RECIPIENT = /^age1pq1[02-9ac-hj-np-z]+$/
const HYBRID_IDENTITY = /^AGE-SECRET-KEY-PQ-1[02-9AC-HJ-NP-Z]+$/

/** Default scrypt work factor for passphrase-wrapped identities (age default). */
export const DEFAULT_SCRYPT_LOG_N = 18

export class CryptoError extends Error {
  override name = "CryptoError"
}

export function isHybridRecipient(r: string): boolean {
  return HYBRID_RECIPIENT.test(r)
}

export function isHybridIdentity(i: string): boolean {
  return HYBRID_IDENTITY.test(i.trim())
}

export function assertHybridRecipient(r: string): asserts r is AgeRecipient {
  if (!isHybridRecipient(r)) throw new CryptoError("refusing non post-quantum recipient")
}

export function assertHybridIdentity(i: string): asserts i is AgeIdentity {
  if (!isHybridIdentity(i)) throw new CryptoError("expected a hybrid AGE-SECRET-KEY-PQ-1 identity")
}

/** Generates a fresh hybrid ML-KEM-768 + X25519 key pair. */
export async function generateKeyPair(): Promise<KeyPair> {
  const identity = await generateHybridIdentity()
  return { identity, recipient: await identityToRecipient(identity) }
}

export async function recipientOf(identity: AgeIdentity): Promise<AgeRecipient> {
  assertHybridIdentity(identity)
  return identityToRecipient(identity.trim())
}

/** Encrypts to one or more hybrid recipients. Returns a binary age file. */
export async function encryptTo(
  recipients: AgeRecipient | AgeRecipient[],
  data: Uint8Array | string,
): Promise<Uint8Array> {
  const list = Array.isArray(recipients) ? recipients : [recipients]
  if (list.length === 0) throw new CryptoError("no recipients")
  const e = new Encrypter()
  for (const r of list) {
    assertHybridRecipient(r)
    e.addRecipient(r)
  }
  return e.encrypt(data)
}

export async function decryptWith(identity: AgeIdentity, file: Uint8Array): Promise<Uint8Array> {
  assertHybridIdentity(identity)
  const d = new Decrypter()
  d.addIdentity(identity.trim())
  return d.decrypt(file)
}

export async function decryptTextWith(identity: AgeIdentity, file: Uint8Array): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
    await decryptWith(identity, file),
  )
}

/**
 * Wraps an identity with a passphrase (age scrypt recipient). The result is a
 * standard "passphrase-encrypted identity file": `age -d -i wrapped.age x.age`
 * works with the Go CLI.
 */
export async function wrapWithPassphrase(
  identity: AgeIdentity,
  passphrase: string,
  logN: number = DEFAULT_SCRYPT_LOG_N,
): Promise<Uint8Array> {
  assertHybridIdentity(identity)
  if (passphrase.length === 0) throw new CryptoError("empty passphrase")
  const e = new Encrypter()
  e.setPassphrase(passphrase)
  e.setScryptWorkFactor(logN)
  return e.encrypt(identity.trim() + "\n")
}

/** Unwraps a passphrase-wrapped identity. Throws CryptoError on a wrong passphrase. */
export async function unwrapWithPassphrase(
  wrapped: Uint8Array,
  passphrase: string,
): Promise<AgeIdentity> {
  const d = new Decrypter()
  d.addPassphrase(passphrase)
  let text: string
  try {
    text = new TextDecoder().decode(await d.decrypt(wrapped))
  } catch {
    // Never echo the passphrase or the underlying message.
    throw new CryptoError("wrong passphrase or corrupted key")
  }
  return parseIdentity(text)
}

/** Wraps an identity for another hybrid recipient (e.g. the account open key). */
export async function wrapForRecipient(
  identity: AgeIdentity,
  recipient: AgeRecipient,
): Promise<Uint8Array> {
  assertHybridIdentity(identity)
  return encryptTo(recipient, identity.trim() + "\n")
}

export async function unwrapWithIdentity(
  wrapped: Uint8Array,
  identity: AgeIdentity,
): Promise<AgeIdentity> {
  return parseIdentity(await decryptTextWith(identity, wrapped))
}

/** Extracts the single hybrid identity from identity-file text (comments allowed). */
export function parseIdentity(text: string): AgeIdentity {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
  const [first] = lines
  if (lines.length !== 1 || first === undefined)
    throw new CryptoError("expected exactly one identity")
  assertHybridIdentity(first)
  return first
}

/** Lists the stanza types in an age file header, e.g. ["mlkem768x25519"] or ["scrypt"]. */
export function stanzaTypes(file: Uint8Array): string[] {
  const head = new TextDecoder().decode(file.subarray(0, Math.min(file.length, 64 * 1024)))
  const lines = head.split("\n")
  if (lines[0] !== "age-encryption.org/v1") throw new CryptoError("not an age file")
  const types: string[] = []
  for (const line of lines.slice(1)) {
    if (line.startsWith("---")) break
    if (line.startsWith("-> ")) types.push(line.slice(3).split(" ")[0] ?? "")
  }
  return types
}

/** True if the file can only be opened with a passphrase. */
export function isPassphraseWrapped(file: Uint8Array): boolean {
  const t = stanzaTypes(file)
  return t.length === 1 && t[0] === "scrypt"
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}

export function toBase64(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
