// Runs provision.mjs against fake-wrangler.mjs in a temporary directory. Synthetic values only.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import {
  accessSteps,
  bucketNames,
  deployConfig,
  fromWorker,
  parseArgs,
  stripJsonc,
} from "./lib.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const template = join(here, "../../apps/worker/wrangler.jsonc")

const SETTINGS = {
  JOT_ACCESS_TEAM_DOMAIN: "https://synthetic-team.cloudflareaccess.com",
  JOT_ACCESS_AUD: "a".repeat(64),
  JOT_OWNER_EMAIL: "owner@example.com",
  JOT_SERVICE_TOKEN_CLIENT_ID: "0123456789abcdef0123456789abcdef.access",
}

function sandbox(initial = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jot-provision-"))
  copyFileSync(template, join(dir, "wrangler.jsonc"))
  const stateFile = join(dir, "state.json")
  const state = {
    loggedIn: true,
    databases: [],
    buckets: [],
    secrets: {},
    migrated: 0,
    deployed: 0,
    calls: [],
    ...initial,
  }
  writeFileSync(stateFile, JSON.stringify(state))
  const run = (args, env = {}) => {
    const r = spawnSync(
      process.execPath,
      [join(here, "provision.mjs"), "--skip-build", "--no-verify", ...args],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          JOT_PROVISION_WORKER_DIR: dir,
          JOT_PROVISION_WRANGLER: join(here, "fake-wrangler.mjs"),
          FAKE_WRANGLER_STATE: stateFile,
          ...env,
        },
      },
    )
    return {
      code: r.status,
      out: r.stdout + r.stderr,
      state: JSON.parse(readFileSync(stateFile, "utf8")),
    }
  }
  return { dir, run }
}

describe("provision", () => {
  it("creates everything once, then changes nothing on a re-run", () => {
    const { dir, run } = sandbox()
    const first = run(["--host", "notes.example.com"], SETTINGS)
    assert.equal(first.code, 0, first.out)
    assert.deepEqual(
      first.state.databases.map((d) => d.name),
      ["jot"],
    )
    assert.deepEqual(first.state.buckets, ["jot-files"])
    assert.equal(first.state.migrated, 1)
    assert.equal(first.state.deployed, 1)
    assert.deepEqual(first.state.secrets, {
      ACCESS_TEAM_DOMAIN: SETTINGS.JOT_ACCESS_TEAM_DOMAIN,
      ACCESS_AUD: SETTINGS.JOT_ACCESS_AUD,
      OWNER_EMAIL: SETTINGS.JOT_OWNER_EMAIL,
      SERVICE_TOKEN_CLIENT_ID: SETTINGS.JOT_SERVICE_TOKEN_CLIENT_ID,
    })
    // Secret values never reach the output.
    for (const v of Object.values(SETTINGS)) assert.ok(!first.out.includes(v), v)
    const cfg = JSON.parse(readFileSync(join(dir, "wrangler.deploy.json"), "utf8"))
    assert.equal(cfg.d1_databases[0].database_id, "11111111-2222-3333-4444-555555555555")
    assert.deepEqual(cfg.routes, [{ pattern: "notes.example.com", custom_domain: true }])
    assert.deepEqual(cfg.assets.run_worker_first, ["/api/*", "/device-api/*"])
    assert.ok(first.state.calls.includes("deploy -c wrangler.deploy.json"))

    // No host, no settings: everything comes from what exists.
    const again = run([])
    assert.equal(again.code, 0, again.out)
    assert.equal(again.state.databases.length, 1)
    assert.equal(again.state.buckets.length, 1)
    assert.ok(
      !again.state.calls.slice(first.state.calls.length).some((c) => /create|secret put/.test(c)),
    )
    assert.match(again.out, /all four set/)
    assert.equal(again.state.deployed, 2)
  })

  it("stops and lists what is missing when it can't ask", () => {
    const { run } = sandbox()
    const r = run(["--host", "notes.example.com"], { JOT_ACCESS_AUD: SETTINGS.JOT_ACCESS_AUD })
    assert.equal(r.code, 2)
    assert.match(r.out, /Access → Applications → Add → Self-hosted/)
    assert.match(r.out, /--team-domain/)
    assert.match(r.out, /--service-token-id/)
    assert.doesNotMatch(r.out, /--aud /)
    assert.deepEqual(r.state.secrets, {})
  })

  it("refuses a malformed value before setting any secret", () => {
    const { run } = sandbox()
    const r = run(["--host", "notes.example.com"], {
      ...SETTINGS,
      JOT_SERVICE_TOKEN_CLIENT_ID: "synthetic-secret-value",
    })
    assert.equal(r.code, 2)
    assert.match(r.out, /SERVICE_TOKEN_CLIENT_ID doesn't look right/)
    assert.deepEqual(r.state.secrets, {})
  })

  it("refuses the Global API Key and a missing login before touching anything", () => {
    const { run } = sandbox()
    const key = run(["--host", "notes.example.com"], { CLOUDFLARE_API_KEY: "synthetic" })
    assert.equal(key.code, 1)
    assert.match(key.out, /Global API Key/)
    assert.deepEqual(key.state.calls, [])
    const out = sandbox({ loggedIn: false }).run(["--host", "notes.example.com"], SETTINGS)
    assert.equal(out.code, 1)
    assert.match(out.out, /wrangler login/)
    assert.deepEqual(out.state.calls, ["whoami --json"])
  })

  it("rejects a bad hostname", () => {
    const r = sandbox().run(["--host", "https://notes.example.com/"])
    assert.equal(r.code, 2)
    assert.equal(r.state.databases.length, 0)
  })
})

describe("lib", () => {
  it("strips JSONC without touching strings", () => {
    const text = `{
      // comment
      "a": "/api/*", /* block */ "b": "http://x//y",
      "c": [1, 2,],
    }`
    assert.deepEqual(JSON.parse(stripJsonc(text)), { a: "/api/*", b: "http://x//y", c: [1, 2] })
  })

  it("fills in the database id and route", () => {
    const cfg = JSON.parse(
      deployConfig(readFileSync(template, "utf8"), { databaseId: "x", host: "h.example.com" }),
    )
    assert.equal(cfg.name, "jot")
    assert.equal(cfg.workers_dev, false)
    assert.equal(cfg.d1_databases[0].database_id, "x")
  })

  it("puts Access on /api only (ADR-0019)", () => {
    assert.match(accessSteps("notes.example.com"), /Domain: notes\.example\.com, path: api /)
  })

  it("tells the Worker's own refusal from Access", () => {
    assert.equal(fromWorker('{"error":"forbidden"}'), true)
    assert.equal(fromWorker('{"error":"auth_not_configured"}'), true)
    assert.equal(fromWorker("<!DOCTYPE html><title>Forbidden</title>"), false)
    assert.equal(fromWorker(""), false)
  })

  it("parses r2 bucket lists and arguments", () => {
    assert.deepEqual(
      bucketNames(
        "Listing buckets...\nname:  a\ncreation_date: 1\n\nname:  jot-files\ncreation_date: 2",
      ),
      ["a", "jot-files"],
    )
    assert.deepEqual(parseArgs(["--host", "h", "--no-verify", "--aud=x"]), {
      host: "h",
      "no-verify": true,
      aud: "x",
    })
  })
})
