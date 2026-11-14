/**
 * Interop with the Go reference implementation (age v1.3+), both directions.
 * Skipped when the `age` binary is missing, unless REQUIRE_AGE_INTEROP=1 (CI).
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  decryptTextWith,
  encryptTo,
  generateKeyPair,
  parseIdentity,
  recipientOf,
  unwrapWithPassphrase,
  wrapWithPassphrase,
} from "../src/index.ts"

function findAge(): string | undefined {
  const candidates = [process.env.AGE_BIN, join(homedir(), "go", "bin", "age")]
  for (const c of candidates) if (c && existsSync(c)) return c
  try {
    return execFileSync("which", ["age"], { encoding: "utf8" }).trim() || undefined
  } catch {
    return undefined
  }
}

const AGE = findAge()
if (!AGE && process.env.REQUIRE_AGE_INTEROP === "1")
  throw new Error("age binary required but not found")
const ageBinDir = AGE ? AGE.slice(0, AGE.lastIndexOf("/")) : ""
const dir = mkdtempSync(join(tmpdir(), "jot-interop-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const PASS = "synthetic-passphrase-for-tests-only"

function age(
  args: string[],
  input?: Uint8Array | string,
  env: Record<string, string> = {},
): Buffer {
  return execFileSync(AGE!, args, {
    input,
    env: { ...process.env, PATH: `${ageBinDir}:${process.env.PATH}`, ...env },
  })
}

describe.skipIf(!AGE)("interop with Go age", () => {
  it("Go age reports v1.3+", () => {
    const v = age(["--version"]).toString().trim()
    const [maj, min] = v.replace(/^v/, "").split(".").map(Number)
    expect(maj! > 1 || (maj === 1 && min! >= 3)).toBe(true)
  })

  it("TS encrypts → Go decrypts (hybrid)", async () => {
    const kp = await generateKeyPair()
    writeFileSync(join(dir, "id1.txt"), kp.identity + "\n")
    const ct = await encryptTo(kp.recipient, "synthetic TS→Go ✓")
    expect(age(["-d", "-i", join(dir, "id1.txt")], ct).toString()).toBe("synthetic TS→Go ✓")
  })

  it("Go encrypts → TS decrypts (hybrid, Go-generated key)", async () => {
    execFileSync(join(ageBinDir, "age-keygen"), ["-pq", "-o", join(dir, "id2.txt")], {
      stdio: "ignore",
    })
    const identity = parseIdentity(readFileSync(join(dir, "id2.txt"), "utf8"))
    const recipient = await recipientOf(identity)
    const ct = age(["-r", recipient], "synthetic Go→TS ✓")
    expect(await decryptTextWith(identity, ct)).toBe("synthetic Go→TS ✓")
  })

  it("TS passphrase-wrapped identity works as a Go passphrase-encrypted identity file", async () => {
    const kp = await generateKeyPair()
    const wrapped = await wrapWithPassphrase(kp.identity, PASS, 10)
    writeFileSync(join(dir, "wrapped.age"), wrapped)
    const ct = await encryptTo(kp.recipient, "synthetic locked note")
    // Unwrap with Go (batchpass plugin reads AGE_PASSPHRASE), then decrypt with the result.
    const idText = age(["-d", "-j", "batchpass"], wrapped, { AGE_PASSPHRASE: PASS }).toString()
    expect(parseIdentity(idText)).toBe(kp.identity)
    writeFileSync(join(dir, "id3.txt"), idText)
    expect(age(["-d", "-i", join(dir, "id3.txt")], ct).toString()).toBe("synthetic locked note")
  })

  it("Go passphrase-wrapped identity unwraps in TS", async () => {
    const kp = await generateKeyPair()
    const wrapped = age(["-e", "-j", "batchpass"], kp.identity + "\n", {
      AGE_PASSPHRASE: PASS,
      AGE_PASSPHRASE_WORK_FACTOR: "10",
    })
    expect(await unwrapWithPassphrase(wrapped, PASS)).toBe(kp.identity)
  })
})
