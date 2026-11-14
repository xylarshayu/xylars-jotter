# ADR-0003: Locked channel names are encrypted; unlock by name tries the passphrase

Status: superseded by [ADR-0014](0014-locked-names-readable-with-open-key.md) (2026-11-14)

## Context

Channel names can be as revealing as content. Agents must not learn locked names.

## Decision

- Every channel name is an age file encrypted to the channel's own recipient. Open channel
  names are readable with the open key; locked names only while unlocked.
- While locked, clients show `Locked · <last 4 of id>`.
- `jot unlock <channel> …` accepts an id or a name. For a name, the CLI tries the passphrase on
  each locked channel (scrypt each time), keeps the one whose decrypted name matches, and locks
  the rest again immediately.

## Consequences

Unlocking by name costs one scrypt per locked channel (about a second each). Unlocking by id is
instant apart from one scrypt.
