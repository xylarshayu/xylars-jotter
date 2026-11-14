-- Device pairing relay (ADR-0016). A row lives at most a few minutes: the new
-- device's one-time public key, then the open key sealed to it. Deleted on
-- pickup, cancel or expiry. Not part of sync, dump or the change counter.
CREATE TABLE pairings (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  key_ciphertext BLOB,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX pairings_by_expiry ON pairings (expires_at);
