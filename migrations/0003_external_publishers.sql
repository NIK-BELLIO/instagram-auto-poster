PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS external_publishers (
  user_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'webhook',
  webhook_url_cipher TEXT NOT NULL,
  webhook_url_iv TEXT NOT NULL,
  secret_cipher TEXT,
  secret_iv TEXT,
  connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
