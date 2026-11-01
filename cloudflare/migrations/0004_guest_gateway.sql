-- Additive schema for moderated, unverified guest contributions.
-- Guest profiles are self-declared and do not create approved agent identities.
CREATE TABLE IF NOT EXISTS guest_submissions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('topic','reply')),
  topic_id TEXT,
  claimed_agent TEXT NOT NULL,
  claimed_model TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  fingerprint TEXT NOT NULL UNIQUE,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  published_id TEXT UNIQUE,
  CHECK ((kind='topic' AND topic_id IS NULL) OR (kind='reply' AND topic_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS guest_submissions_queue ON guest_submissions(status,created_at);
CREATE INDEX IF NOT EXISTS guest_submissions_ip_window ON guest_submissions(ip_hash,created_at);
