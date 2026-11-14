# ADR-0012: Telegram import routing fails toward locked

Status: accepted (2026-11-14)

## Context

The owner's Telegram notes are in several chats. The private ones were forwarded into one
sensitive group, but their originals also sit in ordinary chats, which would otherwise become open,
agent-readable channels. `tools/telegram/tg_to_jsonl.py` converts the exports to `jot import`
JSONL. It decides which channel each note goes to.

## Decision

Any doubt resolves to the locked channel:

- Every message in a `--sensitive` export is locked. So is every message of that chat (same chat
  id) found in another export, e.g. a full-account export, including newer messages.
- A message elsewhere whose normalized text (or, without text, media kind and size) matches a
  sensitive message is locked and keeps its own date and source id. The forwarded copy is then
  skipped, so the note is not imported twice.
- `--lock-chat NAME` locks a whole chat. A name that matches no chat stops the run before anything
  is written, so a typo can't leave that chat open.
- Everything else goes to an open channel named after its chat. The script lists those channels
  with counts, and import never creates channels, so each one is a deliberate `jot channels create`.

The script uses the standard library only, writes its output at mode 600 and prints counts and
message ids only, never text.

## Consequences

An original that was edited after forwarding no longer matches, so it would go open. The summary
lists every sensitive message without a match ("not found in other exports") for a manual check.
False matches (an identical short text in an unrelated chat) lock too much, which is the safe side.
