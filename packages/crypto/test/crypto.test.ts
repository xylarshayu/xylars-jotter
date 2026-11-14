import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  CryptoError,
  decryptTextWith,
  decryptWith,
  encryptTo,
  generateKeyPair,
  isPassphraseWrapped,
  parseIdentity,
  recipientOf,
  sha256Hex,
  stanzaTypes,
  unwrapWithIdentity,
  unwrapWithPassphrase,
  wrapForRecipient,
  wrapWithPassphrase,
  fromBase64,
  toBase64,
} from "../src/index.ts"

const fx = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name))
const SYNTHETIC_PASSPHRASE = "synthetic-passphrase-for-tests-only"

describe("key pairs", () => {
  it("generates hybrid post-quantum keys", async () => {
    const kp = await generateKeyPair()
    expect(kp.identity).toMatch(/^AGE-SECRET-KEY-PQ-1/)
    expect(kp.recipient).toMatch(/^age1pq1/)
    expect(await recipientOf(kp.identity)).toBe(kp.recipient)
  })

  it("refuses classic X25519 recipients", async () => {
    const classic = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"
    await expect(encryptTo(classic, "x")).rejects.toThrow(CryptoError)
  })
})

describe("round trips", () => {
  it("encrypts and decrypts to a hybrid recipient", async () => {
    const kp = await generateKeyPair()
    const ct = await encryptTo(kp.recipient, "synthetic note ✓")
    expect(stanzaTypes(ct)).toEqual(["mlkem768x25519"])
    expect(await decryptTextWith(kp.identity, ct)).toBe("synthetic note ✓")
  })

  it("fails to decrypt with the wrong identity", async () => {
    const a = await generateKeyPair()
    const b = await generateKeyPair()
    const ct = await encryptTo(a.recipient, "synthetic")
    await expect(decryptWith(b.identity, ct)).rejects.toThrow()
  })

  it("wraps identities for a recipient", async () => {
    const open = await generateKeyPair()
    const channel = await generateKeyPair()
    const wrapped = await wrapForRecipient(channel.identity, open.recipient)
    expect(isPassphraseWrapped(wrapped)).toBe(false)
    expect(await unwrapWithIdentity(wrapped, open.identity)).toBe(channel.identity)
  })

  it("wraps identities with a passphrase", async () => {
    const channel = await generateKeyPair()
    const wrapped = await wrapWithPassphrase(channel.identity, SYNTHETIC_PASSPHRASE, 10)
    expect(isPassphraseWrapped(wrapped)).toBe(true)
    expect(await unwrapWithPassphrase(wrapped, SYNTHETIC_PASSPHRASE)).toBe(channel.identity)
  })

  it("rejects a wrong passphrase without echoing it", async () => {
    const channel = await generateKeyPair()
    const wrapped = await wrapWithPassphrase(channel.identity, SYNTHETIC_PASSPHRASE, 10)
    const err = await unwrapWithPassphrase(wrapped, "wrong-synthetic").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CryptoError)
    expect(String(err)).not.toContain("wrong-synthetic")
  })
})

describe("Go age test vectors", () => {
  const identityText = fx("synthetic-identity.txt").toString()
  const identity = parseIdentity(identityText)

  it("parses identity files with comments", async () => {
    expect(await recipientOf(identity)).toBe(fx("synthetic-recipient.txt").toString().trim())
  })

  it("decrypts a hybrid file produced by Go age", async () => {
    const pt = await decryptWith(identity, fx("vector-hybrid.age"))
    expect(Buffer.from(pt).equals(fx("vector-plaintext.txt"))).toBe(true)
  })

  it("unwraps a passphrase-encrypted identity file produced by Go age", async () => {
    expect(
      await unwrapWithPassphrase(fx("vector-wrapped-identity.age"), SYNTHETIC_PASSPHRASE),
    ).toBe(identity)
  })
})

describe("helpers", () => {
  it("hashes", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })
  it("round-trips base64", () => {
    const b = new Uint8Array(70000).map((_, i) => i % 251)
    expect(fromBase64(toBase64(b))).toEqual(b)
  })
})
