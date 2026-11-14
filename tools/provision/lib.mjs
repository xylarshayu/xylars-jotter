// Pure helpers for provision.mjs, kept separate so they can be tested without Cloudflare.

export const DB_NAME = "jot"
export const BUCKET = "jot-files"
export const DEPLOY_CONFIG = "wrangler.deploy.json"

/** The Worker secrets the Access check needs (ADR-0010), with how to recognise a valid value. */
export const SECRETS = [
  {
    name: "ACCESS_TEAM_DOMAIN",
    flag: "team-domain",
    env: "JOT_ACCESS_TEAM_DOMAIN",
    hint: "https://<team>.cloudflareaccess.com",
    valid: (v) => /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(v),
  },
  {
    name: "ACCESS_AUD",
    flag: "aud",
    env: "JOT_ACCESS_AUD",
    hint: "the application's Audience (AUD) tag, 64 hex characters",
    valid: (v) => /^[0-9a-f]{64}$/.test(v),
  },
  {
    name: "OWNER_EMAIL",
    flag: "owner-email",
    env: "JOT_OWNER_EMAIL",
    hint: "the email in the Access Allow policy",
    valid: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  },
  {
    name: "SERVICE_TOKEN_CLIENT_ID",
    flag: "service-token-id",
    env: "JOT_SERVICE_TOKEN_CLIENT_ID",
    hint: "the service token's Client ID (ends in .access), not its secret",
    valid: (v) => /^[0-9a-f]{32}\.access$/.test(v),
  },
]

export function validHost(h) {
  return (
    typeof h === "string" &&
    h.length <= 253 &&
    /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)
  )
}

/** Walks text outside JSON strings; `visit` returns how much to skip and what to emit. */
function outsideStrings(text, visit) {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
      continue
    }
    const [skip, emit] = visit(text, i)
    out += emit
    i += skip - 1
  }
  return out
}

/** JSONC (comments, trailing commas) to JSON text. String-aware, so "/api/*" survives. */
export function stripJsonc(text) {
  const noComments = outsideStrings(text, (t, i) => {
    if (t[i] === "/" && t[i + 1] === "/") {
      const end = t.indexOf("\n", i)
      return [(end < 0 ? t.length : end) - i, ""]
    }
    if (t[i] === "/" && t[i + 1] === "*") {
      const end = t.indexOf("*/", i + 2)
      return [(end < 0 ? t.length : end + 2) - i, ""]
    }
    return [1, t[i]]
  })
  return outsideStrings(noComments, (t, i) =>
    t[i] === "," && /^\s*[}\]]/.test(t.slice(i + 1)) ? [1, ""] : [1, t[i]],
  )
}

/** The committed wrangler.jsonc with this deployment's database id and custom domain filled in. */
export function deployConfig(templateText, { databaseId, host }) {
  const cfg = JSON.parse(stripJsonc(templateText))
  const db = cfg.d1_databases?.find((d) => d.binding === "DB")
  if (!db) throw new Error("wrangler.jsonc has no DB binding")
  db.database_id = databaseId
  cfg.routes = [{ pattern: host, custom_domain: true }]
  return JSON.stringify(cfg, null, 2) + "\n"
}

/** Reads host and database id back from a generated config, for re-runs. */
export function readDeployConfig(text) {
  try {
    const cfg = JSON.parse(text)
    return {
      host: cfg.routes?.[0]?.pattern,
      databaseId: cfg.d1_databases?.find((d) => d.binding === "DB")?.database_id,
    }
  } catch {
    return {}
  }
}

/** `wrangler d1 list --json`: [{ uuid, name, … }]. Tolerates a banner before the JSON. */
export function findDatabase(text, name) {
  const start = text.indexOf("[")
  if (start < 0) throw new Error("unexpected `wrangler d1 list --json` output")
  const list = JSON.parse(text.slice(start))
  return list.find((d) => d.name === name)?.uuid
}

/** `wrangler r2 bucket list`: blocks of "name: …" / "creation_date: …". */
export function bucketNames(text) {
  return [...text.matchAll(/^name:\s+(\S+)\s*$/gm)].map((m) => m[1])
}

/** `wrangler secret list` (JSON by default): [{ name, type }]. Empty when the Worker is new. */
export function secretNames(text) {
  const start = text.indexOf("[")
  if (start < 0) return []
  try {
    return JSON.parse(text.slice(start)).map((s) => s.name)
  } catch {
    return []
  }
}

/** Minimal --flag value / --flag=value / --switch parsing. */
export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`)
    const eq = a.indexOf("=")
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1)
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i]
    else out[a.slice(2)] = true
  }
  return out
}

export function accessSteps(host) {
  return `Cloudflare Access (dashboard, once). Cloudflare One → Zero Trust:
  1. Settings → Team name: note your team domain, https://<team>.cloudflareaccess.com.
  2. Access → Service credentials → Service Tokens → Create, name "jot-cli".
     Copy the Client ID and Client Secret now (the secret is shown once). Keep the secret
     for the CLI; only the Client ID goes to the Worker.
  3. Access → Applications → Add → Self-hosted:
     - Domain: ${host}, path: api (protects /api; the app's static files stay public, and
       paired devices use /device-api with their own sessions, ADR-0019).
     - Session duration: e.g. 1 month.
     - Policy "Owner": Action Allow, Include → Emails → your email. Add MFA if you like.
     - Policy "CLI": Action Service Auth, Include → Service Token → jot-cli.
     - Save, then copy the Application Audience (AUD) Tag from its Overview.`
}

/** The Worker's own refusals are JSON like {"error":"forbidden"}; Access answers with a page. */
export function fromWorker(body) {
  try {
    return typeof JSON.parse(body).error === "string"
  } catch {
    return false
  }
}
