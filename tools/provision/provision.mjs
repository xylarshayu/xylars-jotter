#!/usr/bin/env node
// Provisions and deploys your own instance on Cloudflare. Safe to re-run: every step checks what
// exists first. See DEPLOY.md. Usage: pnpm provision [--host notes.example.com] [options]
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"
import {
  BUCKET,
  DB_NAME,
  DEPLOY_CONFIG,
  SECRETS,
  accessSteps,
  bucketNames,
  deployConfig,
  findDatabase,
  fromWorker,
  parseArgs,
  readDeployConfig,
  secretNames,
  validHost,
} from "./lib.mjs"

const HELP = `pnpm provision [options]

Creates the D1 database and R2 bucket if missing, writes apps/worker/${DEPLOY_CONFIG}
(gitignored), builds the web app, applies migrations, deploys, sets the Access secrets and checks
that Access guards the API but not /device-api. Every step is skipped when already done.

  --host <name>              hostname to serve on, e.g. notes.example.com (a zone on your account)
  --team-domain <url>        https://<team>.cloudflareaccess.com         (or JOT_ACCESS_TEAM_DOMAIN)
  --aud <tag>                Access application AUD tag                   (or JOT_ACCESS_AUD)
  --owner-email <email>      the email in the Access Allow policy         (or JOT_OWNER_EMAIL)
  --service-token-id <id>    service token Client ID, ends in .access     (or JOT_SERVICE_TOKEN_CLIENT_ID)
  --reset-secrets            set the four secrets again even if present
  --skip-build               don't rebuild apps/web
  --no-verify                skip the final HTTP check
  --help

Missing values are asked for in a terminal. Without one (an agent, CI) the run stops and lists
what to pass. Log in first with \`pnpm --filter @jot/worker exec wrangler login\` or set
CLOUDFLARE_API_TOKEN to a scoped token. The Global API Key is refused.`

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
// Overrides exist for the tests, which run against a fake wrangler in a temporary directory.
const workerDir = process.env.JOT_PROVISION_WORKER_DIR ?? join(root, "apps/worker")
const wranglerCmd = process.env.JOT_PROVISION_WRANGLER
  ? [process.execPath, process.env.JOT_PROVISION_WRANGLER]
  : [join(workerDir, "node_modules/.bin/wrangler")]
const configPath = join(workerDir, DEPLOY_CONFIG)

const say = (s = "") => process.stdout.write(s + "\n")
const step = (s) => say(`\n▸ ${s}`)
const done = (s) => say(`  ✓ ${s}`)

class Stop extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

/** Runs wrangler. `capture` returns stdout; otherwise output streams to the terminal. */
function wrangler(args, { capture = false, input, allowFail = false } = {}) {
  const r = spawnSync(wranglerCmd[0], [...wranglerCmd.slice(1), ...args], {
    cwd: workerDir,
    encoding: "utf8",
    input,
    // stdin is never a terminal, so wrangler takes its non-interactive defaults and never
    // waits on a prompt.
    stdio: [
      input === undefined ? "ignore" : "pipe",
      capture ? "pipe" : "inherit",
      capture ? "pipe" : "inherit",
    ],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  })
  if (r.error) throw new Stop(`could not run wrangler: ${r.error.message}`)
  if (r.status !== 0 && !allowFail)
    throw new Stop(
      `wrangler ${args.slice(0, 3).join(" ")} failed${capture ? `:\n${r.stderr || r.stdout}` : ""}`,
    )
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" }
}

let rl
async function ask(question) {
  if (!process.stdin.isTTY) return undefined
  rl ??= createInterface({ input: process.stdin, output: process.stdout })
  return (await rl.question(`  ${question}: `)).trim() || undefined
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return say(HELP)

  // The Global API Key can do anything on the account; wrangler would use it silently.
  if (process.env.CLOUDFLARE_API_KEY || process.env.CF_API_KEY)
    throw new Stop(
      "CLOUDFLARE_API_KEY is set: that is the Global API Key. Unset it and use `wrangler login` or a scoped CLOUDFLARE_API_TOKEN.",
    )

  step("Cloudflare login")
  const who = wrangler(["whoami", "--json"], { capture: true, allowFail: true })
  if (!who.ok)
    throw new Stop(
      "Not logged in. Run `pnpm --filter @jot/worker exec wrangler login` (or set CLOUDFLARE_API_TOKEN to a scoped token), then re-run.",
    )
  done("logged in")

  const previous = existsSync(configPath) ? readDeployConfig(readFileSync(configPath, "utf8")) : {}
  let host = (args.host ?? process.env.JOT_HOST ?? previous.host)?.toLowerCase()
  if (!host) host = (await ask("Hostname to serve on (e.g. notes.example.com)"))?.toLowerCase()
  if (!host)
    throw new Stop("Pass --host <name>, a hostname in a zone on your Cloudflare account.", 2)
  if (!validHost(host)) throw new Stop(`Not a hostname: ${host}`, 2)
  if (previous.host && previous.host !== host)
    say(
      `  note: changing the hostname from ${previous.host} to ${host}; update the Access application too.`,
    )

  step(`D1 database "${DB_NAME}"`)
  let databaseId = findDatabase(wrangler(["d1", "list", "--json"], { capture: true }).out, DB_NAME)
  if (databaseId) done(`exists (${databaseId})`)
  else {
    wrangler(["d1", "create", DB_NAME], { capture: true })
    databaseId = findDatabase(wrangler(["d1", "list", "--json"], { capture: true }).out, DB_NAME)
    if (!databaseId) throw new Stop("created the database but can't find it in `wrangler d1 list`")
    done(`created (${databaseId})`)
  }

  step(`R2 bucket "${BUCKET}"`)
  if (bucketNames(wrangler(["r2", "bucket", "list"], { capture: true }).out).includes(BUCKET))
    done("exists")
  else {
    wrangler(["r2", "bucket", "create", BUCKET], { capture: true })
    done("created")
  }

  step(`Config apps/worker/${DEPLOY_CONFIG}`)
  const config = deployConfig(readFileSync(join(workerDir, "wrangler.jsonc"), "utf8"), {
    databaseId,
    host,
  })
  if (existsSync(configPath) && readFileSync(configPath, "utf8") === config) done("up to date")
  else {
    writeFileSync(configPath, config)
    done(`written (host ${host})`)
  }
  const c = ["-c", DEPLOY_CONFIG]

  if (!args["skip-build"]) {
    step("Build the web app")
    const b = spawnSync("pnpm", ["nx", "build", "@jot/web"], { cwd: root, stdio: "inherit" })
    if (b.status !== 0) throw new Stop("web build failed")
    done("built")
  }

  step("Database migrations")
  wrangler(["d1", "migrations", "apply", DB_NAME, "--remote", ...c])
  done("applied")

  step("Deploy the Worker")
  wrangler(["deploy", ...c])
  done(`deployed to https://${host}`)

  step("Access secrets")
  const present = new Set(
    secretNames(wrangler(["secret", "list", ...c], { capture: true, allowFail: true }).out),
  )
  const needed = SECRETS.filter((s) => args["reset-secrets"] || !present.has(s.name))
  if (!needed.length) done("all four set (--reset-secrets to change them)")
  else {
    const values = new Map()
    const missing = []
    for (const s of needed) {
      const v = args[s.flag] ?? process.env[s.env]
      if (v !== undefined) values.set(s, String(v).trim())
    }
    if (needed.some((s) => !values.has(s))) {
      say()
      say(accessSteps(host))
      say()
    }
    for (const s of needed) {
      if (!values.has(s)) {
        const v = await ask(`${s.name} (${s.hint})`)
        if (v === undefined) {
          missing.push(s)
          continue
        }
        values.set(s, v)
      }
      if (!s.valid(values.get(s)))
        throw new Stop(`${s.name} doesn't look right: expected ${s.hint}. Nothing more was set.`, 2)
    }
    if (missing.length)
      throw new Stop(
        `Set up Access as above, then re-run with:\n${missing.map((s) => `  --${s.flag} <${s.hint}>`).join("\n")}\nUntil then the API answers auth_not_configured (it fails closed).`,
        2,
      )
    for (const s of needed) {
      wrangler(["secret", "put", s.name, ...c], { capture: true, input: values.get(s) })
      done(`${s.name} set`)
    }
  }

  if (!args["no-verify"]) await verify(host)

  say(`
Done. Next (DEPLOY.md, "After provisioning"):
  - create the open key: node apps/cli/dist/jot.mjs keygen -o ~/.config/jot/open-key.txt
  - CLI config ~/.config/jot/config.json: { "server": "https://${host}", "openKeyFile": "~/.config/jot/open-key.txt" }
  - CLI credentials: CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET in your environment
  - phone: open https://${host}, sign in, paste the key, install the app`)
}

/**
 * Access must answer /api before the Worker does; a JSON refusal from the Worker means it doesn't.
 * /device-api must reach the Worker, or browsers can't pair without signing in (ADR-0019).
 */
async function verify(host) {
  step("Check that Access guards the API")
  let res
  try {
    res = await fetch(`https://${host}/api/me`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    say(
      `  ! couldn't reach https://${host} yet (${e.cause?.code ?? e.message}). New domains can take a few minutes; re-run to check.`,
    )
    return
  }
  const location = res.headers.get("location") ?? ""
  if (res.status === 200)
    throw new Stop(
      `https://${host}/api/me answered 200 without credentials. Access is not in front of it. Fix the Access application now.`,
    )
  if ((res.status === 302 || res.status === 303) && /cloudflareaccess\.com/.test(location))
    done("unauthenticated requests go to the Access login")
  else if (!fromWorker(await res.text().catch(() => "")))
    done(`unauthenticated requests are stopped before the Worker (${res.status})`)
  else {
    say(
      `  ! got ${res.status} from the Worker itself, so Access isn't covering ${host} yet. The Worker still refuses (it fails closed), but set up the Access application.`,
    )
    process.exitCode = 3
  }
  const dev = await fetch(`https://${host}/device-api/me`, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined)
  const devBody = dev ? await dev.text().catch(() => "") : ""
  if (dev?.status === 401 && fromWorker(devBody))
    done("/device-api reaches the Worker, which asks for a device session")
  else {
    say(
      `  ! /device-api/me got ${dev?.status ?? "no answer"} instead of the Worker's 401. If Access covers the whole hostname, set the application's path to "api" so new browsers can pair without signing in.`,
    )
    process.exitCode = 3
  }
  const id = process.env.CF_ACCESS_CLIENT_ID
  const secret = process.env.CF_ACCESS_CLIENT_SECRET
  if (!id || !secret) {
    say(
      "  (set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to also check the CLI's service token)",
    )
    return
  }
  const me = await fetch(`https://${host}/api/me`, {
    headers: { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined)
  const body = me?.ok ? await me.json().catch(() => ({})) : {}
  if (body.userId) done(`service token works (user ${body.userId})`)
  else {
    say(
      `  ! the service token check got ${me?.status ?? "no answer"}. Check the "CLI" policy and SERVICE_TOKEN_CLIENT_ID.`,
    )
    process.exitCode = 3
  }
}

main()
  .catch((e) => {
    if (!(e instanceof Stop)) throw e
    process.stderr.write(`\n✗ ${e.message}\n`)
    process.exitCode = e.code
  })
  .finally(() => rl?.close())
