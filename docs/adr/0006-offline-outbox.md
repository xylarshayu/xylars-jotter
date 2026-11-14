# ADR-0006: Offline outbox holds ciphertext; the server is authoritative

Status: accepted (2026-11-12)

## Decision

- Every write is encrypted first, then queued in an outbox (IndexedDB in the PWA, memory in the
  CLI) and applied optimistically to the local replica with `seq = -1`.
- Outbox keys are strictly increasing, so writes flush in order. Attachments go before notes.
- A network error, 401 or 5xx stops the flush and keeps the op. Any other rejection drops the
  op, removes optimistic rows nothing else will confirm and resyncs from cursor 0.
- On start the PWA rebuilds optimistic rows from the outbox (`restorePending`), because the
  replica is saved a moment after the outbox and the app can be closed in between.
- Edits carry `baseVersion`; a conflict is rejected (the server copy wins and the edit is
  undone with a message). With one user this is rare enough not to merge.

## Consequences

No plaintext is ever queued. A write made offline can be lost only by clearing site data before
it uploads.
