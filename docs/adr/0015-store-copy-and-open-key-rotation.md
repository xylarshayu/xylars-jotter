# ADR-0015: Moving to a new server copies the store as ciphertext and rotates the open key

Status: accepted (2026-11-14)

## Context

A local instance can hold real notes, including link previews fetched from the owner's own
connection. Many sites (X especially) refuse to unfurl from Cloudflare IPs, so going through
`jot export` and `jot import` would lose previews, history, source hashes and locked channels.
The local open key may have been handled in agent sessions while testing, so the deployment
should use a new one.

## Decision

- `jot migrate --from <url> --from-key-file <old key>` reads every row from the source's
  `GET /api/dump/{channels,notes,versions,attachments}` (ciphertext as stored, paged by rowid)
  and writes it to the configured server with `POST /api/restore`, `PUT /api/restore/attachments/:id`
  and `POST /api/restore/finish`.
- Restore writes rows as they are (ids, versions, timestamps, sync sequence, source hashes) with
  the same ciphertext checks as normal writes. It only works on an account with no `users` row,
  meaning one that was never written to. `finish` creates that row with the highest sequence,
  which closes restore for good. Rows are `INSERT OR IGNORE`, so an interrupted run can be
  repeated.
- Rotation happens in the CLI before upload. Each open channel's key is unwrapped with the old open
  key and re-wrapped to the new one. Every name it can read is re-sealed to the channel and the
  new key (ADR-0014). Locked channels' passphrase-wrapped keys are unchanged. The CLI checks that
  every re-wrapped key opens with the new key before uploading, refuses to reuse the old key,
  verifies row counts afterwards, and prints counts only.

## Consequences

- Nothing wrapped to the old open key reaches the new server.
- This re-wraps; it does not re-key. Open channel identities stay the same, so the old key plus an
  old copy of the wrapped keys (the local `.wrangler/local` store, `~/.cache/jot`, the local
  browser's IndexedDB) still unwraps channel keys that protect new notes on the deployed server.
  Deleting those old copies after the move closes this. A full re-key (new channel identities and
  re-encrypting every open note, preview, version and attachment) was left out as much more code
  and risk for this case.
- In-place rotation on a live server still isn't supported; it would be the same steps against a
  fresh deployment.
