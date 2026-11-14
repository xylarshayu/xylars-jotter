# Synthetic test vectors

Generated with Go `age` v1.3.2. Every key and passphrase here is synthetic and used only by tests.

- `synthetic-identity.txt` / `synthetic-recipient.txt`: hybrid ML-KEM-768 + X25519 key pair (`age-keygen -pq`).
- `vector-plaintext.txt`: plaintext.
- `vector-hybrid.age`: `age -R synthetic-recipient.txt vector-plaintext.txt`.
- `vector-wrapped-identity.age`: `synthetic-identity.txt` encrypted with the passphrase
  `synthetic-passphrase-for-tests-only` (scrypt work factor 10, via `age-plugin-batchpass`).
