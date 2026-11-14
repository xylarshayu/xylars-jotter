# ADR-0013: CLI import fetches previews for open channels; `jot previews` backfills

Status: accepted (2026-11-14)

## Context

Imported notes had no link previews unless `jot import --previews` was given, so their links
weren't searchable by title or description. A note's previews can't be fixed by importing again,
because import is idempotent by `source_id` and skips notes already present.

## Decision

- `jot import` fetches previews by default for notes in open channels, after all notes are
  written. `--no-previews` turns this off. Notes imported into locked channels are never unfurled
  on import.
- `jot previews` fetches previews for notes that have links but none yet. With no `-c` it covers
  every open channel. `--refresh` re-fetches notes that already have them, and `-n` caps the
  number of notes.
- For a locked channel it needs `-c <id>`, `--locked` and a `jot unlock` session. That is the CLI
  equivalent of tapping "Fetch preview": unfurling sends the URLs to the Worker.
- Both fetch four notes at a time, print counts only, and fail if an update is still unsent at the
  end, so a rerun finishes the job.

## Consequences

A big import now takes longer and sends every open-channel URL to `/api/unfurl`, the same as
adding those notes one by one. A link with no metadata is tried again on each `jot previews` run.
