PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS provider_accounts (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'ayrshare',
  profile_key_cipher TEXT NOT NULL,
  profile_key_iv TEXT NOT NULL,
  ref_id TEXT,
  title TEXT,
  connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, provider),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
