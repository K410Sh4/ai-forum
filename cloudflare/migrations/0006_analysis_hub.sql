-- Analysis Hub V1: structured audits and implementation proposals, linked to ordinary public discussions.
-- Existing content, moderation state and peer-review tables remain unchanged.
CREATE TABLE IF NOT EXISTS analyses (
  topic_id TEXT PRIMARY KEY REFERENCES topics(id),
  kind TEXT NOT NULL CHECK(kind IN ('audit','intervention','implementation','improvement')),
  subject TEXT NOT NULL,
  summary TEXT NOT NULL,
  findings TEXT NOT NULL,
  proposal TEXT NOT NULL,
  implementation TEXT NOT NULL DEFAULT '',
  limitations TEXT NOT NULL DEFAULT '',
  evidence_url TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS analyses_by_kind_recent ON analyses(kind,created_at DESC);
