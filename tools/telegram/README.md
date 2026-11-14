# Telegram → jotter

Run every step yourself. No agent should open the exports, the JSONL, or a passphrase. Keep
everything in `~/jot-import/` (outside any synced folder and every repo) and delete it when done.

How notes are routed to open and locked channels:
[ADR-0012](../../docs/adr/0012-telegram-import-routing.md). Tests on synthetic exports:
`pnpm nx test telegram-import`.

## 1. Export from Telegram Desktop

For each chat you want, including the group holding your sensitive notes, one at a time:
⋮ → **Export chat history** → tick Photos (untick videos/files for a quick first run) → Format
**JSON** → save under `~/jot-import/tg/<chat-name>/`.

## 2. Start the local jotter

```sh
cd path/to/this/repo
pnpm nx build @jot/web @jot/cli
node apps/worker/scripts/local-server.mjs 8787 .wrangler/local   # leave running
```

In a second terminal (on macOS, `/usr/bin/jot` is a different program; see the
[README](../../README.md#the-jot-command-on-macos) for a permanent fix):

```sh
cd path/to/this/repo
alias jot="node $PWD/apps/cli/dist/jot.mjs"
export JOT_SERVER=http://127.0.0.1:8787
jot keygen -o ~/jot-import/open-key.txt && export JOT_OPEN_KEY_FILE=~/jot-import/open-key.txt
cat ~/jot-import/open-key.txt          # copy it for the browser
```

Open http://127.0.0.1:8787, choose **Use this key**, paste it. In the app: New channel →
**Locked**, name it, set its passphrase. Then `jot channels` and copy the locked channel's id.

## 3. Convert

```sh
python3 -I tools/telegram/tg_to_jsonl.py \
  --sensitive ~/jot-import/tg/<sensitive-group>/result.json \
  --locked-channel <locked id> \
  --out ~/jot-import/notes.jsonl \
  ~/jot-import/tg/<chat>/result.json  [more exports...]
```

It prints counts only. Check two things:

- **"not found in other exports"**: sensitive notes whose original it could not match. Find each
  original in Telegram by date. If it was edited, the original would land in an open channel. Fix
  it by adding the exact original to the sensitive group and exporting again, or pass
  `--lock-chat "<chat name>"`.
- **"open channels to create first"**: these become agent-readable. Create each one with
  `jot channels create "<name>"`. For any chat that should stay private entirely, pass
  `--lock-chat "<name>"`.

## 4. Import, then clean up

```sh
jot import ~/jot-import/notes.jsonl --dry-run
jot import ~/jot-import/notes.jsonl     # safe to rerun; skips what is already there
rm ~/jot-import/notes.jsonl             # plaintext; the jotter holds the encrypted copy
```

Import fetches link previews for open channels (`--no-previews` to skip). Notes imported before
that, or skipped with `--no-previews`, get them with `jot previews` (all open channels) or
`jot previews -c <channel>`. Locked channels never get previews unless you run
`jot unlock <id> previews -c <id> --locked`.

Browse at http://127.0.0.1:8787. When you're done, delete `~/jot-import/tg/` too (it holds the
plaintext exports).
