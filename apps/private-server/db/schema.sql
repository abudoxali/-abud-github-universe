-- ABUD OS V2 alpha: isolated owner-only database.
-- Run only against the verified NEW abud_os database. Never run against existing projects.
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash CHAR(64) PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_states_expires_idx ON oauth_states (expires_at);
CREATE TABLE IF NOT EXISTS owner_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  github_user_id BIGINT NOT NULL,
  csrf_secret CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS owner_sessions_expires_idx ON owner_sessions (expires_at);
CREATE TABLE IF NOT EXISTS owner_workspaces (
  github_user_id BIGINT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  data JSONB NOT NULL DEFAULT '{"version":1,"focus":[],"projects":{},"events":[]}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
