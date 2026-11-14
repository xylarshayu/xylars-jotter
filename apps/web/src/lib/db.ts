/**
 * IndexedDB storage for this device. It holds the ciphertext replica, the
 * outbox (ciphertext only), the open key, and decrypted notes of open channels.
 * Locked-channel plaintext never comes here: Notebook.exportPlainCache() only
 * returns open-channel entries.
 */
import type {
  ChannelRow,
  Notebook,
  NoteRow,
  OutboxEntry,
  OutboxStore,
  PlainEntry,
  ReplicaSnapshot,
} from "@jot/core"

export type StoreName = "kv" | "channels" | "notes" | "plain" | "outbox"

export interface Write {
  store: StoreName
  put?: unknown[]
  kv?: [string, unknown][]
  del?: IDBValidKey[]
}

function done<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error("aborted"))
  })
}

export class Db {
  private constructor(readonly idb: IDBDatabase) {}

  static async open(name = "jot"): Promise<Db> {
    const r = indexedDB.open(name, 1)
    r.onupgradeneeded = () => {
      const db = r.result
      db.createObjectStore("kv")
      db.createObjectStore("channels", { keyPath: "id" })
      db.createObjectStore("notes", { keyPath: "id" })
      db.createObjectStore("plain", { keyPath: "id" })
      db.createObjectStore("outbox", { keyPath: "key" })
    }
    return new Db(await done(r))
  }

  static async destroy(name = "jot"): Promise<void> {
    await done(indexedDB.deleteDatabase(name))
  }

  async get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return (await done(this.idb.transaction(store).objectStore(store).get(key))) as T | undefined
  }

  async all<T>(store: StoreName): Promise<T[]> {
    return (await done(this.idb.transaction(store).objectStore(store).getAll())) as T[]
  }

  /** Applies all writes in one transaction. */
  async write(writes: Write[]): Promise<void> {
    const names = [...new Set(writes.map((w) => w.store))]
    if (!names.length) return
    const tx = this.idb.transaction(names, "readwrite")
    for (const w of writes) {
      const s = tx.objectStore(w.store)
      for (const v of w.put ?? []) s.put(v)
      for (const [k, v] of w.kv ?? []) s.put(v, k)
      for (const k of w.del ?? []) s.delete(k)
    }
    await committed(tx)
  }

  close(): void {
    this.idb.close()
  }
}

export class IdbOutbox implements OutboxStore {
  constructor(private readonly db: Db) {}
  load(): Promise<OutboxEntry[]> {
    return this.db.all<OutboxEntry>("outbox")
  }
  put(e: OutboxEntry): Promise<void> {
    return this.db.write([{ store: "outbox", put: [e] }])
  }
  remove(key: string): Promise<void> {
    return this.db.write([{ store: "outbox", del: [key] }])
  }
}

const fp = (s: string | null) => (s === null ? "-" : `${s.length}:${s.slice(-24)}`)
const noteFp = (n: NoteRow) =>
  `${n.seq}|${n.version}|${n.channelId}|${n.deletedAt}|${fp(n.body)}|${fp(n.preview)}`
const channelFp = (c: ChannelRow) =>
  `${c.seq}|${c.lock}|${c.deletedAt}|${fp(c.name)}|${fp(c.wrappedKey)}`
const plainFp = (p: PlainEntry) => `${p.version}|${p.channelId}|${p.previewFp}`

type Saved = Map<string, string>

/** Saves only what changed since the last save, so big notebooks stay cheap to persist. */
export class Persist {
  #saved = { channels: new Map(), notes: new Map(), plain: new Map() } as Record<
    "channels" | "notes" | "plain",
    Saved
  >
  #cursor = -1
  #running: Promise<void> | undefined
  #again = false

  constructor(readonly db: Db) {}

  async load(): Promise<{ snapshot: ReplicaSnapshot; plain: PlainEntry[] }> {
    const [cursor, channels, notes, plain] = await Promise.all([
      this.db.get<number>("kv", "cursor"),
      this.db.all<ChannelRow>("channels"),
      this.db.all<NoteRow>("notes"),
      this.db.all<PlainEntry>("plain"),
    ])
    for (const c of channels) this.#saved.channels.set(c.id, channelFp(c))
    for (const n of notes) this.#saved.notes.set(n.id, noteFp(n))
    for (const p of plain) this.#saved.plain.set(p.id, plainFp(p))
    this.#cursor = cursor ?? 0
    return { snapshot: { cursor: cursor ?? 0, channels, notes }, plain }
  }

  /** Coalesces concurrent saves; a save requested mid-flight runs once more afterwards. */
  save(nb: Notebook): Promise<void> {
    if (this.#running) {
      this.#again = true
      return this.#running
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false
          await this.#save(nb)
        } while (this.#again)
      } finally {
        this.#running = undefined
      }
    })()
    return this.#running
  }

  async #save(nb: Notebook): Promise<void> {
    const updates: [Saved, string, string | null][] = []
    const diff = <T extends { id: string }>(
      store: StoreName,
      saved: Saved,
      rows: Iterable<T>,
      f: (r: T) => string,
    ): Write => {
      const put: T[] = []
      const seen = new Set<string>()
      for (const r of rows) {
        seen.add(r.id)
        const k = f(r)
        if (saved.get(r.id) !== k) {
          put.push(r)
          updates.push([saved, r.id, k])
        }
      }
      const del = [...saved.keys()].filter((id) => !seen.has(id))
      for (const id of del) updates.push([saved, id, null])
      return { store, put, del }
    }
    const cursor = nb.replica.cursor
    const writes = [
      diff("channels", this.#saved.channels, nb.replica.channels.values(), channelFp),
      diff("notes", this.#saved.notes, nb.replica.notes.values(), noteFp),
      // Open channels only (see Notebook.exportPlainCache).
      diff("plain", this.#saved.plain, nb.exportPlainCache(), plainFp),
    ].filter((w) => w.put!.length || w.del!.length)
    if (cursor !== this.#cursor) writes.push({ store: "kv", kv: [["cursor", cursor]] })
    if (!writes.length) return
    await this.db.write(writes)
    for (const [saved, id, k] of updates) {
      if (k === null) saved.delete(id)
      else saved.set(id, k)
    }
    this.#cursor = cursor
  }
}
