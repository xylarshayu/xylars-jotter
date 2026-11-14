/**
 * App state and actions. Everything that touches keys or plaintext goes
 * through here so the rules stay in one place:
 * - locked-channel plaintext lives in memory only and is dropped on lock;
 * - IndexedDB gets ciphertext, the open key, open-channel plaintext and a paired device's session
 *   token; a temporary device (ADR-0016) writes nothing there and keeps it all in memory;
 * - errors shown to the user never include note content.
 */
import {
  Api,
  ApiError,
  approvePairing,
  checkPairing,
  isOpenChannel,
  LockedError,
  MAX_ATTACHMENT_PLAIN_BYTES,
  Notebook,
  PairingError,
  parseImportLine,
  receivePairing,
  Replica,
  startPairing,
  toImportLine,
  type AttachmentRef,
  type ChannelView,
  type DeviceRow,
  type NoteView,
  type PairingOffer,
  type PairingRequest,
  type SyncProgress,
} from "@jot/core"
import { CryptoError, generateKeyPair, isHybridIdentity, parseIdentity } from "@jot/crypto"
import { startAutoLock } from "./autolock.ts"
import { Db, IdbOutbox, Persist } from "./db.ts"
import { prepareFile, shrinkPreviewImage } from "./images.ts"
import { download, releaseAll, releaseUnreadable } from "./media.ts"
import { applyTheme, loadSettings, saveSettings, type Settings } from "./settings.ts"

export const ALL = "all"
export type Route =
  | { view: "feed"; channel: string }
  | { view: "settings" }
  /** Sending the open key to a new device; `link` is the scanned `#/pair/…` link, if any. */
  | { view: "pair"; link: string | null }
export interface Toast {
  id: number
  text: string
  kind: "info" | "error"
}

const PAGE = 60
const MAX_FILE_MB = Math.floor(MAX_ATTACHMENT_PLAIN_BYTES / 1024 / 1024)

export function parseHash(h: string): Route {
  if (h === "#/settings") return { view: "settings" }
  if (h === "#/pair") return { view: "pair", link: null }
  if (/^#\/pair\/[\w-]+\.[\w-]+$/.test(h)) return { view: "pair", link: h }
  const m = /^#\/c\/([0-9A-Z]{26})$/.exec(h)
  return { view: "feed", channel: m ? m[1]! : ALL }
}

export function hashFor(r: Route): string {
  if (r.view === "settings") return "#/settings"
  if (r.view === "pair") return r.link ?? "#/pair"
  return r.channel === ALL ? "#/" : `#/c/${r.channel}`
}

export function describe(e: unknown): string {
  if (e instanceof LockedError) return "That channel is locked."
  if (e instanceof CryptoError) return "Wrong passphrase."
  if (e instanceof PairingError) {
    return e.code === "mismatch"
      ? "This QR code doesn't match what the server returned. Don't pair; start again."
      : e.code === "bad_link"
        ? "That isn't a Jotter pairing code."
        : "The key that arrived doesn't work. Start again."
  }
  if (e instanceof ApiError) {
    if (e.status === 0) return "Can't reach the server."
    if (e.code === "temporary_device") return "A temporary device can't do that."
    if (e.status === 401 || e.status === 403) return "Your session expired. Sign in again."
    const known: Record<string, string> = {
      version_conflict: "That note changed on another device. Try again.",
      channel_not_empty: "Only empty channels can be deleted.",
      channel_exists: "That channel already exists.",
      attachment_too_large: `That file is too large (${MAX_FILE_MB} MB max).`,
      pairing_not_found: "That pairing expired. Start again on the new device.",
      pairing_used: "That device is already signed in.",
      too_many_pairings: "Too many pairings in progress. Try again in a few minutes.",
    }
    return known[e.code] ?? `The server refused that (${e.code}).`
  }
  return "Something went wrong."
}

/** Resolves after the browser has painted pending DOM changes. */
function nextPaint(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))
}

export function channelLabel(c: Pick<ChannelView, "id" | "name"> | undefined): string {
  if (!c) return "Unknown channel"
  return c.name ?? `Locked · ${c.id.slice(-4)}`
}

/** An entry in the menu a right click or long press opens on a note or channel. */
export interface MenuItem {
  label: string
  icon: string
  danger?: boolean
  run: () => void
}

class App {
  phase = $state<"loading" | "setup" | "ready" | "failed">("loading")
  route = $state<Route>(parseHash(location.hash))
  channels = $state.raw<ChannelView[]>([])
  feed = $state.raw<NoteView[]>([])
  feedMore = $state(false)
  /** The feed starts below the newest note, after "Jump to" from search. */
  feedNewer = $state(false)
  /** The note "Jump to" opened at: Feed scrolls to it and marks it briefly. */
  highlight = $state<string | null>(null)
  /** Hidden channels are listed until the app goes to the background (ADR-0021). */
  showHidden = $state(false)
  /** The first sync while setting this device up, for a progress bar. */
  setupProgress = $state.raw<SyncProgress | null>(null)
  searching = $state(false)
  /** In a channel, search covers just that channel unless this is set. */
  searchAll = $state(false)
  query = $state("")
  results = $state.raw<NoteView[]>([])
  online = $state(navigator.onLine)
  pending = $state(0)
  syncing = $state(false)
  /** Why the server stopped answering: an Access session or a device session ended. */
  needsLogin = $state<"access" | "pair" | null>(null)
  /** Showing the pairing screen inside the app, to sign a device in again after its session ended. */
  repairing = $state(false)
  /** Setup only: whether this browser has an Access session. null while checking or offline. */
  accessSignedIn = $state<boolean | null>(null)
  unlocked = $state.raw<string[]>([])
  settings = $state<Settings>(loadSettings())
  toasts = $state.raw<Toast[]>([])
  drawer = $state(false)
  panel = $state<"channel" | null>(null)
  selected = $state<string | null>(null)
  editing = $state.raw<NoteView | null>(null)
  draft = $state("")
  draftFiles = $state.raw<File[]>([])
  composeTo = $state<string | null>(null)
  lightbox = $state<string | null>(null)
  menu = $state.raw<{ x: number; y: number; items: MenuItem[] } | null>(null)
  openRecipient = $state("")
  /** Memory only: nothing in IndexedDB, forgotten on close or idle (ADR-0016). */
  temporary = $state(false)

  nb!: Notebook
  /** A paired device's session (ADR-0019). Kept in IndexedDB, or in memory on a temporary device. */
  #session: { token: string; deviceId: string } | null = null
  #db!: Db
  #persist!: Persist
  /** The feed shows notes [#offset, #offset + #limit) of the channel, newest first. */
  #offset = 0
  #limit = PAGE
  #jumpTo: string | null = null
  #openPanel = false
  #gen = 0
  #refreshQueued = false
  #saveTimer: ReturnType<typeof setTimeout> | undefined
  #syncing: Promise<void> | undefined
  #savedDraft = ""
  #toastId = 0
  #searchTimer: ReturnType<typeof setTimeout> | undefined
  #autolock: { stop(): void; touch(): void } | undefined
  #forgetTimer: { stop(): void; touch(): void } | undefined

  constructor() {
    try {
      this.composeTo = localStorage.getItem("jot.composeTo")
    } catch {
      this.composeTo = null
    }
  }

  /* ----------------------------- derived ---------------------------- */

  get current(): ChannelView | undefined {
    const r = this.route
    return r.view === "feed" && r.channel !== ALL
      ? this.channels.find((c) => c.id === r.channel)
      : undefined
  }

  channel(id: string): ChannelView | undefined {
    return this.channels.find((c) => c.id === id)
  }

  /** Where the composer sends: the open channel, or (in "All notes") the last used one. */
  get target(): ChannelView | undefined {
    if (this.current) return this.current
    const shown = this.shownChannels
    const open = shown.filter((c) => c.lock === "open")
    return shown.find((c) => c.id === this.composeTo) ?? open[0] ?? shown[0]
  }

  /** Hidden on this device and not being shown (ADR-0021). */
  hidden(channelId: string): boolean {
    return !this.showHidden && this.settings.hiddenChannels.includes(channelId)
  }

  /** The channels lists and pickers offer: everything not hidden. */
  get shownChannels(): ChannelView[] {
    return this.channels.filter((c) => !this.hidden(c.id))
  }

  get hiddenChannels(): ChannelView[] {
    return this.channels.filter((c) => this.settings.hiddenChannels.includes(c.id))
  }

  get enterSends(): boolean {
    const s = this.settings.enterSends
    return s === "on" || (s === "auto" && !matchMedia("(pointer: coarse)").matches)
  }

  #readable(channelId: string): boolean {
    const row = this.nb.replica.channels.get(channelId)
    return !!row && (isOpenChannel(row) || this.nb.keys.isUnlocked(channelId))
  }

  /* ------------------------------ start ----------------------------- */

  async start(): Promise<void> {
    applyTheme(this.settings.theme)
    addEventListener("hashchange", () => this.#onRoute())
    try {
      this.#db = await Db.open()
      this.#persist = new Persist(this.#db)
      const { snapshot, plain } = await this.#persist.load()
      this.#session =
        (await this.#db.get<{ token: string; deviceId: string }>("kv", "session")) ?? null
      this.nb = new Notebook({
        api: this.#api(),
        replica: Replica.from(snapshot),
        outbox: new IdbOutbox(this.#db),
        onChange: () => this.#changed(),
        shrinkImage: shrinkPreviewImage,
      })
      this.nb.keys.onChange(() => this.#keysChanged())
      await this.nb.restorePending()
      const key = await this.#db.get<string>("kv", "openKey")
      if (!key) {
        this.phase = "setup"
        void this.#probeAccess()
        return
      }
      await this.nb.keys.setOpenKey(key)
      this.nb.importPlainCache(plain)
    } catch {
      this.phase = "failed"
      return
    }
    await this.#ready()
  }

  #api(headers?: Record<string, string>): Api {
    return new Api({
      baseUrl: location.origin,
      headers: headers && (() => headers),
      session: () => this.#session?.token,
    })
  }

  /** Setup: is this browser signed in to Access? Pairing doesn't need it; pasting a key does. */
  async #probeAccess(): Promise<void> {
    try {
      await new Api({ baseUrl: location.origin }).me()
      this.accessSignedIn = true
    } catch (e) {
      this.accessSignedIn = e instanceof ApiError && e.status === 0 ? null : false
    }
  }

  async #ready(): Promise<void> {
    this.openRecipient = this.nb.keys.openRecipient ?? ""
    // Channels first: the composer needs a target the moment it appears.
    this.channels = await this.nb.channelViews()
    this.phase = "ready"
    await this.refresh()
    this.#background()
    void this.sync().then(() => this.#warm())
    void this.#takeShare()
  }

  #background(): void {
    addEventListener("online", () => {
      this.online = true
      void this.sync()
    })
    addEventListener("offline", () => (this.online = false))
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.sync()
      else {
        void this.save()
        this.setShowHidden(false)
      }
    })
    addEventListener("pagehide", () => void this.save())
    setInterval(() => {
      if (document.visibilityState === "visible") void this.sync()
    }, 30_000)
    this.#autolock = startAutoLock({
      idleMs: () => this.settings.idleMinutes * 60_000,
      hideGraceMs: () => this.settings.hideGraceSeconds * 1000,
      hasUnlocked: () => this.nb.keys.unlockedIds().length > 0,
      lock: () => this.lockAll(),
    })
    if (this.temporary) {
      // Forget the whole device after the same idle time, hidden or not, and when the tab closes.
      this.#forgetTimer = startAutoLock({
        idleMs: () => this.settings.idleMinutes * 60_000,
        hideGraceMs: () => this.settings.idleMinutes * 60_000,
        hasUnlocked: () => true,
        lock: () => this.forgetTemporary(),
      })
      // Restored from the back/forward cache after a forget: start over.
      addEventListener("pageshow", (e) => {
        if (e.persisted && !this.nb.keys.hasOpenKey) location.replace("/")
      })
    }
  }

  /** Decrypts open notes in the background so search is instant; persisted as the plaintext cache. */
  async #warm(): Promise<void> {
    let n = 0
    for (const row of [...this.nb.replica.notes.values()]) {
      if (row.deletedAt !== null) continue
      const ch = this.nb.replica.channels.get(row.channelId)
      if (!ch || !isOpenChannel(ch)) continue
      await this.nb.noteView(row)
      if (++n % 20 === 0) await new Promise((r) => setTimeout(r, 0))
    }
    if (n) this.#scheduleSave()
  }

  /* ------------------------------ setup ----------------------------- */

  /**
   * Returns an error message, or null when the device is set up. A temporary device keeps the
   * key, replica and outbox in memory only and drops this browser's (empty) database.
   */
  async useKey(text: string, opts: { temporary?: boolean } = {}): Promise<string | null> {
    let key: string
    try {
      key = parseIdentity(text)
    } catch {
      return "That isn't an open key. It starts with AGE-SECRET-KEY-PQ-1."
    }
    if (!isHybridIdentity(key)) return "That isn't an open key. It starts with AGE-SECRET-KEY-PQ-1."
    if (opts.temporary && !this.temporary) await this.#becomeTemporary()
    await this.nb.keys.setOpenKey(key)
    try {
      await this.nb.sync({ onProgress: (p) => (this.setupProgress = p) })
    } catch (e) {
      this.nb.keys.clear()
      return describe(e)
    } finally {
      this.setupProgress = null
    }
    const open = [...this.nb.replica.channels.values()].filter(
      (c) => c.deletedAt === null && isOpenChannel(c),
    )
    if (open.length) {
      const ids = await Promise.all(open.map((c) => this.nb.keys.identityFor(c)))
      if (!ids.some(Boolean)) {
        this.nb.keys.clear()
        return "This key doesn't open your notes."
      }
    } else {
      // A key made with `jot keygen` on an empty account: start with an Inbox.
      try {
        await this.nb.createChannel({ name: "Inbox", lock: "open" })
      } catch (e) {
        this.nb.keys.clear()
        return describe(e)
      }
    }
    if (!this.temporary) {
      const kv: [string, unknown][] = [["openKey", key]]
      if (this.#session) kv.push(["session", this.#session])
      await this.#db.write([{ store: "kv", kv }])
    }
    await this.#ready()
    return null
  }

  /** Swaps to an in-memory notebook. Only called during setup, before any key is set. */
  async #becomeTemporary(): Promise<void> {
    this.temporary = true
    this.nb = new Notebook({
      // Tells the service worker not to cache attachment ciphertext either.
      api: this.#api({ "x-jot-no-store": "1" }),
      replica: Replica.from(undefined),
      onChange: () => this.#changed(),
      shrinkImage: shrinkPreviewImage,
    })
    this.nb.keys.onChange(() => this.#keysChanged())
    this.#db.close()
    await Db.destroy().catch(() => {})
  }

  /* ----------------------------- pairing ---------------------------- */

  /** New device: registers a one-time key and returns what the QR and the screen show. */
  async pairStart(temporary: boolean): Promise<PairingRequest | string> {
    try {
      return await startPairing(this.nb.api, location.origin, { temporary })
    } catch (e) {
      return describe(e)
    }
  }

  /**
   * New device: null while waiting, "" once signed in and set up, else an error message. Also
   * signs in again a device whose session ended, if the key that arrives is the one it has.
   */
  async pairPoll(req: PairingRequest): Promise<string | null> {
    let paired: Awaited<ReturnType<typeof receivePairing>>
    try {
      paired = await receivePairing(this.nb.api, req)
    } catch (e) {
      return describe(e)
    }
    if (!paired) return null
    const session = { token: paired.token, deviceId: paired.device.id }
    if (this.phase === "ready") {
      if (paired.key !== this.nb.keys.openIdentity?.trim()) {
        this.#revoke(session)
        return "That device has a different open key. Forget this device and set it up again."
      }
      this.#session = session
      if (!this.temporary) await this.#db.write([{ store: "kv", kv: [["session", session]] }])
      this.repairing = false
      this.needsLogin = null
      void this.sync()
      return ""
    }
    this.#session = session
    const err = await this.useKey(paired.key, { temporary: req.temporary })
    if (err) {
      this.#revoke(session)
      this.#session = null
    }
    return err ?? ""
  }

  /** New device: deletes a pairing that won't be completed. */
  pairCancel(req: PairingRequest): void {
    void this.nb.api.cancelPairing(req.id, req.secret).catch(() => {})
  }

  /** Signed-in device: checks a scanned link against the one-time key the Worker holds. */
  async pairCheck(link: string): Promise<PairingOffer | string> {
    try {
      return await checkPairing(this.nb.api, link)
    } catch (e) {
      return describe(e)
    }
  }

  /** Signed-in device: signs the new device in and seals the open key to its one-time key. */
  async pairApprove(offer: PairingOffer): Promise<string | null> {
    const key = this.nb.keys.openIdentity
    if (!key) return "This device has no open key."
    try {
      await approvePairing(this.nb.api, offer, key)
      return null
    } catch (e) {
      return describe(e)
    }
  }

  pairReject(offer: PairingOffer): void {
    void this.nb.api.rejectPairing(offer.id).catch(() => {})
  }

  /* ----------------------------- devices ----------------------------- */

  async devices(): Promise<DeviceRow[] | string> {
    try {
      return await this.nb.api.devices()
    } catch (e) {
      return describe(e)
    }
  }

  async signOutDevice(id: string): Promise<string | null> {
    try {
      await this.nb.api.revokeDevice(id)
      return null
    } catch (e) {
      return describe(e)
    }
  }

  /** Ends a device session on the server, best effort. Survives the page unloading. */
  #revoke(session: { token: string; deviceId: string } | null): void {
    if (!session) return
    void fetch(`/device-api/devices/${encodeURIComponent(session.deviceId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${session.token}` },
      keepalive: true,
    }).catch(() => {})
  }

  async newKey(): Promise<{ identity: string; recipient: string } | string> {
    try {
      await this.nb.sync()
    } catch (e) {
      return describe(e)
    }
    if ([...this.nb.replica.channels.values()].some((c) => c.deletedAt === null)) {
      return "This account already has notes. Paste its open key instead."
    }
    return generateKeyPair()
  }

  async finishNewKey(identity: string): Promise<string | null> {
    await this.nb.keys.setOpenKey(identity)
    try {
      await this.nb.createChannel({ name: "Inbox", lock: "open" })
    } catch (e) {
      this.nb.keys.clear()
      return describe(e)
    }
    await this.#db.write([{ store: "kv", kv: [["openKey", identity]] }])
    await this.#ready()
    return null
  }

  /* ------------------------- sync and refresh ----------------------- */

  sync(): Promise<void> {
    this.#syncing ??= this.#sync().finally(() => (this.#syncing = undefined))
    return this.#syncing
  }

  async #sync(): Promise<void> {
    this.syncing = true
    try {
      const r = await this.nb.flush()
      if (r.rejected.length) this.toast("The server refused a change; it was undone.", "error")
      await this.nb.sync()
      this.needsLogin = null
      this.online = true
      await this.save() // persist promptly so the next offline start has it
    } catch (e) {
      if (e instanceof ApiError && e.code === "session_revoked") void this.#signedOutElsewhere()
      else if (e instanceof ApiError && (e.status === 401 || e.status === 403))
        this.needsLogin = this.#session ? "pair" : "access"
      else if (e instanceof ApiError && e.status === 0) this.online = false
    } finally {
      this.syncing = false
      this.pending = await this.nb.pendingCount()
    }
  }

  #changed(): void {
    this.#scheduleRefresh()
    this.#scheduleSave()
  }

  #scheduleRefresh(): void {
    if (this.#refreshQueued) return
    this.#refreshQueued = true
    queueMicrotask(() => {
      this.#refreshQueued = false
      void this.refresh()
    })
  }

  #scheduleSave(): void {
    clearTimeout(this.#saveTimer)
    // Short: the app can be closed at any moment. Pending writes are safe
    // regardless (the outbox is written first and restored on start).
    this.#saveTimer = setTimeout(() => void this.save(), 50)
  }

  async save(): Promise<void> {
    if (this.temporary) return
    try {
      await this.#persist?.save(this.nb)
    } catch {
      /* storage full or closed; the server copy is authoritative */
    }
  }

  async refresh(): Promise<void> {
    if (this.phase !== "ready") return
    const gen = ++this.#gen
    const channels = await this.nb.channelViews()
    let feed: NoteView[] = []
    let more = false
    const r = this.route
    if (r.view === "feed") {
      const ch = r.channel === ALL ? undefined : r.channel
      if (!ch || this.nb.replica.channels.has(ch)) {
        const notes = await this.nb.notes(ch, {
          offset: this.#offset,
          limit: this.#limit + 1,
          // "All notes" leaves hidden channels out. A hidden channel itself still opens.
          skip: ch
            ? undefined
            : new Set(this.settings.hiddenChannels.filter((id) => this.hidden(id))),
        })
        more = notes.length > this.#limit
        feed = notes.slice(0, this.#limit)
      }
    }
    const results = this.searching && this.query.trim() ? await this.#search() : []
    const pending = await this.nb.pendingCount()
    if (gen !== this.#gen) return
    this.channels = channels
    this.feed = feed
    this.feedMore = more
    this.feedNewer = this.#offset > 0
    this.results = results
    this.pending = pending
  }

  loadOlder(): Promise<void> {
    this.#limit += PAGE
    return this.refresh()
  }

  /** After a jump: brings in the next page of newer notes. */
  loadNewer(): Promise<void> {
    const step = Math.min(PAGE, this.#offset)
    this.#offset -= step
    this.#limit += step
    return this.refresh()
  }

  /** Back to the newest notes, e.g. after sending from a feed that starts further back. */
  #toNewest(): void {
    if (!this.#offset) return
    this.#offset = 0
    this.#limit = PAGE
    void this.refresh()
  }

  #onRoute(): void {
    this.route = parseHash(location.hash)
    this.#offset = 0
    this.#limit = PAGE
    const jump = this.#jumpTo
    this.#jumpTo = null
    if (jump && this.route.view === "feed") {
      const ch = this.route.channel === ALL ? undefined : this.route.channel
      const at = this.nb.notePosition(jump, ch)
      if (at >= 0) {
        // Half a page of newer notes below it, the rest older above; both directions load more.
        this.#offset = Math.max(0, at - PAGE / 2)
        this.highlight = jump
      }
    }
    this.selected = null
    this.panel = this.#openPanel ? "channel" : null
    this.#openPanel = false
    this.menu = null
    this.drawer = false
    if (this.editing) this.cancelEdit()
    void this.refresh()
  }

  go(r: Route): void {
    const h = hashFor(r)
    if (location.hash !== h && !(h === "#/" && location.hash === "")) location.hash = h
    else this.#onRoute()
  }

  /* ------------------------------ search ---------------------------- */

  openSearch(): void {
    if (!this.searching) this.searchAll = false
    this.searching = true
  }

  /** The channel search is limited to, if any: the one on screen, unless searching everywhere. */
  get searchChannel(): ChannelView | undefined {
    return this.searchAll ? undefined : this.current
  }

  setSearchAll(all: boolean): void {
    this.searchAll = all
    void this.refresh()
  }

  closeSearch(): void {
    this.searching = false
    this.query = ""
    this.results = []
  }

  searchSoon(): void {
    clearTimeout(this.#searchTimer)
    this.#searchTimer = setTimeout(() => void this.refresh(), 120)
  }

  async #search(): Promise<NoteView[]> {
    const notes = await this.nb.search(this.query, this.searchChannel?.id)
    return notes.filter((n) => !this.hidden(n.channelId)).slice(0, 200)
  }

  /** Opens a channel with its options showing (rename, passphrase, hide, delete). */
  channelOptions(channelId: string): void {
    this.#openPanel = true
    this.go({ view: "feed", channel: channelId })
  }

  /** Opens a search result in its channel, among the notes around it. */
  jumpTo(n: NoteView): void {
    this.#jumpTo = n.id
    this.closeSearch()
    this.go({ view: "feed", channel: n.channelId })
  }

  /* ------------------------------ notes ----------------------------- */

  async send(text: string, files: File[]): Promise<boolean> {
    const to = this.target
    if (!to) {
      this.toast("Create a channel first.", "error")
      return false
    }
    // Check every file first, so a big one doesn't leave the others uploaded without a note.
    const big = files.find((f) => f.size > MAX_ATTACHMENT_PLAIN_BYTES)
    if (big) {
      this.toast(`${big.name || "That file"} is too large (${MAX_FILE_MB} MB max).`, "error")
      return false
    }
    try {
      const attachments: AttachmentRef[] = []
      for (const f of files) {
        const p = await prepareFile(f)
        attachments.push(
          await this.nb.addAttachment(to.id, p.data, p.mime, {
            name: p.name,
            width: p.width,
            height: p.height,
          }),
        )
      }
      const note = await this.nb.addNote(to.id, text, { attachments })
      this.#toNewest()
      if (this.route.view === "feed" && this.route.channel === ALL) this.#remember(to.id)
      if (to.lock !== "open" && !to.unlocked) this.toast("Added to the locked channel.")
      // Previews: automatic in open channels only; locked channels ask first.
      if (to.lock === "open" && note.links.length) void this.#previews(note.id, note.links, false)
      return true
    } catch (e) {
      this.toast(describe(e), "error")
      return false
    } finally {
      this.pending = await this.nb.pendingCount()
    }
  }

  #remember(id: string): void {
    this.composeTo = id
    if (this.temporary) return
    try {
      localStorage.setItem("jot.composeTo", id)
    } catch {
      /* ignore */
    }
  }

  setComposeTo(id: string): void {
    if (this.current && this.current.id !== id) this.go({ view: "feed", channel: id })
    else this.#remember(id)
  }

  async #previews(id: string, links: string[], tell: boolean): Promise<void> {
    try {
      const items = await this.nb.fetchPreviews(links)
      if (items.length) await this.nb.setPreviews(id, items)
      else if (tell) this.toast("No preview available.")
    } catch {
      if (tell) this.toast("No preview available.")
    }
  }

  fetchPreview(n: NoteView): void {
    void this.#previews(n.id, n.links, true)
  }

  startEdit(n: NoteView): void {
    if (!this.editing) this.#savedDraft = this.draft
    this.editing = n
    this.draft = n.text
    this.selected = null
  }

  cancelEdit(): void {
    this.editing = null
    this.draft = this.#savedDraft
    this.#savedDraft = ""
  }

  async saveEdit(text: string): Promise<void> {
    const n = this.editing
    if (!n) return
    if (!text.trim() && !n.attachments.length) {
      this.toast("A note can't be empty. Delete it instead.", "error")
      return
    }
    this.cancelEdit()
    if (text === n.text) return
    try {
      await this.nb.editNote(n.id, text)
    } catch (e) {
      this.toast(describe(e), "error")
    }
  }

  async move(n: NoteView, to: string): Promise<void> {
    this.selected = null
    try {
      await this.nb.moveNote(n.id, to)
      this.toast(`Moved to ${channelLabel(this.channel(to))}.`)
    } catch (e) {
      this.toast(describe(e), "error")
    }
  }

  async remove(n: NoteView): Promise<void> {
    this.selected = null
    try {
      await this.nb.deleteNote(n.id)
      this.toast("Deleted. Earlier versions stay in history.")
    } catch (e) {
      this.toast(describe(e), "error")
    }
  }

  async copy(n: NoteView): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(n.text)
      this.toast("Copied.")
      return true
    } catch {
      this.toast("Couldn't copy.", "error")
      return false
    }
  }

  history(n: NoteView) {
    return this.nb.history(n.id)
  }

  /* ---------------------------- channels ---------------------------- */

  async createChannel(name: string, passphrase?: string): Promise<boolean> {
    try {
      const row = await this.nb.createChannel(
        passphrase ? { name, lock: "locked", passphrase } : { name, lock: "open" },
      )
      await this.refresh()
      this.go({ view: "feed", channel: row.id })
      return true
    } catch (e) {
      this.toast(describe(e), "error")
      return false
    }
  }

  async renameChannel(id: string, name: string): Promise<boolean> {
    try {
      await this.nb.renameChannel(id, name)
      return true
    } catch (e) {
      this.toast(describe(e), "error")
      return false
    }
  }

  async changePassphrase(id: string, oldPass: string, newPass: string): Promise<boolean> {
    try {
      await this.nb.changePassphrase(id, oldPass, newPass)
      this.toast("Passphrase changed.")
      return true
    } catch (e) {
      this.toast(describe(e), "error")
      return false
    }
  }

  async deleteChannel(id: string): Promise<boolean> {
    try {
      await this.nb.deleteChannel(id)
      this.go({ view: "feed", channel: ALL })
      return true
    } catch (e) {
      this.toast(describe(e), "error")
      return false
    }
  }

  /* ------------------------------ locking ---------------------------- */

  /** Resolves once the channel's notes are on screen, so "Unlocking…" covers all of it. */
  async unlock(channelId: string, passphrase: string): Promise<boolean> {
    // scrypt runs on this thread and blocks it for a second or two: paint "Unlocking…" first.
    await nextPaint()
    try {
      await this.nb.unlock(channelId, passphrase)
    } catch {
      return false
    }
    this.#autolock?.touch()
    await this.refresh()
    return true
  }

  lockAll(): void {
    this.nb.keys.lockAll()
  }

  lock(channelId: string): void {
    this.nb.keys.lock(channelId)
  }

  #keysChanged(): void {
    this.unlocked = this.nb.keys.unlockedIds()
    const readable = (id: string) => this.#readable(id)
    // Drop locked plaintext from the screen right away, before the async refresh.
    this.feed = this.feed.filter((n) => readable(n.channelId))
    this.results = this.results.filter((n) => readable(n.channelId))
    if (this.editing && !readable(this.editing.channelId)) this.cancelEdit()
    releaseUnreadable(readable)
    this.lightbox = null
    this.selected = null
    this.#scheduleRefresh()
  }

  /* ----------------------------- settings ---------------------------- */

  /** Hides a channel on this device only. Its notes stay as they are (ADR-0021). */
  setHidden(channelId: string, hide: boolean): void {
    const ids = this.settings.hiddenChannels.filter((id) => id !== channelId)
    this.updateSettings({ hiddenChannels: hide ? [...ids, channelId] : ids })
    if (!hide) return void this.refresh()
    this.toast("Hidden on this device. The eye in the sidebar shows hidden channels.")
    // Hiding means out of sight now, even while hidden channels are being shown.
    this.showHidden = true
    this.setShowHidden(false)
  }

  setShowHidden(show: boolean): void {
    if (this.showHidden === show) return
    this.showHidden = show
    const r = this.route
    if (!show && r.view === "feed" && this.hidden(r.channel))
      this.go({ view: "feed", channel: ALL })
    else void this.refresh()
  }

  updateSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch }
    saveSettings(this.settings)
    applyTheme(this.settings.theme)
  }

  cycleTheme(): void {
    const next = { system: "light", light: "dark", dark: "system" } as const
    this.updateSettings({ theme: next[this.settings.theme] })
  }

  /** Another device signed this one out: wipe it, as if the owner had chosen "Forget". */
  async #signedOutElsewhere(): Promise<void> {
    this.#session = null
    if (this.temporary) this.forgetTemporary()
    else await this.forgetDevice("/?signed-out")
  }

  async forgetDevice(then = "/"): Promise<void> {
    this.#revoke(this.#session)
    this.#session = null
    this.#autolock?.stop()
    this.nb?.keys.clear()
    releaseAll()
    this.#db?.close()
    await Db.destroy().catch(() => {})
    for (const k of await caches.keys().catch(() => [] as string[])) await caches.delete(k)
    try {
      localStorage.clear()
    } catch {
      /* ignore */
    }
    location.replace(then)
  }

  /**
   * Temporary device: drops the keys and every decrypted note from memory, then reloads to the
   * setup screen. Runs on idle and on pagehide, where the reload may not happen.
   */
  forgetTemporary(signOut = false): void {
    this.#forgetTimer?.stop()
    this.#autolock?.stop()
    // The session ends with the tab: it was only ever in memory, and the Worker drops it too.
    const viaAccess = !this.#session
    this.#revoke(this.#session)
    this.#session = null
    this.nb.keys.clear()
    releaseAll()
    this.nb = new Notebook({ api: new Api({ baseUrl: location.origin }) })
    this.channels = []
    this.feed = []
    this.results = []
    this.editing = null
    this.draft = ""
    this.draftFiles = []
    this.lightbox = null
    // Access keeps its own session cookie; signing out ends it on a borrowed laptop.
    location.replace(signOut && viaAccess ? "/cdn-cgi/access/logout" : "/")
  }

  /** Through Access. A paired device whose session ended pairs again instead (`repairing`). */
  signIn(): void {
    location.assign("/api/login")
  }

  get deviceId(): string | null {
    return this.#session?.deviceId ?? null
  }

  /* ------------------------------ toasts ----------------------------- */

  toast(text: string, kind: Toast["kind"] = "info"): void {
    const id = ++this.#toastId
    this.toasts = [...this.toasts, { id, text, kind }].slice(-3)
    setTimeout(
      () => (this.toasts = this.toasts.filter((t) => t.id !== id)),
      kind === "error" ? 5000 : 2200,
    )
  }

  /* --------------------------- share target -------------------------- */

  /** Picks up an Android share. The service worker holds it in memory only. */
  async #takeShare(): Promise<void> {
    const params = new URLSearchParams(location.search)
    if (!params.has("share")) return
    history.replaceState(null, "", location.pathname + location.hash)
    const reg = await navigator.serviceWorker?.ready
    const sw = reg?.active
    if (!sw) return
    const data = await new Promise<{
      title?: string
      text?: string
      url?: string
      files: File[]
    } | null>((resolve) => {
      const ch = new MessageChannel()
      ch.port1.onmessage = (e) => resolve(e.data as never)
      sw.postMessage({ type: "take-share" }, [ch.port2])
      setTimeout(() => resolve(null), 3000)
    })
    if (!data) {
      this.toast("The shared item was lost. Share it again.", "error")
      return
    }
    const parts: string[] = []
    for (const p of [data.title, data.text, data.url]) {
      const t = p?.trim()
      if (t && !parts.some((x) => x.includes(t))) parts.push(t)
    }
    this.draft = [this.draft.trim(), ...parts].filter(Boolean).join("\n")
    this.draftFiles = [...this.draftFiles, ...data.files]
    this.toast("Choose a channel, then send.")
  }

  /* ------------------------- import and export ----------------------- */

  async importJsonl(file: File): Promise<string> {
    const lines = (await file.text()).split(/\r?\n/)
    const items: {
      text: string
      createdAt: number
      sourceId: string
      links: string[]
      channelId: string
    }[] = []
    const errors: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!.trim()
      if (!raw) continue
      try {
        const it = parseImportLine(raw)
        const ch = await this.nb.findChannel(it.channel)
        if (!ch) errors.push(`line ${i + 1}: unknown channel (create it first)`)
        else if (it.attachments?.length)
          errors.push(`line ${i + 1}: attachments need the CLI (jot import)`)
        else
          items.push({
            text: it.text,
            createdAt: Date.parse(it.created_at),
            sourceId: it.source_id,
            links: it.links ?? [],
            channelId: ch.id,
          })
      } catch {
        errors.push(`line ${i + 1}: not a valid record`) // never echo content
      }
    }
    if (errors.length) {
      const more = errors.length > 5 ? `\n…and ${errors.length - 5} more` : ""
      return `Nothing imported.\n${errors.slice(0, 5).join("\n")}${more}`
    }
    const before = this.nb.replica.notes.size
    for (const it of items) {
      await this.nb.addNote(it.channelId, it.text, {
        createdAt: it.createdAt,
        sourceId: it.sourceId,
        links: it.links,
      })
    }
    const pending = await this.nb.pendingCount()
    if (pending) return `Queued ${items.length} notes; they will upload when you're online.`
    const created = this.nb.replica.notes.size - before
    return `Imported ${created}; ${items.length - created} were already here.`
  }

  async exportJsonl(): Promise<void> {
    const lines: string[] = []
    for (const c of this.channels) {
      if (c.lock !== "open" || !c.name) continue
      const notes = await this.nb.notes(c.id)
      for (const n of notes.reverse()) lines.push(JSON.stringify(toImportLine(n, c.name)))
    }
    const day = new Date().toISOString().slice(0, 10)
    download(
      lines.join("\n") + (lines.length ? "\n" : ""),
      `jotter-open-${day}.jsonl`,
      "application/jsonl",
    )
  }
}

export const app = new App()
