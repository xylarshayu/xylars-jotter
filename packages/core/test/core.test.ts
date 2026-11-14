import { describe, expect, it } from "vitest"
import { generateKeyPair } from "@jot/crypto"
import {
  Api,
  ApiError,
  ChannelRow,
  extractLinks,
  fitPreviewImage,
  isOpenChannel,
  KeyRing,
  MAX_PREVIEW_IMAGE,
  newChannel,
  MemoryOutbox,
  Notebook,
  newId,
  normalizeLock,
  notePath,
  pairingCode,
  pairingCommit,
  pairingLink,
  parseImportLine,
  parsePairingLink,
  parseImageDataUrl,
  Replica,
  search,
  slugify,
  toMarkdown,
} from "../src/index.ts"

describe("ids", () => {
  it("are sortable ULIDs", () => {
    const a = newId(1000)
    const b = newId(2000)
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(a < b).toBe(true)
  })
})

describe("fail closed", () => {
  it("normalizes anything but 'open' to locked", () => {
    expect(normalizeLock("open")).toBe("open")
    for (const v of ["locked", "OPEN", "", null, undefined, "shared", 1])
      expect(normalizeLock(v)).toBe("locked")
  })

  it("never treats a passphrase-wrapped key as open, whatever the server says", async () => {
    const { request } = await newChannel({
      name: "x",
      lock: "locked",
      passphrase: "synthetic",
      scryptLogN: 10,
    })
    const row = ChannelRow.parse({
      ...request,
      lock: "open",
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      seq: 1,
    })
    expect(row.lock).toBe("open")
    expect(isOpenChannel(row)).toBe(false)
    const keys = new KeyRing()
    await keys.setOpenKey((await generateKeyPair()).identity)
    expect(await keys.identityFor(row)).toBeUndefined()
  })

  it("rejects an open channel whose recipient doesn't match its key", async () => {
    const open = await generateKeyPair()
    const { request } = await newChannel({ name: "x", lock: "open", openRecipient: open.recipient })
    const other = await generateKeyPair()
    const row = ChannelRow.parse({
      ...request,
      recipient: other.recipient,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      seq: 1,
    })
    const keys = new KeyRing()
    await keys.setOpenKey(open.identity)
    expect(await keys.identityFor(row)).toBeUndefined()
  })
})

describe("links", () => {
  it("extracts and trims links", () => {
    expect(
      extractLinks("see (https://example.com/a_(b)) and https://x.org/p?q=1, ok. ftp://no"),
    ).toEqual(["https://example.com/a_(b)", "https://x.org/p?q=1"])
  })
})

describe("search", () => {
  it("matches all tokens, accent-insensitive, newest first", () => {
    const docs = [
      { id: "a", createdAt: 1, text: "Café au lait" },
      { id: "b", createdAt: 2, text: "cafe racer" },
      { id: "c", createdAt: 3, text: "tea" },
    ]
    expect(search(docs, "CAFE").map((d) => d.id)).toEqual(["b", "a"])
    expect(search(docs, "cafe lait").map((d) => d.id)).toEqual(["a"])
    expect(search(docs, "  ")).toEqual([])
  })
})

describe("replica", () => {
  it("keeps the newest row by seq and replaces pending rows", () => {
    const r = new Replica()
    const base = {
      id: newId(),
      channelId: newId(),
      version: 1,
      body: "",
      preview: null,
      size: 0,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    }
    r.putPending({ ...base, seq: 0 })
    r.apply({ channels: [], notes: [{ ...base, seq: 5 }] })
    r.apply({ channels: [], notes: [{ ...base, version: 0, seq: 3 }] })
    expect(r.notes.get(base.id)!.seq).toBe(5)
    expect(Replica.from(r.snapshot()).notes.get(base.id)!.seq).toBe(5)
  })
})

describe("import/export format", () => {
  it("parses import lines", () => {
    const l = parseImportLine(
      '{"channel":"Inbox","created_at":"2024-01-01T00:00:00Z","text":"t","source_id":"s1"}',
    )
    expect(l.channel).toBe("Inbox")
    expect(() =>
      parseImportLine('{"channel":"Inbox","created_at":"nope","text":"t","source_id":"s"}'),
    ).toThrow()
    expect(() =>
      parseImportLine('{"channel":"Inbox","created_at":"2024-01-01T00:00:00Z","text":"t"}'),
    ).toThrow()
  })

  it("renders markdown with front matter", () => {
    const md = toMarkdown(
      {
        id: "01J0000000000000000000000A",
        channelId: "c",
        version: 2,
        createdAt: Date.parse("2024-05-06T07:08:09Z"),
        updatedAt: Date.parse("2024-05-06T07:08:09Z"),
        text: "hello",
        links: ["https://example.com"],
        attachments: [],
        previews: [{ url: "https://example.com", title: 'A "quoted" title', site: "Ex" }],
        pending: false,
        locked: false,
      },
      { id: "c", name: "Ideas: misc" },
    )
    expect(md).toContain('channel: "Ideas: misc"')
    expect(md).toContain('    title: "A \\"quoted\\" title"')
    expect(md.endsWith("\nhello\n")).toBe(true)
    expect(
      notePath(slugify("Ideas: misc"), { id: "X", createdAt: Date.parse("2024-05-06T07:08:09Z") }),
    ).toBe("ideas-misc/2024/05/X.md")
  })
})

describe("outbox", () => {
  it("drops an optimistic note the server rejected and resyncs", async () => {
    const kp = await generateKeyPair()
    const { request } = await newChannel({ name: "x", lock: "open", openRecipient: kp.recipient })
    const channel = ChannelRow.parse({
      ...request,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      seq: 1,
    })
    let syncs = 0
    const api = new Api({ baseUrl: "http://test.invalid" })
    api.createNote = async () => {
      throw new ApiError(400, "invalid_request")
    }
    api.sync = async (since: number) => {
      syncs++
      expect(since).toBe(0)
      return { cursor: 1, more: false, channels: [channel], notes: [] }
    }
    const nb = new Notebook({ api })
    await nb.keys.setOpenKey(kp.identity)
    await nb.sync()
    const note = await nb.addNote(channel.id, "synthetic")
    expect(nb.replica.notes.has(note.id)).toBe(false)
    expect(await nb.pendingCount()).toBe(0)
    expect(syncs).toBe(2)
  })

  it("restores pending writes from the outbox after a reload", async () => {
    const kp = await generateKeyPair()
    const { request } = await newChannel({ name: "x", lock: "open", openRecipient: kp.recipient })
    const channel = ChannelRow.parse({
      ...request,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      seq: 1,
    })
    const offline = new Api({ baseUrl: "http://test.invalid" })
    offline.sync = async () => ({ cursor: 1, more: false, channels: [channel], notes: [] })
    for (const m of ["createNote", "updateNote", "deleteNote"] as const)
      offline[m] = async () => {
        throw new ApiError(0, "network")
      }
    const outbox = new MemoryOutbox()
    const a = new Notebook({ api: offline, outbox })
    await a.keys.setOpenKey(kp.identity)
    await a.sync()
    const kept = await a.addNote(channel.id, "synthetic kept")
    await a.editNote(kept.id, "synthetic kept, edited")
    const gone = await a.addNote(channel.id, "synthetic gone")
    await a.deleteNote(gone.id)
    expect(await a.pendingCount()).toBe(4)

    // A fresh notebook with the last saved replica (before the writes) and the same outbox.
    const b = new Notebook({ api: offline, outbox })
    await b.keys.setOpenKey(kp.identity)
    await b.sync()
    await b.restorePending()
    const notes = await b.notes(channel.id)
    expect(notes.map((n) => [n.text, n.pending])).toEqual([["synthetic kept, edited", true]])
  })
})

describe("pairing links and codes", () => {
  it("round-trips a link and rejects anything else", async () => {
    const { recipient } = await generateKeyPair()
    const commit = await pairingCommit(recipient)
    expect(commit).toMatch(/^[\w-]{43}$/)
    const id = "AAAAAAAAAAAAAAAAAAAAAA"
    const link = pairingLink("https://notes.example.com/", id, commit)
    expect(link).toBe(`https://notes.example.com/#/pair/${id}.${commit}`)
    expect(parsePairingLink(link)).toEqual({ id, commit })
    expect(parsePairingLink(`#/pair/${id}.${commit}`)).toEqual({ id, commit })
    expect(parsePairingLink(`#/pair/${id}.${commit}x`)).toBeNull()
    expect(parsePairingLink(`#/pair/${id}`)).toBeNull()
    expect(parsePairingLink("https://example.com/")).toBeNull()
  })

  it("gives a stable six-digit code that depends on the id and the key", async () => {
    const a = await generateKeyPair()
    const b = await generateKeyPair()
    const code = await pairingCode("AAAAAAAAAAAAAAAAAAAAAA", a.recipient)
    expect(code).toMatch(/^\d{3} \d{3}$/)
    expect(await pairingCode("AAAAAAAAAAAAAAAAAAAAAA", a.recipient)).toBe(code)
    expect(await pairingCode("AAAAAAAAAAAAAAAAAAAAAA", b.recipient)).not.toBe(code)
    expect(await pairingCode("BAAAAAAAAAAAAAAAAAAAAA", a.recipient)).not.toBe(code)
  })
})

describe("preview images (ADR-0020)", () => {
  const item = (chars: number) => ({
    url: "https://example.com/",
    title: "Synthetic",
    image: `data:image/png;base64,${"A".repeat(chars)}`,
  })
  const small = "data:image/webp;base64,AAAA"

  it("keeps an image that fits, byte for byte, without re-encoding it", async () => {
    const fits = item(1000)
    let calls = 0
    const out = await fitPreviewImage(fits, async () => (calls++, small))
    expect(out).toEqual(fits)
    expect(calls).toBe(0)
  })

  it("re-encodes a large image, and drops it if that fails or doesn't fit", async () => {
    const big = item(MAX_PREVIEW_IMAGE)
    expect((await fitPreviewImage(big, async () => small)).image).toBe(small)
    for (const shrink of [
      undefined,
      async () => undefined,
      async () => big.image,
      async () => {
        throw new Error("synthetic decode failure")
      },
    ]) {
      const out = await fitPreviewImage(big, shrink)
      expect(out).toEqual({ url: big.url, title: big.title })
    }
  })

  it("parses base64 image data URLs only", () => {
    expect(parseImageDataUrl(small)).toEqual({ mime: "image/webp", base64: "AAAA" })
    expect(parseImageDataUrl("data:text/html;base64,AAAA")).toBeUndefined()
    expect(parseImageDataUrl("https://example.com/a.png")).toBeUndefined()
  })
})
