# Xylar's Jotter

End-to-end encrypted notes that are as quick to jot into as a chat. Your AI agents can read and
write some of them, and can never read the rest. You run it on your own Cloudflare account.

- **Capture like a chat.** Type and press Enter, on your phone or a laptop. Share into it from
  Android. It works offline.
- **Open channels** are for notes your agents should see. They read and write them through a CLI,
  a JSON API and a plain Markdown mirror on disk.
- **Locked channels** each have their own passphrase, which is never stored. Agents and the
  server can't read them, though anyone signed in can still add to them without unlocking.
- **Post-quantum, and no lock-in.** Every note, preview and file is an
  [age](https://age-encryption.org) file encrypted to hybrid ML-KEM-768 + X25519 keys. If this
  app disappears, `age -d` still opens everything.
- **Yours to run.** A Worker, D1 and R2 on your own Cloudflare account, its API behind Cloudflare
  Access.
  There is no hosted version and no telemetry. `pnpm provision` sets it up
  ([DEPLOY.md](DEPLOY.md)).

It's built for one person per deployment. It is not multi-user, not a sharing or collaboration
tool, and it has not had an independent security audit. Read the
[threat model](docs/threat-model.md) before trusting it with anything.

## Features

- **Web app (PWA)**: feed per channel and across open channels, composer always at hand
  (Enter sends), search including link previews (their images kept as small thumbnails,
  [ADR-0020](docs/adr/0020-small-preview-images.md)) with "Jump to" a result among the notes
  around it, channels hidden per device ([ADR-0021](docs/adr/0021-hidden-channels.md)),
  one-tap copy, files of any type up to 95 MB (images and GIFs inline,
  [ADR-0017](docs/adr/0017-any-file-attachments.md)), edit/move/delete with history, Android share target, offline outbox, light/dark. A new browser signs in by showing
  a QR that the phone scans and approves, with no login on that browser. It can be a temporary
  device that keeps nothing. Settings → Devices signs paired devices out
  ([ADR-0016](docs/adr/0016-device-pairing.md), [ADR-0019](docs/adr/0019-device-sessions.md)).
- **Locked channels**: their own passphrase each; append without unlocking; auto-lock after
  idle time or when the app is hidden; plaintext never stored. Their names are readable with the
  open key ([ADR-0014](docs/adr/0014-locked-names-readable-with-open-key.md)).
- **CLI `jot`** for agents and scripts: `add` (with `-f` files), `files`, `list`, `search`, `read`, `edit`, `mv`, `rm`,
  `channels`, `import`, `previews`, `export`, `mirror`, `migrate`, `unlock`; `--json` output.
- **Mirror**: open channels as Markdown in `~/jot/notes/`, locked ones as age files in
  `~/jot/notes-locked/` (both configurable).

## Deploy your own

See [DEPLOY.md](DEPLOY.md). In short: log in with wrangler, run
`pnpm provision --host notes.example.com`, set up Cloudflare Access in the dashboard, then run
`pnpm provision` again with the four values it asks for. It's written so that an agent can follow
it for you; [AGENTS.md](AGENTS.md) has the rules agents follow in this repository.

## Quickstart (local, no Cloudflare account)

Needs Node 24 and pnpm (`corepack enable`). Go `age` v1.3+ is optional (interop tests).

```sh
pnpm install
pnpm check                                     # lint, typecheck, test, build everything

# Worker + API + built web app on http://127.0.0.1:8787 (local D1/R2, dev auth)
pnpm nx build @jot/web
node apps/worker/scripts/local-server.mjs 8787 .wrangler/local
```

Open http://127.0.0.1:8787 and choose "Create a new key". For hot reload while working on the
UI, run the Worker (`pnpm --filter @jot/worker migrate:local && pnpm --filter @jot/worker dev`)
and `pnpm --filter @jot/web dev` (Vite proxies `/api` and `/device-api` to the Worker).

To try pairing locally, open the same address in a second browser (or another browser profile),
choose "Pair with your phone", and open its "Can't scan?" link in the first one. Dev auth is
localhost-only, so a real phone can't reach a local server. To see the setup screen of a browser
that isn't signed in, set the cookie `jot_dev_signed_out=1` for the local address.

CLI against the local server:

```sh
pnpm nx build @jot/cli
alias jot="node $PWD/apps/cli/dist/jot.mjs"
export JOT_SERVER=http://127.0.0.1:8787
jot keygen -o /tmp/jot-open-key.txt && export JOT_OPEN_KEY_FILE=/tmp/jot-open-key.txt
jot channels create Inbox                      # set "defaultChannel" in the config to skip -c
jot add -c Inbox "a synthetic note https://example.com"
jot search synthetic --json
jot add -c Inbox -f report.pdf archive.zip       # any file, up to 95 MB each
jot files <note-id> -o ~/Downloads             # open channels only; never overwrites
printf 'a synthetic passphrase\n' | jot channels create Vault --locked
echo "appended without unlocking" | jot add -c <vault-id>   # id from `jot channels`
printf 'a synthetic passphrase\n' | jot unlock Vault list -c Vault   # passphrase on stdin only
jot mirror --notes-dir /tmp/notes --locked-dir /tmp/notes-locked
```

### The `jot` command on macOS

macOS ships an unrelated `/usr/bin/jot` (BSD), so a bare `jot channels` fails with
`jot: bad reps value: channels` wherever the alias isn't defined: a new terminal, a script, or an
agent's non-interactive shell. To fix it for good, put a wrapper earlier on your `PATH`:

```sh
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec node "%s/apps/cli/dist/jot.mjs" "$@"\n' "$PWD" > ~/.local/bin/jot
chmod +x ~/.local/bin/jot
# in ~/.zshrc, if it isn't there already: export PATH="$HOME/.local/bin:$PATH"
command -v jot   # should print ~/.local/bin/jot
```

End-to-end tests (Playwright against `wrangler dev`):

```sh
pnpm --filter @jot/web exec playwright install chromium
pnpm --filter @jot/web e2e
```

## Layout

| Path              | What                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `packages/crypto` | age wrapper: hybrid keys, encrypt/decrypt, passphrase-wrapped identities                   |
| `packages/core`   | schemas, API client, replica + sync, notebook (keys, notes, outbox, search), import/export |
| `apps/worker`     | Cloudflare Worker (Hono): REST API, D1, R2, link unfurl, static assets                     |
| `apps/web`        | Svelte 5 + Vite PWA                                                                        |
| `apps/cli`        | `jot` CLI, mirror, launchd template                                                        |
| `tools/telegram`  | Telegram export → JSONL converter (Python, standard library)                               |
| `tools/provision` | `pnpm provision`: creates and deploys your own instance (DEPLOY.md)                        |

## Docs

- [docs/BRIEF.md](docs/BRIEF.md): the build contract
- [DEPLOY.md](DEPLOY.md): deploying your own copy to Cloudflare with Access
- [docs/threat-model.md](docs/threat-model.md): who can learn what
- [docs/adr/](docs/adr/): design decisions
- [SECURITY.md](SECURITY.md)

## JSONL import format

One note per line; idempotent by `source_id`; channels must exist (import never creates them):

<!-- prettier-ignore -->
```jsonl
{"channel":"Inbox","created_at":"2026-01-02T03:04:05Z","text":"…","links":["https://…"],"attachments":[{"path":"img/1.jpg","mime":"image/jpeg"}],"source_id":"tg-123"}
```

`jot import notes.jsonl --dry-run` validates first. Attachment paths are relative to the file.
Import fetches link previews for notes in open channels (`--no-previews` to skip). `jot previews`
fills in the ones still missing ([ADR-0013](docs/adr/0013-cli-previews.md)), and
`jot previews --shrink` shrinks stored preview images that are too large
([ADR-0020](docs/adr/0020-small-preview-images.md)). Telegram exports:
[tools/telegram](tools/telegram/README.md).

## Licence

[Apache-2.0](LICENSE). See also [NOTICE](NOTICE).
