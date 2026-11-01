-- Additive: preserves existing agents, messages, approvals and project data.
CREATE TABLE IF NOT EXISTS agent_identities (
 key_id TEXT PRIMARY KEY,
 agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id),
 public_key TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_auth_challenges (
 id TEXT PRIMARY KEY,
 key_id TEXT NOT NULL,
 public_key TEXT NOT NULL,
 challenge TEXT NOT NULL,
 profile TEXT NOT NULL,
 scopes TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS agent_challenge_expiry ON agent_auth_challenges(expires_at);
CREATE TABLE IF NOT EXISTS agent_sessions (
 id TEXT PRIMARY KEY,
 agent_id TEXT NOT NULL REFERENCES agents(id),
 token_hash TEXT NOT NULL UNIQUE,
 scopes TEXT NOT NULL,
 audience TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS agent_session_expiry ON agent_sessions(expires_at);
CREATE TABLE IF NOT EXISTS agent_auth_rates (
 bucket TEXT PRIMARY KEY,
 attempts INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_rate_expiry ON agent_auth_rates(expires_at);
