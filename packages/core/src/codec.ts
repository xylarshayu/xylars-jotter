/** Encrypts and decrypts the payloads stored on the server. All payloads are age files. */
import {
  type AgeIdentity,
  type AgeRecipient,
  decryptTextWith,
  encryptTo,
  fromBase64,
  generateKeyPair,
  toBase64,
  wrapForRecipient,
  wrapWithPassphrase,
} from "@jot/crypto"
import { type CreateChannel, NoteBody, PreviewBody, type LockKind } from "./model.ts"
import { newId } from "./ids.ts"

export async function sealJson(recipient: AgeRecipient, value: unknown): Promise<string> {
  return toBase64(await encryptTo(recipient, JSON.stringify(value)))
}

export async function sealText(
  recipients: AgeRecipient | AgeRecipient[],
  text: string,
): Promise<string> {
  return toBase64(await encryptTo(recipients, text))
}

export async function openText(identity: AgeIdentity, b64: string): Promise<string> {
  return decryptTextWith(identity, fromBase64(b64))
}

/**
 * Seals a channel name to the channel's own recipient and, when given, to the account open key,
 * so every device and agent with the open key can read it (ADR-0014).
 */
export async function sealChannelName(
  recipient: AgeRecipient,
  openRecipient: AgeRecipient | undefined,
  name: string,
): Promise<string> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error("channel name is required")
  return sealText(openRecipient ? [recipient, openRecipient] : recipient, trimmed)
}

export async function sealNoteBody(recipient: AgeRecipient, body: NoteBody): Promise<string> {
  return sealJson(recipient, NoteBody.parse(body))
}

export async function openNoteBody(identity: AgeIdentity, b64: string): Promise<NoteBody> {
  return NoteBody.parse(JSON.parse(await openText(identity, b64)))
}

export async function sealPreview(recipient: AgeRecipient, body: PreviewBody): Promise<string> {
  return sealJson(recipient, PreviewBody.parse(body))
}

export async function openPreview(identity: AgeIdentity, b64: string): Promise<PreviewBody> {
  return PreviewBody.parse(JSON.parse(await openText(identity, b64)))
}

export interface NewChannelOptions {
  name: string
  lock: LockKind
  /** Required for open channels: the account open key's recipient. Also seals the name. */
  openRecipient?: AgeRecipient | undefined
  /** Required for locked channels. Used once to wrap the key, never stored. */
  passphrase?: string
  scryptLogN?: number
}

/** Builds a create-channel request with a fresh hybrid channel key. */
export async function newChannel(
  opts: NewChannelOptions,
): Promise<{ request: CreateChannel; identity: AgeIdentity }> {
  const name = opts.name.trim()
  if (!name) throw new Error("channel name is required")
  const kp = await generateKeyPair()
  let wrapped: Uint8Array
  if (opts.lock === "open") {
    if (!opts.openRecipient) throw new Error("open channels need the open key")
    wrapped = await wrapForRecipient(kp.identity, opts.openRecipient)
  } else {
    if (!opts.passphrase) throw new Error("locked channels need a passphrase")
    wrapped = await wrapWithPassphrase(kp.identity, opts.passphrase, opts.scryptLogN)
  }
  return {
    identity: kp.identity,
    request: {
      id: newId(),
      lock: opts.lock,
      recipient: kp.recipient,
      wrappedKey: toBase64(wrapped),
      name: await sealChannelName(kp.recipient, opts.openRecipient, name),
    },
  }
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi

/** Extracts http(s) links from text, trimming trailing punctuation. */
export function extractLinks(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(URL_RE)) {
    let u = m[0].replace(/[.,;:!?]+$/, "")
    // Drop an unbalanced closing paren, common in prose: "(see https://x.y/z)".
    while (u.endsWith(")") && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0))
      u = u.slice(0, -1)
    try {
      out.add(new URL(u).toString())
    } catch {
      /* not a URL */
    }
  }
  return [...out]
}
