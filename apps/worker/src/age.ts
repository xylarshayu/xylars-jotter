/**
 * Server-side sanity checks on ciphertext. The server can't decrypt anything;
 * it only refuses payloads that aren't age files, or that are encrypted to a
 * non post-quantum recipient (brief invariants 1 and 5).
 */
const MAGIC = "age-encryption.org/v1\n"

export function stanzaTypes(bytes: Uint8Array): string[] | null {
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 16 * 1024)))
  if (!head.startsWith(MAGIC)) return null
  const types: string[] = []
  for (const line of head.slice(MAGIC.length).split("\n")) {
    if (line.startsWith("---")) return types
    if (line.startsWith("-> ")) types.push(line.slice(3).split(" ")[0] ?? "")
  }
  return null // no header terminator: not a well-formed age header
}

/** Content must be encrypted to hybrid ML-KEM-768 + X25519 recipients only. */
export function isHybridAgeFile(bytes: Uint8Array): boolean {
  const t = stanzaTypes(bytes)
  return t !== null && t.length > 0 && t.every((s) => s === "mlkem768x25519")
}

/** A locked channel's key must be wrapped by exactly one scrypt (passphrase) stanza. */
export function isPassphraseAgeFile(bytes: Uint8Array): boolean {
  const t = stanzaTypes(bytes)
  return t !== null && t.length === 1 && t[0] === "scrypt"
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function b64encode(bytes: Uint8Array | ArrayBuffer | null): string {
  if (bytes === null) return ""
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ""
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
