-- Device sessions (ADR-0019). Pairing now starts without a login and, once a signed-in device
-- approves it, also signs the new device in. Old pairing rows live minutes at most; dropping
-- them only cancels pairings in progress.
DROP TABLE pairings;

-- One row per pairing in progress, at most PAIRING_TTL_MS. Not part of sync, dump or the change
-- counter. Nothing in it is note content: a one-time public key, the open key sealed to it, and
-- what the Worker saw of the new device (browser family, OS, city).
CREATE TABLE pairings (
  id TEXT PRIMARY KEY,
  secret_hash BLOB NOT NULL,      -- SHA-256 of the secret only the new device holds
  source_hash BLOB NOT NULL,      -- SHA-256 of the client's IP (/64 for IPv6), for the per-source cap
  recipient TEXT NOT NULL,        -- the new device's one-time age1pq1 key
  temporary INTEGER NOT NULL,
  agent TEXT NOT NULL,            -- e.g. "Chrome on macOS", from a fixed vocabulary
  place TEXT NOT NULL,            -- e.g. "Pune, IN", from Cloudflare's geolocation; may be ""
  user_id TEXT,                   -- set when a signed-in device approves
  key_ciphertext BLOB,            -- the open key sealed to `recipient`, set on approval
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX pairings_by_expiry ON pairings (expires_at);
CREATE INDEX pairings_by_source ON pairings (source_hash);

-- A paired device's session. The token is a bearer secret; only its SHA-256 is stored.
CREATE TABLE devices (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  token_hash BLOB NOT NULL UNIQUE,
  temporary INTEGER NOT NULL,
  agent TEXT NOT NULL,
  place TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX devices_by_expiry ON devices (expires_at);
