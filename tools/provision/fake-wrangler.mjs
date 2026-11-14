// A stand-in for wrangler in provision.test.mjs. Keeps account state in a JSON file and records
// every call. Never talks to Cloudflare.
import { readFileSync, writeFileSync } from "node:fs"

const file = process.env.FAKE_WRANGLER_STATE
const state = JSON.parse(readFileSync(file, "utf8"))
const args = process.argv.slice(2)
const cmd = args.filter((a) => !a.startsWith("-") && a !== "wrangler.deploy.json")
state.calls.push(args.join(" "))
const save = () => writeFileSync(file, JSON.stringify(state))
const stdin = () => readFileSync(0, "utf8")

switch (cmd.slice(0, 2).join(" ")) {
  case "whoami":
    save()
    if (!state.loggedIn) process.exit(1)
    console.log(JSON.stringify({ loggedIn: true }))
    break
  case "d1 list":
    console.log(JSON.stringify(state.databases))
    break
  case "d1 create":
    state.databases.push({ uuid: "11111111-2222-3333-4444-555555555555", name: cmd[2] })
    console.log("created")
    break
  case "r2 bucket":
    if (cmd[2] === "list")
      console.log(
        state.buckets
          .map((b) => `name:           ${b}\ncreation_date:  2026-01-01T00:00:00.000Z`)
          .join("\n\n"),
      )
    else state.buckets.push(cmd[3])
    break
  case "d1 migrations":
    state.migrated++
    break
  case "deploy":
    state.deployed++
    break
  case "secret list":
    console.log(
      JSON.stringify(Object.keys(state.secrets).map((name) => ({ name, type: "secret_text" }))),
    )
    break
  case "secret put":
    state.secrets[cmd[2]] = stdin()
    break
  default:
    console.error(`fake wrangler: unknown command ${args.join(" ")}`)
    process.exit(1)
}
save()
