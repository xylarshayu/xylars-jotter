# ADR-0004: The Worker rejects anything that isn't hybrid age ciphertext

Status: accepted (2026-11-12)

## Context

The server can't read content, but it can stop a buggy or compromised client from storing
plaintext or classic-only ciphertext.

## Decision

Before storing a note body, preview, attachment or open-channel key, the Worker parses the
age header and requires at least one recipient stanza, all of type `mlkem768x25519`.
Locked-channel keys must be passphrase files (exactly one `scrypt` stanza). Channel recipients must be `age1pq1…`. Size limits
apply per kind.

## Consequences

Cheap header parsing only; the Worker never holds keys. Plaintext that a broken client tries to
upload fails with `*_not_pq_age` instead of being stored.
