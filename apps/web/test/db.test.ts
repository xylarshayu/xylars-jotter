import "fake-indexeddb/auto"
import { describe, expect, it } from "vitest"
import { Api, ChannelRow, newChannel, Notebook, type CreateNote, type NoteRow } from "@jot/core"
import { generateKeyPair } from "@jot/crypto"
import { Db, IdbOutbox, Persist } from "../src/lib/db.ts"

// Synthetic data only.
const PASS = "synthetic-passphrase"

async function fakeNotebook(db: Db) {
  const kp = await generateKeyPair()
  const rows: ChannelRow[] = []
  for (const opts of [
    { name: "Open", lock: "open" as const, openRecipient: kp.recipient },
    { name: "Vault", lock: "locked" as const, passphrase: PASS, scryptLogN: 10 },
  ]) {
    const { request } = await newChannel(opts)
    rows.push(
      ChannelRow.parse({
        ...request,
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
        seq: rows.length + 1,
      }),
    )
  }
  let seq = 10
  const api = new Api({ baseUrl: "http://test.invalid" })
  api.sync = async () => ({ cursor: 2, more: false, channels: rows, notes: [] })
  api.createNote = async (req: CreateNote) => {
    const note: NoteRow = {
      id: req.id,
      channelId: req.channelId,
      version: 1,
      body: req.body,
      preview: req.preview ?? null,
      size: 1,
      createdAt: req.createdAt!,
      updatedAt: req.createdAt!,
      deletedAt: null,
      seq: ++seq,
    }
    return { note, duplicate: false }
  }
  const nb = new Notebook({ api, outbox: new IdbOutbox(db) })
  await nb.keys.setOpenKey(kp.identity)
  await nb.sync()
  return { nb, open: rows[0]!, locked: rows[1]! }
}

async function dump(db: Db): Promise<string> {
  const parts = await Promise.all(
    (["kv", "channels", "notes", "plain", "outbox"] as const).map((s) => db.all(s)),
  )
  return JSON.stringify(parts)
}

describe("IndexedDB persistence", () => {
  it("round-trips the replica and never stores locked plaintext", async () => {
    const db = await Db.open("t1")
    const persist = new Persist(db)
    await persist.load()
    const { nb, open, locked } = await fakeNotebook(db)
    await nb.unlock(locked.id, PASS)
    await nb.addNote(open.id, "synthetic open note")
    await nb.addNote(locked.id, "synthetic locked secret")
    expect((await nb.notes(locked.id)).map((n) => n.text)).toEqual(["synthetic locked secret"])
    await persist.save(nb)

    const stored = await dump(db)
    expect(stored).toContain("synthetic open note")
    expect(stored).not.toContain("synthetic locked secret")
    expect(stored).not.toContain(PASS)

    const again = new Persist(db)
    const { snapshot, plain } = await again.load()
    expect(snapshot.cursor).toBe(2)
    expect(snapshot.notes).toHaveLength(2)
    expect(plain.map((p) => p.channelId)).toEqual([open.id])
    db.close()
  })

  it("saves only changes and removes deleted rows", async () => {
    const db = await Db.open("t2")
    const persist = new Persist(db)
    await persist.load()
    const { nb, open } = await fakeNotebook(db)
    const a = await nb.addNote(open.id, "synthetic a")
    await nb.addNote(open.id, "synthetic b")
    await persist.save(nb)
    nb.replica.notes.delete(a.id)
    await persist.save(nb)
    expect((await db.all<NoteRow>("notes")).map((n) => n.id)).not.toContain(a.id)
    expect(await dump(db)).not.toContain("synthetic a")
    db.close()
  })
})
