import { env, SELF } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption"
import {
  Api,
  ApiError,
  approvePairing,
  type ChannelRow,
  type DumpRow,
  type DumpTable,
  checkPairing,
  LockedError,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_PLAIN_BYTES,
  MAX_NOTE_BYTES,
  MAX_PENDING_PAIRINGS,
  Notebook,
  type NoteRow,
  newChannel,
  newId,
  PairingError,
  pairingCode,
  receivePairing,
  sealNoteBody,
  startPairing,
} from "@jot/core"
import { PAGE_BYTES } from "../src/api.ts"
import { agentOf, sourceOf } from "../src/sessions.ts"
import { CryptoError, encryptTo, generateKeyPair, toBase64 } from "@jot/crypto"

// Synthetic data only. Low scrypt work factor keeps tests fast.
const PASS = "synthetic-passphrase-for-tests-only"
const LOG_N = 10

const api = (session?: string) =>
  new Api({
    baseUrl: "http://localhost",
    fetch: (input, init) => SELF.fetch(input as string, init),
    session: () => session,
  })

async function notebook() {
  const open = await generateKeyPair()
  const nb = new Notebook({ api: api() })
  await nb.keys.setOpenKey(open.identity)
  return { nb, open }
}

async function raw(path: string, init: RequestInit = {}, host = "localhost") {
  const headers = new Headers(init.headers)
  if (typeof init.body === "string") headers.set("content-type", "application/json")
  return SELF.fetch(`http://${host}${path}`, { ...init, headers })
}

describe("auth", () => {
  it("dev auth only works on localhost", async () => {
    expect((await raw("/api/me")).status).toBe(200)
    const res = await raw("/api/me", {}, "notes.example.com")
    expect(res.status).toBe(403)
  })
})

describe("channels", () => {
  it("creates open channels and decrypts their names after sync", async () => {
    const { nb, open } = await notebook()
    await nb.createChannel({ name: "Inbox", lock: "open" })
    const fresh = new Notebook({ api: api() })
    await fresh.keys.setOpenKey(open.identity)
    await fresh.sync()
    const views = await fresh.channelViews()
    expect(views.map((v) => [v.name, v.lock, v.readable])).toContainEqual(["Inbox", "open", true])
  })

  it("rejects an open channel whose key is passphrase-wrapped, and vice versa", async () => {
    const { request } = await newChannel({
      name: "x",
      lock: "locked",
      passphrase: PASS,
      scryptLogN: LOG_N,
    })
    const asOpen = await raw("/api/channels", {
      method: "POST",
      body: JSON.stringify({ ...request, lock: "open" }),
    })
    expect(asOpen.status).toBe(422)
    const open = await generateKeyPair()
    const o = await newChannel({ name: "y", lock: "open", openRecipient: open.recipient })
    const asLocked = await raw("/api/channels", {
      method: "POST",
      body: JSON.stringify({ ...o.request, lock: "locked" }),
    })
    expect(asLocked.status).toBe(422)
  })

  it("treats an unknown lock kind as locked (fail closed)", async () => {
    const { nb, open } = await notebook()
    const row = await nb.createChannel({ name: "Inbox", lock: "open" })
    const forged = new Notebook({ api: api() })
    await forged.keys.setOpenKey(open.identity)
    forged.replica.apply({ channels: [{ ...row, lock: "locked" }], notes: [] })
    const [view] = await forged.channelViews()
    expect(view!.readable).toBe(false)
    // Names are sealed to the open key as well (ADR-0014); the content stays unreadable.
    expect(view!.name).toBe("Inbox")
    expect(await forged.notes(row.id)).toEqual([])
  })

  it("refuses to delete a channel that still has notes", async () => {
    const { nb } = await notebook()
    const ch = await nb.createChannel({ name: "Tmp", lock: "open" })
    const note = await nb.addNote(ch.id, "synthetic")
    await expect(nb.deleteChannel(ch.id)).rejects.toMatchObject({ status: 409 })
    await nb.deleteNote(note.id)
    await nb.deleteChannel(ch.id)
    expect((await nb.channelViews()).some((v) => v.id === ch.id)).toBe(false)
  })
})

describe("ciphertext checks", () => {
  it("rejects plaintext and classic X25519 note bodies", async () => {
    const { nb } = await notebook()
    const ch = await nb.createChannel({ name: "Inbox", lock: "open" })
    const plaintext = {
      id: newId(),
      channelId: ch.id,
      body: toBase64(new TextEncoder().encode("plain text")),
    }
    expect(
      (await raw("/api/notes", { method: "POST", body: JSON.stringify(plaintext) })).status,
    ).toBe(422)

    const classic = await identityToRecipient(await generateX25519Identity())
    const e = new Encrypter()
    e.addRecipient(classic)
    const body = toBase64(await e.encrypt("synthetic"))
    const res = await raw("/api/notes", {
      method: "POST",
      body: JSON.stringify({ id: newId(), channelId: ch.id, body }),
    })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: "body_not_pq_age" })
  })

  it("rejects malformed base64, and oversized bodies before decoding them", async () => {
    const { nb } = await notebook()
    const ch = await nb.createChannel({ name: "Inbox", lock: "open" })
    const post = (body: string) =>
      raw("/api/notes", {
        method: "POST",
        body: JSON.stringify({ id: newId(), channelId: ch.id, body }),
      })

    const bad = await post("not base64!")
    expect(bad.status).toBe(422)
    expect(await bad.json()).toEqual({ error: "invalid_base64" })

    const huge = await post("A".repeat(Math.ceil(MAX_NOTE_BYTES / 3) * 4 + 4))
    expect(huge.status).toBe(413)
    expect(await huge.json()).toEqual({ error: "body_too_large" })
  })
})

describe("notes", () => {
  it("adds, edits with history, and deletes", async () => {
    const { nb } = await notebook()
    const ch = await nb.createChannel({ name: "Inbox", lock: "open" })
    const n = await nb.addNote(ch.id, "first draft https://example.com/a")
    expect(n.links).toEqual(["https://example.com/a"])
    expect(await nb.pendingCount()).toBe(0)
    await nb.editNote(n.id, "second draft")
    await nb.editNote(n.id, "third draft")
    const [view] = await nb.notes(ch.id)
    expect(view!.text).toBe("third draft")
    expect(view!.version).toBe(3)
    expect((await nb.history(n.id)).map((h) => h.text)).toEqual([
      "first draft https://example.com/a",
      "second draft",
    ])
    await nb.deleteNote(n.id)
    expect(await nb.notes(ch.id)).toEqual([])
    expect((await nb.history(n.id)).map((h) => h.text)).toContain("third draft")
  })

  it("rejects stale edits", async () => {
    const { nb } = await notebook()
    const ch = await nb.createChannel({ name: "Inbox", lock: "open" })
    const n = await nb.addNote(ch.id, "v1")
    const body = await sealNoteBody(ch.recipient, { v: 1, text: "x", links: [], attachments: [] })
    await nb.editNote(n.id, "v2")
    await expect(api().updateNote(n.id, { baseVersion: 1, body })).rejects.toMatchObject({
      status: 409,
    })
  })

  it("imports idempotently by source id", async () => {
    const { nb } = await notebook()
    const ch = await nb.createChannel({ name: "Inbox", lock: "open" })
    const createdAt = Date.parse("2024-01-02T03:04:05Z")
    await nb.addNote(ch.id, "synthetic import", { sourceId: "tg:1:42", createdAt })
    await nb.addNote(ch.id, "synthetic import", { sourceId: "tg:1:42", createdAt })
    await nb.sync()
    const notes = await nb.notes(ch.id)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.createdAt).toBe(createdAt)
  })

  it("syncs in pages", async () => {
    const { nb, open } = await notebook()
    const ch = await nb.createChannel({ name: "Inbox", lock: "open" })
    for (let i = 0; i < 7; i++) await nb.addNote(ch.id, `synthetic ${i}`)
    const reader = new Notebook({ api: api() })
    await reader.keys.setOpenKey(open.identity)
    let pages = 0
    for (;;) {
      const page = await reader.api.sync(reader.replica.cursor, 3)
      reader.replica.apply(page)
      reader.replica.cursor = page.cursor
      pages++
      if (!page.more) break
    }
    expect(pages).toBeGreaterThanOrEqual(3) // storage is shared across tests in this file
    expect(await reader.notes(ch.id)).toHaveLength(7)
  })

  it("ends a page at about PAGE_BYTES of ciphertext, never skipping or repeating a note", async () => {
    const { nb, open } = await notebook()
    const ch = await nb.createChannel({ name: "Inbox", lock: "open" })
    const big = "synthetic ".repeat(6_000) // 60 KB of text per note
    for (let i = 0; i < 8; i++) await nb.addNote(ch.id, `${i} ${big}`)
    const reader = new Notebook({ api: api() })
    await reader.keys.setOpenKey(open.identity)
    const seen: string[] = []
    for (;;) {
      const page = await reader.api.sync(reader.replica.cursor, 1000)
      const bytes = page.notes.reduce((n, r) => n + r.body.length * 0.75, 0)
      expect(bytes).toBeLessThan(PAGE_BYTES + 64 * 1024) // the budget plus at most one note
      seen.push(...page.notes.filter((r) => r.channelId === ch.id).map((r) => r.id))
      reader.replica.apply(page)
      reader.replica.cursor = page.cursor
      if (!page.more) break
    }
    expect(new Set(seen).size).toBe(8)
    expect(seen).toHaveLength(8)
    expect(await reader.notes(ch.id)).toHaveLength(8)
  })

  it("searches text and link previews, newest first", async () => {
    const { nb, open } = await notebook()
    const ch = await nb.createChannel({ name: "Inbox", lock: "open" })
    await nb.addNote(ch.id, "groceries: lemons", { createdAt: 1000 })
    const b = await nb.addNote(ch.id, "https://example.com/post", { createdAt: 2000 })
    await nb.setPreviews(b.id, [
      { url: "https://example.com/post", title: "Café Kinetics", site: "Example" },
    ])
    expect((await nb.search("cafe kinetics")).map((n) => n.id)).toEqual([b.id])
    expect((await nb.search("lemons")).map((n) => n.text)).toEqual(["groceries: lemons"])
    expect(await nb.search("lemons kinetics")).toEqual([])

    // An edit that leaves the preview out keeps it on the server.
    await nb.editNote(b.id, "https://example.com/post edited")
    const reader = new Notebook({ api: api() })
    await reader.keys.setOpenKey(open.identity)
    await reader.sync()
    const view = await reader.noteView(reader.replica.notes.get(b.id)!)
    expect(view!.text).toBe("https://example.com/post edited")
    expect(view!.previews.map((p) => p.title)).toEqual(["Café Kinetics"])
  })
})

describe("locked channels", () => {
  it("accepts appends without unlocking, and reads only after unlock", async () => {
    const { nb, open } = await notebook()
    const locked = await nb.createChannel({
      name: "Vault",
      lock: "locked",
      passphrase: PASS,
      scryptLogN: LOG_N,
    })
    const added = await nb.addNote(locked.id, "synthetic secret")
    expect(added.locked).toBe(true)
    expect(added.text).toBe("")

    // A separate client with only the open key (an agent) sees ciphertext only.
    const agent = new Notebook({ api: api() })
    await agent.keys.setOpenKey(open.identity)
    await agent.sync()
    const view = (await agent.channelViews()).find((v) => v.id === locked.id)
    // The name is readable with the open key (ADR-0014); the notes are not.
    expect(view).toMatchObject({ lock: "locked", readable: false, name: "Vault", noteCount: 1 })
    expect(await agent.notes(locked.id)).toEqual([])
    expect((await agent.notes()).some((n) => n.channelId === locked.id)).toBe(false)
    expect(await agent.search("secret")).toEqual([])

    await expect(agent.unlock(locked.id, "wrong-synthetic")).rejects.toBeInstanceOf(CryptoError)
    await agent.unlock(locked.id, PASS)
    expect((await agent.notes(locked.id)).map((n) => n.text)).toEqual(["synthetic secret"])
    expect((await agent.notes()).some((n) => n.channelId === locked.id)).toBe(false) // "all open" never mixes in locked
    expect((await agent.channelViews()).find((v) => v.id === locked.id)!.name).toBe("Vault")

    agent.keys.lockAll()
    expect(await agent.notes(locked.id)).toEqual([])
    expect((await agent.channelViews()).find((v) => v.id === locked.id)!.name).toBe("Vault")

    // Without the open key, the name is hidden too.
    const stranger = new Notebook({ api: api() })
    await stranger.sync()
    expect((await stranger.channelViews()).find((v) => v.id === locked.id)!.name).toBeNull()
  })

  it("unlockAny finds the channel a passphrase belongs to", async () => {
    const { nb } = await notebook()
    await nb.createChannel({
      name: "A",
      lock: "locked",
      passphrase: "synthetic-a",
      scryptLogN: LOG_N,
    })
    const b = await nb.createChannel({
      name: "B",
      lock: "locked",
      passphrase: "synthetic-b",
      scryptLogN: LOG_N,
    })
    nb.keys.lockAll()
    expect(await nb.unlockAny("synthetic-b")).toEqual([b.id])
  })

  it("changes a passphrase", async () => {
    const { nb } = await notebook()
    const ch = await nb.createChannel({
      name: "V",
      lock: "locked",
      passphrase: "synthetic-old",
      scryptLogN: LOG_N,
    })
    nb.keys.lockAll()
    await nb.changePassphrase(ch.id, "synthetic-old", "synthetic-new")
    await expect(nb.unlock(ch.id, "synthetic-old")).rejects.toBeInstanceOf(CryptoError)
    await nb.unlock(ch.id, "synthetic-new")
  })

  it("moving into a locked channel purges history; the server enforces it", async () => {
    const { nb, open } = await notebook()
    const inbox = await nb.createChannel({ name: "Inbox", lock: "open" })
    const vault = await nb.createChannel({
      name: "Vault",
      lock: "locked",
      passphrase: PASS,
      scryptLogN: LOG_N,
    })
    const n = await nb.addNote(inbox.id, "draft one")
    await nb.editNote(n.id, "draft two")

    const body = await sealNoteBody(vault.recipient, {
      v: 1,
      text: "x",
      links: [],
      attachments: [],
    })
    await expect(
      api().updateNote(n.id, { baseVersion: 2, channelId: vault.id, body }),
    ).rejects.toMatchObject({
      code: "purge_required",
    })

    await nb.moveNote(n.id, vault.id)
    expect(await api().versions(n.id)).toEqual([])
    const agent = new Notebook({ api: api() })
    await agent.keys.setOpenKey(open.identity)
    await agent.sync()
    expect((await agent.notes()).some((x) => x.id === n.id)).toBe(false)
    nb.keys.lockAll()
    await expect(nb.editNote(n.id, "x")).rejects.toBeInstanceOf(LockedError)
  })
})

describe("attachments", () => {
  it("round-trips encrypted images and re-encrypts them on move", async () => {
    const { nb } = await notebook()
    const a = await nb.createChannel({ name: "A", lock: "open" })
    const b = await nb.createChannel({ name: "B", lock: "open" })
    const data = crypto.getRandomValues(new Uint8Array(4096))
    const ref = await nb.addAttachment(a.id, data, "image/png", { name: "synthetic.png" })
    const n = await nb.addNote(a.id, "with image", { attachments: [ref] })
    expect(await nb.readAttachment(a.id, ref)).toEqual(data)
    await nb.moveNote(n.id, b.id)
    const [moved] = await nb.notes(b.id)
    expect(moved!.attachments[0]!.id).not.toBe(ref.id)
    expect(await nb.readAttachment(b.id, moved!.attachments[0]!)).toEqual(data)
  })

  it("rejects non-age uploads", async () => {
    const { nb } = await notebook()
    const ch = await nb.createChannel({ name: "A", lock: "open" })
    await expect(
      api().uploadAttachment(newId(), ch.id, new TextEncoder().encode("GIF89a")),
    ).rejects.toBeInstanceOf(ApiError)
    const kp = await generateKeyPair()
    expect(
      (await api().uploadAttachment(newId(), ch.id, await encryptTo(kp.recipient, "x"))).size,
    ).toBeGreaterThan(0)
  })

  it("streams any file type, bigger than one chunk, byte for byte (ADR-0017)", async () => {
    const { nb } = await notebook()
    const ch = await nb.createChannel({ name: "Files", lock: "open" })
    // Synthetic "zip": random bytes, several age chunks (64 KiB) and several stream reads.
    const data = new Uint8Array(3 * 1024 * 1024 + 17)
    for (let i = 0; i < data.length; i += 65536)
      crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, data.length)))
    const ref = await nb.addAttachment(ch.id, data, "application/zip", { name: "synthetic.zip" })
    await nb.addNote(ch.id, "", { attachments: [ref] })
    expect(await nb.pendingCount()).toBe(0)
    const fresh = new Notebook({ api: api() })
    await fresh.keys.setOpenKey(nb.keys.openIdentity)
    await fresh.sync()
    expect(await fresh.readAttachment(ch.id, ref)).toEqual(data)
    // The service worker only caches attachments whose declared length is small enough.
    const got = await raw(`/api/attachments/${ref.id}`)
    expect(Number(got.headers.get("content-length"))).toBeGreaterThan(data.length)
    await got.body?.cancel()
    const gif = new TextEncoder().encode("GIF89a synthetic")
    const g = await nb.addAttachment(ch.id, gif, "image/gif", { name: "synthetic.gif" })
    expect(g.mime).toBe("image/gif")
    expect(await nb.readAttachment(ch.id, g)).toEqual(gif)
  })

  it("refuses files over the cap before encrypting, and oversized uploads", async () => {
    const { nb } = await notebook()
    const ch = await nb.createChannel({ name: "Big", lock: "open" })
    const big = { length: MAX_ATTACHMENT_PLAIN_BYTES + 1 } as Uint8Array
    await expect(nb.addAttachment(ch.id, big, "application/zip")).rejects.toMatchObject({
      status: 413,
      code: "attachment_too_large",
    })
    expect(await nb.pendingCount()).toBe(0)
    const res = await raw(`/api/attachments/${newId()}?channelId=${ch.id}`, {
      method: "PUT",
      headers: { "content-length": String(MAX_ATTACHMENT_BYTES + 1) },
      body: new Uint8Array(10),
    })
    expect([411, 413]).toContain(res.status)
  })
})

describe("locked channel names (ADR-0014)", () => {
  /** A locked channel as created before ADR-0014: its name is sealed to the channel only. */
  async function legacyLocked(name: string) {
    const { request } = await newChannel({
      name,
      lock: "locked",
      passphrase: PASS,
      scryptLogN: LOG_N,
    })
    return api().createChannel(request)
  }

  it("shares a legacy locked name with the open key on the next unlock", async () => {
    const { open } = await notebook()
    const row = await legacyLocked("Synthetic legacy")
    const agent = new Notebook({ api: api() })
    await agent.keys.setOpenKey(open.identity)
    await agent.sync()
    expect((await agent.channelViews()).find((v) => v.id === row.id)!.name).toBeNull()
    expect(await agent.findChannel("Synthetic legacy")).toBeUndefined()

    await agent.unlock(row.id, PASS)
    agent.keys.lockAll()
    const fresh = new Notebook({ api: api() })
    await fresh.keys.setOpenKey(open.identity)
    await fresh.sync()
    expect((await fresh.channelViews()).find((v) => v.id === row.id)!.name).toBe("Synthetic legacy")
    expect((await fresh.findChannel("synthetic LEGACY"))?.id).toBe(row.id)
    expect(fresh.keys.isUnlocked(row.id)).toBe(false)
  })

  it("renames a locked channel without unlocking it, given the open key", async () => {
    const { nb, open } = await notebook()
    const row = await legacyLocked("Synthetic old name")
    await nb.sync()
    await nb.renameChannel(row.id, "Synthetic new name")
    const fresh = new Notebook({ api: api() })
    await fresh.keys.setOpenKey(open.identity)
    await fresh.sync()
    expect((await fresh.channelViews()).find((v) => v.id === row.id)!.name).toBe(
      "Synthetic new name",
    )

    const keyless = new Notebook({ api: api() })
    await keyless.sync()
    await expect(keyless.renameChannel(row.id, "x")).rejects.toBeInstanceOf(LockedError)
  })
})

describe("store copy: dump and restore (ADR-0015)", () => {
  const post = (path: string, body: unknown) =>
    raw(path, { method: "POST", body: JSON.stringify(body) })
  // Pages end at PAGE_BYTES, and earlier tests store large notes: read everything.
  async function dumpAll<T extends DumpTable>(a: Api, table: T) {
    const rows: DumpRow<T>[] = []
    for (let after = 0; ;) {
      const page = await a.dump(table, after, 500)
      rows.push(...page.rows)
      if (page.next === null) return rows
      after = page.next
    }
  }
  async function syncAll(a: Api) {
    const out = { channels: [] as ChannelRow[], notes: [] as NoteRow[], cursor: 0 }
    for (;;) {
      const page = await a.sync(out.cursor, 1000)
      out.channels.push(...page.channels)
      out.notes.push(...page.notes)
      out.cursor = page.cursor
      if (!page.more) return out
    }
  }

  it("dumps every table in pages, including source hashes and history", async () => {
    const { nb } = await notebook()
    const ch = await nb.createChannel({ name: "Dumped", lock: "open" })
    const n = await nb.addNote(ch.id, "synthetic v1")
    await nb.editNote(n.id, "synthetic v2")
    const a = api()
    const notes = []
    for (let after = 0; ;) {
      const page = await a.dump("notes", after, 2)
      notes.push(...page.rows)
      if (page.next === null) break
      after = page.next
    }
    expect(notes.find((r) => r.id === n.id)).toMatchObject({ version: 2, sourceHash: null })
    const versions = (await a.dump("versions", 0, 500)).rows
    expect(versions.filter((v) => v.noteId === n.id).map((v) => v.version)).toEqual([1])
    expect((await raw("/api/dump/users")).status).toBe(404)
  })

  it("restores only into an account that was never written to, then closes", async () => {
    // This account has been written to by the tests above.
    expect((await post("/api/restore", {})).status).toBe(409)

    // Copy everything out, then empty the account as if it were a fresh deployment.
    const a = api()
    const dump = {
      channels: await dumpAll(a, "channels"),
      notes: await dumpAll(a, "notes"),
      versions: await dumpAll(a, "versions"),
    }
    const before = await syncAll(a)
    await env.DB.batch(
      ["users", "channels", "notes", "note_versions", "attachments"].map((t) =>
        env.DB.prepare(`DELETE FROM ${t}`),
      ),
    )

    // Same checks as normal writes.
    const ch = dump.channels.find((c) => c.lock === "open")!
    const bad = await post("/api/restore", {
      channels: [{ ...ch, wrappedKey: dump.channels.find((c) => c.lock === "locked")!.wrappedKey }],
    })
    expect(bad.status).toBe(422)
    const live = dump.notes.find((n) => n.deletedAt === null)!
    const plain = await post("/api/restore", { notes: [{ ...live, body: btoa("plaintext") }] })
    expect(plain.status).toBe(422)

    await a.restore({ channels: dump.channels })
    for (let i = 0; i < dump.notes.length; i += 100)
      await a.restore({ notes: dump.notes.slice(i, i + 100) })
    for (let i = 0; i < dump.versions.length; i += 100)
      await a.restore({ versions: dump.versions.slice(i, i + 100) })
    await a.restore({ channels: dump.channels }) // a rerun changes nothing
    const { seq } = await a.restoreFinish()
    expect(seq).toBe(before.cursor)
    expect((await post("/api/restore", {})).status).toBe(409)
    expect((await post("/api/restore/finish", {})).status).toBe(409)

    const after = await syncAll(a)
    expect(after.cursor).toBe(before.cursor)
    expect(after.notes).toEqual(before.notes)
    expect(after.channels).toEqual(before.channels)
    expect(await dumpAll(a, "notes")).toEqual(dump.notes)
    expect((await dumpAll(a, "versions")).length).toBe(dump.versions.length)
  })
})

describe("pairing and device sessions (ADR-0016, ADR-0019)", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pairings"),
      env.DB.prepare("DELETE FROM devices"),
    ])
  })
  const count = async (table: "pairings" | "devices") =>
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n
  /** A browser that isn't signed in to anything. */
  const stranger = (headers: Record<string, string> = {}) =>
    new Api({
      baseUrl: "https://notes.example.com",
      fetch: (input, init) => {
        const h = new Headers(init?.headers)
        for (const [k, v] of Object.entries(headers)) h.set(k, v)
        return SELF.fetch(input as string, { ...init, headers: h })
      },
    })
  /** Pairs a device, approved by the (dev) Access session; returns its session. */
  async function pair(temporary = false) {
    const open = await generateKeyPair()
    const laptop = await startPairing(api(), "http://localhost", { temporary })
    await approvePairing(api(), await checkPairing(api(), laptop.link), open.identity)
    const paired = (await receivePairing(api(), laptop))!
    return { ...paired, open, api: api(paired.token) }
  }

  it("signs a new device in with one approval, and relays the open key sealed to it", async () => {
    const access = api()
    const open = await generateKeyPair()
    const before = (await access.sync(0, 1)).cursor
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"
    // The new device isn't signed in to anything.
    const laptop = await startPairing(stranger({ "user-agent": ua }), "https://notes.example.com", {
      temporary: false,
    })
    expect(laptop.link).toMatch(/^https:\/\/notes\.example\.com\/#\/pair\/[\w-]{22}\.[\w-]{43}$/)
    expect(laptop.link).not.toContain(laptop.secret)
    expect(await receivePairing(stranger(), laptop)).toBeNull()

    const phone = await checkPairing(access, laptop.link)
    expect(phone.code).toBe(laptop.code)
    expect(phone.code).toMatch(/^\d{3} \d{3}$/)
    expect(phone).toMatchObject({ approved: false, temporary: false, agent: "Chrome on macOS" })
    await approvePairing(access, phone, open.identity)

    // The relay holds an age file sealed to the one-time key, and only hashes of the secrets.
    const stored = await env.DB.prepare("SELECT * FROM pairings").first<{
      key_ciphertext: number[]
      secret_hash: number[]
    }>()
    const text = new TextDecoder().decode(new Uint8Array(stored!.key_ciphertext))
    expect(text.startsWith("age-encryption.org/v1\n-> mlkem768x25519 ")).toBe(true)
    expect(text).not.toContain(open.identity)
    expect(JSON.stringify(stored)).not.toContain(laptop.secret)

    expect((await checkPairing(access, laptop.link)).approved).toBe(true)
    await expect(approvePairing(access, phone, open.identity)).rejects.toMatchObject({
      status: 409,
    })
    const paired = (await receivePairing(stranger(), laptop))!
    expect(paired.key).toBe(open.identity)
    expect(paired.token).toMatch(/^jotd_[\w-]{43}$/)
    expect(paired.device).toMatchObject({
      temporary: false,
      agent: "Chrome on macOS",
      current: true,
    })
    expect(await count("pairings")).toBe(0)
    await expect(receivePairing(stranger(), laptop)).rejects.toMatchObject({ status: 404 })
    const row = await env.DB.prepare("SELECT * FROM devices").first()
    expect(JSON.stringify(row)).not.toContain(paired.token)

    // The session works without Access, on the same account, but not for dump or restore.
    const device = api(paired.token)
    expect(await device.me()).toEqual({
      userId: "u_dev",
      device: { id: paired.device.id, temporary: false },
    })
    expect((await device.sync(0, 1)).cursor).toBe(before)
    await expect(device.dump("notes")).rejects.toMatchObject({ status: 404 })
    expect(
      (
        await SELF.fetch("https://notes.example.com/device-api/me", {
          headers: { authorization: `Bearer ${paired.token}` },
        })
      ).status,
    ).toBe(200)
    // Pairing is not a change: sync and the restore gate don't see it.
    expect((await access.sync(0, 1)).cursor).toBe(before)
  })

  it("answers a wrong secret exactly like an unknown pairing", async () => {
    const laptop = await startPairing(stranger(), "https://notes.example.com", { temporary: false })
    const wrong = "A".repeat(43)
    const claim = (id: string, secret: string) =>
      raw(`/device-api/pairings/${id}/claim`, {
        method: "POST",
        body: JSON.stringify({ secret }),
      })
    const a = await claim(laptop.id, wrong)
    const b = await claim("B".repeat(22), wrong)
    expect([a.status, b.status]).toEqual([404, 404])
    expect(await a.text()).toBe(await b.text())
    // Cancelling needs the secret too.
    await stranger().cancelPairing(laptop.id, wrong)
    expect(await count("pairings")).toBe(1)
    await stranger().cancelPairing(laptop.id, laptop.secret)
    expect(await count("pairings")).toBe(0)
  })

  it("only lets a signed-in, non-temporary session approve", async () => {
    const laptop = await startPairing(stranger(), "https://notes.example.com", { temporary: true })
    const body = JSON.stringify({ key: "AAAA" })
    // Not signed in: no session, and Access (here: dev auth off localhost) refuses.
    expect(
      (await raw(`/device-api/pairings/${laptop.id}/approve`, { method: "POST", body })).status,
    ).toBe(401)
    expect((await raw(`/api/pairings/${laptop.id}`, {}, "notes.example.com")).status).toBe(403)
    expect((await raw(`/api/me`, { headers: { cookie: "jot_dev_signed_out=1" } })).status).toBe(401)
    const temp = await pair(true)
    expect(temp.device.temporary).toBe(true)
    const offer = await checkPairing(temp.api, laptop.link)
    expect(offer.temporary).toBe(true)
    await expect(approvePairing(temp.api, offer, temp.open.identity)).rejects.toMatchObject({
      status: 403,
      code: "temporary_device",
    })
    // A normal device session can.
    const normal = await pair(false)
    await approvePairing(normal.api, offer, normal.open.identity)
    expect((await receivePairing(stranger(), laptop))!.key).toBe(normal.open.identity)
  })

  it("refuses classical keys, plaintext and multi-recipient files", async () => {
    const classical = await identityToRecipient(await generateX25519Identity())
    expect(
      (
        await raw("/device-api/pairings", {
          method: "POST",
          body: JSON.stringify({ recipient: classical, temporary: false }),
        })
      ).status,
    ).toBe(400)
    const laptop = await startPairing(stranger(), "http://localhost", { temporary: false })
    const put = (key: string) =>
      raw(`/api/pairings/${laptop.id}/approve`, { method: "POST", body: JSON.stringify({ key }) })
    expect((await put(btoa("AGE-SECRET-KEY-PQ-1SYNTHETIC"))).status).toBe(422)
    const extra = await generateKeyPair()
    const two = toBase64(await encryptTo([laptop.recipient, extra.recipient], "x"))
    expect((await put(two)).status).toBe(422)
    const e = new Encrypter()
    e.addRecipient(classical)
    expect((await put(toBase64(await e.encrypt("x")))).status).toBe(422)
    expect(await receivePairing(stranger(), laptop)).toBeNull()
  })

  it("caps pairings per address and in total, and expires them", async () => {
    const kp = await generateKeyPair()
    const from = (ip: string) => stranger({ "cf-connecting-ip": ip })
    for (let i = 0; i < 3; i++) await from("203.0.113.7").startPairing(kp.recipient, false)
    await expect(from("203.0.113.7").startPairing(kp.recipient, false)).rejects.toMatchObject({
      status: 429,
      code: "too_many_pairings",
    })
    // One IPv6 /64 counts as one address.
    for (let i = 1; i <= 3; i++) await from(`2001:db8:1:2::${i}`).startPairing(kp.recipient, false)
    await expect(
      from("2001:db8:1:2:ffff::9").startPairing(kp.recipient, false),
    ).rejects.toMatchObject({ status: 429 })
    const p = await from("198.51.100.1").startPairing(kp.recipient, false)
    expect(await count("pairings")).toBe(7)
    // A cross-site form or text/plain fetch can't start one.
    const form = await SELF.fetch("http://localhost/device-api/pairings", {
      method: "POST",
      headers: { "content-type": "text/plain", "cf-connecting-ip": "192.0.2.9" },
      body: JSON.stringify({ recipient: kp.recipient, temporary: false }),
    })
    expect(form.status).toBe(415)
    expect(await count("pairings")).toBe(7)

    // Expired pairings are gone, for both sides, and swept on the next start.
    await env.DB.prepare("UPDATE pairings SET expires_at = ?")
      .bind(Date.now() - 1)
      .run()
    await expect(api().getPairing(p.id)).rejects.toMatchObject({ status: 404 })
    await expect(from("198.51.100.1").claimPairing(p.id, p.secret)).rejects.toMatchObject({
      status: 404,
    })
    await from("198.51.100.1").startPairing(kp.recipient, false)
    expect(await count("pairings")).toBe(1)

    // The total cap holds however many addresses ask.
    const fill = []
    for (let i = 0; i < MAX_PENDING_PAIRINGS - 1; i++)
      fill.push(
        env.DB.prepare(
          `INSERT INTO pairings (id, secret_hash, source_hash, recipient, temporary, agent, place, created_at, expires_at)
           VALUES (?, x'00', ?, 'r', 0, '', '', 0, ?)`,
        ).bind(`fill${String(i).padStart(18, "0")}`, `src${i}`, Date.now() + 60_000),
      )
    await env.DB.batch(fill)
    await expect(from("192.0.2.1").startPairing(kp.recipient, false)).rejects.toMatchObject({
      status: 429,
    })
    expect(await count("pairings")).toBe(MAX_PENDING_PAIRINGS)
  })

  it("lists devices, signs them out, and expires sessions", async () => {
    const a = await pair(false)
    const b = await pair(false)
    const t = await pair(true)
    const list = await a.api.devices()
    expect(list.map((d) => d.id).sort()).toEqual([a.device.id, b.device.id, t.device.id].sort())
    expect(list.find((d) => d.current)?.id).toBe(a.device.id)
    // Access sessions see the list too, with no current device.
    expect((await api().devices()).some((d) => d.current)).toBe(false)

    // A temporary device can sign itself out, but not others.
    await expect(t.api.revokeDevice(a.device.id)).rejects.toMatchObject({
      status: 403,
      code: "temporary_device",
    })
    await a.api.revokeDevice(b.device.id)
    await expect(b.api.sync(0, 1)).rejects.toMatchObject({ status: 401, code: "session_revoked" })
    await expect(a.api.revokeDevice(b.device.id)).rejects.toMatchObject({ status: 404 })
    await t.api.revokeDevice(t.device.id)
    await expect(t.api.me()).rejects.toMatchObject({ code: "session_revoked" })
    expect((await a.api.devices()).map((d) => d.id)).toEqual([a.device.id])

    // Unused sessions expire; used ones slide forward.
    await env.DB.prepare("UPDATE devices SET last_seen_at = 0 WHERE id = ?").bind(a.device.id).run()
    await a.api.me()
    const slid = await env.DB.prepare("SELECT last_seen_at, expires_at FROM devices WHERE id = ?")
      .bind(a.device.id)
      .first<{ last_seen_at: number; expires_at: number }>()
    expect(slid!.last_seen_at).toBeGreaterThan(Date.now() - 10_000)
    expect(slid!.expires_at).toBeGreaterThan(Date.now() + 29 * 24 * 3600_000)
    await env.DB.prepare("UPDATE devices SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, a.device.id)
      .run()
    await expect(a.api.me()).rejects.toMatchObject({ status: 401, code: "session_expired" })
    await expect(api("jotd_" + "x".repeat(43)).me()).rejects.toMatchObject({
      code: "unauthenticated",
    })
  })

  it("keeps temporary sessions short", async () => {
    const t = await pair(true)
    expect(t.device.expiresAt).toBeLessThanOrEqual(Date.now() + 3600_000)
    // Even in use, a temporary session ends 12 hours after pairing.
    await env.DB.prepare("UPDATE devices SET created_at = ?, last_seen_at = 0")
      .bind(Date.now() - 12 * 3600_000 + 5_000)
      .run()
    await t.api.me()
    const row = await env.DB.prepare("SELECT expires_at FROM devices").first<{
      expires_at: number
    }>()
    expect(row!.expires_at).toBeLessThan(Date.now() + 10_000)
  })

  it("catches a relay that swaps the one-time key", async () => {
    const a = api()
    const laptop = await startPairing(a, "http://localhost", { temporary: false })
    const other = await generateKeyPair()
    await env.DB.prepare("UPDATE pairings SET recipient = ?").bind(other.recipient).run()
    const err = await checkPairing(a, laptop.link).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PairingError)
    expect((err as PairingError).code).toBe("mismatch")
    // A different key or id gives a different code.
    expect(await pairingCode(laptop.id, other.recipient)).not.toBe(laptop.code)
    await expect(checkPairing(a, "http://localhost/#/pair/nope")).rejects.toBeInstanceOf(
      PairingError,
    )
  })

  it("describes the device from a fixed vocabulary", () => {
    expect(
      agentOf(
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome on Android")
    expect(
      agentOf(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iOS")
    expect(
      agentOf(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36 Edg/142.0",
      ),
    ).toBe("Edge on Windows")
    expect(agentOf("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe(
      "Firefox on Linux",
    )
    expect(agentOf("Approve me: your bank says so")).toBe("Unknown browser")
    expect(sourceOf("2001:DB8:0:1::5")).toBe("2001:db8:0:1")
    expect(sourceOf("2001:db8::")).toBe("2001:db8:0:0")
    expect(sourceOf("203.0.113.7")).toBe("203.0.113.7")
  })
})
