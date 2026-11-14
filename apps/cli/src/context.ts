/** Configuration, local caches and the notebook for one CLI invocation. */
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Api, Notebook, Replica, type PlainEntry, type ReplicaSnapshot } from "@jot/core"
import { parseIdentity } from "@jot/crypto"
import { shrinkPreviewImage } from "./images.ts"

export interface Io {
  out(s: string): void
  err(s: string): void
  /** Reads all of stdin as text. */
  readStdin(): Promise<string>
  stdinIsTty: boolean
  env: Record<string, string | undefined>
  cwd: string
}

export class CliError extends Error {
  override name = "CliError"
}

export interface Config {
  server: string
  openKeyFile?: string
  notesDir: string
  lockedNotesDir: string
  cacheDir: string
  defaultChannel?: string
}

export function loadConfig(io: Io): Config {
  const env = io.env
  const home = env.HOME ?? homedir()
  const configPath =
    env.JOT_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "jot", "config.json")
  let file: Partial<Config> = {}
  if (existsSync(configPath)) {
    try {
      file = JSON.parse(readFileSync(configPath, "utf8")) as Partial<Config>
    } catch {
      throw new CliError(`cannot parse ${configPath}`)
    }
  }
  const server = env.JOT_SERVER ?? file.server
  if (!server)
    throw new CliError(
      "no server configured: set JOT_SERVER or `server` in ~/.config/jot/config.json",
    )
  const expand = (p: string) => resolve(io.cwd, p.replace(/^~(?=\/|$)/, home))
  const cfg: Config = {
    server: server.replace(/\/$/, ""),
    notesDir: expand(env.JOT_NOTES_DIR ?? file.notesDir ?? "~/jot/notes"),
    lockedNotesDir: expand(env.JOT_LOCKED_NOTES_DIR ?? file.lockedNotesDir ?? "~/jot/notes-locked"),
    cacheDir: expand(env.JOT_CACHE_DIR ?? join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "jot")),
  }
  const keyFile = env.JOT_OPEN_KEY_FILE ?? file.openKeyFile
  if (keyFile) cfg.openKeyFile = expand(keyFile)
  const def = env.JOT_DEFAULT_CHANNEL ?? file.defaultChannel
  if (def) cfg.defaultChannel = def
  return cfg
}

/** Cloudflare Access service-token headers from the environment, if set. */
export function accessHeaders(io: Io): () => Record<string, string> {
  const id = io.env.CF_ACCESS_CLIENT_ID
  const secret = io.env.CF_ACCESS_CLIENT_SECRET
  const headers: Record<string, string> =
    id && secret ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {}
  return () => headers
}

export function readOpenKey(io: Io, cfg: Config): string | undefined {
  if (io.env.JOT_OPEN_KEY) return parseIdentity(io.env.JOT_OPEN_KEY)
  if (cfg.openKeyFile) {
    if (!existsSync(cfg.openKeyFile))
      throw new CliError(`open key file not found: ${cfg.openKeyFile}`)
    return parseIdentity(readFileSync(cfg.openKeyFile, "utf8"))
  }
  return undefined
}

/** Writes a file atomically with owner-only permissions. */
export function writePrivate(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, data, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

export class Context {
  readonly nb: Notebook
  readonly #replicaPath: string
  readonly #plainPath: string

  private constructor(
    readonly io: Io,
    readonly cfg: Config,
  ) {
    const tag = createHash("sha256").update(cfg.server).digest("hex").slice(0, 12)
    this.#replicaPath = join(cfg.cacheDir, `replica-${tag}.json`)
    this.#plainPath = join(cfg.cacheDir, `open-plaintext-${tag}.json`)
    const api = new Api({ baseUrl: cfg.server, headers: accessHeaders(io) })
    let snapshot: ReplicaSnapshot | undefined
    try {
      snapshot = JSON.parse(readFileSync(this.#replicaPath, "utf8")) as ReplicaSnapshot
    } catch {
      snapshot = undefined
    }
    this.nb = new Notebook({
      api,
      replica: Replica.from(snapshot),
      shrinkImage: shrinkPreviewImage,
    })
  }

  static async create(io: Io, opts: { requireOpenKey?: boolean } = {}): Promise<Context> {
    const cfg = loadConfig(io)
    const ctx = new Context(io, cfg)
    const key = readOpenKey(io, cfg)
    if (!key && opts.requireOpenKey !== false) {
      throw new CliError(
        "no open key: set JOT_OPEN_KEY_FILE (or JOT_OPEN_KEY), or `openKeyFile` in the config",
      )
    }
    await ctx.nb.keys.setOpenKey(key)
    await ctx.nb.sync()
    try {
      ctx.nb.importPlainCache(JSON.parse(readFileSync(ctx.#plainPath, "utf8")) as PlainEntry[])
    } catch {
      /* no cache yet */
    }
    return ctx
  }

  /** Persists the ciphertext replica and the open-channel plaintext cache (never locked plaintext). */
  save(): void {
    writePrivate(this.#replicaPath, JSON.stringify(this.nb.replica.snapshot()))
    writePrivate(this.#plainPath, JSON.stringify(this.nb.exportPlainCache()))
  }
}
