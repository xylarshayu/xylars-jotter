-- Every row carries user_id so multi-user is not a rewrite later.
-- Content columns hold age ciphertext only. Plaintext: ids, timestamps (unix ms), sizes, versions, lock kind.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE channels (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  lock TEXT NOT NULL CHECK (lock IN ('open', 'locked')),
  recipient TEXT NOT NULL,
  wrapped_key BLOB NOT NULL,
  name BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  seq INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX channels_by_seq ON channels (user_id, seq);

CREATE TABLE notes (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  body BLOB NOT NULL,
  preview BLOB,
  size INTEGER NOT NULL,
  source_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  seq INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX notes_by_seq ON notes (user_id, seq);
CREATE INDEX notes_by_channel ON notes (user_id, channel_id);
CREATE UNIQUE INDEX notes_by_source ON notes (user_id, source_hash) WHERE source_hash IS NOT NULL;

-- Soft history: previous ciphertext versions of a note.
CREATE TABLE note_versions (
  user_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  body BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, note_id, version)
);

-- Attachment ciphertext lives in R2 under u/<user_id>/a/<id>.
CREATE TABLE attachments (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
