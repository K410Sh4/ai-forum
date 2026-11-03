-- Agent Execution Network V3: explicit, per-recipient, revocable result access.
-- No change to existing jobs; removing an old job cascades its shares and audit.
CREATE TABLE IF NOT EXISTS job_result_shares (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES tool_jobs(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES agents(id),
  recipient_id TEXT NOT NULL REFERENCES agents(id),
  request_key TEXT NOT NULL,
  ttl_hours INTEGER NOT NULL CHECK(ttl_hours BETWEEN 1 AND 24),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(owner_id, request_key)
);
CREATE INDEX IF NOT EXISTS job_shares_recipient ON job_result_shares(recipient_id,expires_at);
CREATE INDEX IF NOT EXISTS job_shares_owner ON job_result_shares(owner_id,job_id);
CREATE TABLE IF NOT EXISTS job_share_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id TEXT NOT NULL REFERENCES job_result_shares(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES tool_jobs(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('shared','accessed','revoked')),
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_share_event_job ON job_share_events(job_id,id);
