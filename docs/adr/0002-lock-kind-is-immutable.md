# ADR-0002: Lock kind is immutable; moving into a locked channel purges history

Status: accepted (2026-11-12)

## Context

Converting an open channel to locked in place would leave everything it ever held readable by
agents (open-key-wrapped identity, mirrored Markdown, old versions). Converting locked to open
would silently expose content.

## Decision

- A channel's lock kind is fixed at creation. The Worker allows only a passphrase change on a
  locked channel (a new passphrase-wrapped identity); it never changes `lock`.
- The Worker checks that the wrapping matches the kind: open channels need a hybrid-encrypted
  identity, locked channels a passphrase-encrypted one (fail closed).
- Moving a note re-encrypts its body, previews and attachments to the target channel. Moving
  _into_ a locked channel must set `purgeHistory`, which deletes the stored older versions; the
  Worker returns `purge_required` otherwise.
- `jot mirror` removes the Markdown copy of a note that moved into a locked channel.

## Consequences

- To "lock" existing notes, create a locked channel and move them.
- Moving into locked can't un-expose what agents already read while the note was open. The old
  attachment blobs stay in R2, still encrypted to the open channel, until a future cleanup job.
