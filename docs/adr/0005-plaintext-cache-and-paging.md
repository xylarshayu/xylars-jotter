# ADR-0005: Open-channel plaintext cache and paged decryption

Status: accepted (2026-11-12)

## Context

Hybrid decryption is about 1.7 ms per note. Thousands of imported notes would make every feed
render and every CLI call slow.

## Decision

- `Notebook.notes()` decrypts lazily, newest first, with a limit (the feed loads more on
  scroll).
- Decrypted open-channel notes are cached by note version. The cache can be exported and
  re-imported: the CLI writes it to `~/.cache/jot/` (mode 600) and the PWA to IndexedDB.
- The exported cache contains only notes whose channel passes `isOpenChannel` (lock `open`,
  hybrid-wrapped key, matching recipient) and only live notes at their current version. Locked
  plaintext is never exported, even while unlocked.

## Consequences

Open plaintext rests on devices that hold the open key anyway (and in the mirror on the owner's laptop).
Search and feeds are instant after the first decrypt.
