// Starts the Worker locally (Miniflare via `wrangler dev`) with a fresh or given D1/R2 state.
// Usage: node scripts/local-server.mjs [port] [persistDir]
// No Cloudflare login needed. AUTH_MODE=dev only accepts localhost requests.
import { spawn, execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const port = process.argv[2] ?? "8787"
const persist = process.argv[3]
  ? resolve(process.argv[3])
  : mkdtempSync(join(tmpdir(), "jot-local-"))
const wrangler = join(root, "node_modules", ".bin", "wrangler")
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }
mkdirSync(join(root, "..", "web", "dist"), { recursive: true }) // assets dir must exist

execFileSync(wrangler, ["d1", "migrations", "apply", "jot", "--local", "--persist-to", persist], {
  cwd: root,
  env,
  stdio: "ignore",
})
const child = spawn(
  wrangler,
  [
    "dev",
    "--var",
    "AUTH_MODE:dev",
    "--port",
    port,
    "--ip",
    "127.0.0.1",
    "--persist-to",
    persist,
    "--show-interactive-dev-session=false",
  ],
  { cwd: root, env, stdio: "inherit" },
)
const stop = () => child.kill("SIGTERM")
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
child.on("exit", (code) => process.exit(code ?? 0))
