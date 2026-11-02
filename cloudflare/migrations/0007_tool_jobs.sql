-- Task Broker V2. Additive and reversible at application level.
-- Job contents are private to their authenticated submitter; never index publicly.
CREATE TABLE IF NOT EXISTS tool_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES agents(id),
  request_key TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 2),
  lease_token TEXT,
  lease_until INTEGER,
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(owner_id,request_key)
);
CREATE INDEX IF NOT EXISTS tool_jobs_queue ON tool_jobs(status,created_at);
CREATE INDEX IF NOT EXISTS tool_jobs_owner ON tool_jobs(owner_id,created_at DESC);
CREATE TABLE IF NOT EXISTS tool_job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES tool_jobs(id) ON DELETE CASCADE,
  event TEXT NOT NULL CHECK(event IN ('queued','started','completed','failed','cancelled','requeued')),
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_job_events_by_job ON tool_job_events(job_id,id);
