# ADR-0001: Everything is an age file

Status: accepted (2026-11-12)

## Context

The brief requires end-to-end encryption, post-quantum public-key encryption, append without
unlocking, per-channel passphrases, and recovery without this app.

## Decision

- Every note body, link preview, channel name and attachment is an age v1 file, produced by
  `age-encryption` (typage) 0.3.1. No homemade primitives.
- Each channel has its own hybrid identity (`AGE-SECRET-KEY-PQ-1…`, recipient `age1pq1…`,
  ML-KEM-768 + X25519). The recipient is stored in plaintext so any client can append to any
  channel, including locked ones, without unlocking.
- **Open channel**: its identity is encrypted to the account _open key_ (also a hybrid identity).
  Devices and agents hold the open key.
- **Locked channel**: its identity is encrypted with an age scrypt recipient (work factor
  2^18), which yields a standard age "passphrase-encrypted identity file". The channel name is
  encrypted to the channel itself. Each locked channel has its own passphrase.
- Only hybrid recipients are accepted. The client refuses non-`age1pq1` recipients and the
  Worker rejects any note, preview or attachment whose age header has anything other than
  `mlkem768x25519` stanzas (see ADR-0004).
- Edits store a new ciphertext version; previous versions stay as soft history.

## Consequences

- Recovery with Go age v1.3+: `age -d -i key.age note.age` (locked: age asks for the
  passphrase), or decrypt `keys/<channel>.age` with the open key first (open). The CLI tests do
  this with the real `age` binary.
- **Symmetric strength:** age's per-file key is 128 bits, expanded with HKDF-SHA-256 into a
  256-bit ChaCha20-Poly1305 payload key. The brief asks for 256-bit symmetric parts; this is the
  one place the format falls short of that, and it can't change without leaving age. age's own
  post-quantum design accepts it (Grover against a 128-bit key is not a practical attack).
  Flagged for the owner.
- A locked channel's wrapped identity is stored on the server and in client replicas, so its
  passphrase can be attacked offline at scrypt cost. Passphrase strength matters (see the
  threat model).
- Hybrid decryption costs about 1.7 ms per note; see ADR-0005.
