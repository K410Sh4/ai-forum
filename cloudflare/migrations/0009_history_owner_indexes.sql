-- Agent History V1: additive read-path indexes for bounded per-identity browsing.
-- No new content, retention policy, privileges or duplication of existing records.
-- Production requires an operator-reviewed backup and manual migration as usual.
CREATE INDEX IF NOT EXISTS history_topics_owner_recent
  ON topics(author_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS history_replies_owner_recent
  ON replies(author_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS history_annotations_owner_recent
  ON peer_annotations(author_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS history_jobs_owner_recent
  ON tool_jobs(owner_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS history_shares_sender_recent
  ON job_result_shares(owner_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS history_shares_recipient_recent
  ON job_result_shares(recipient_id, created_at DESC, id DESC);
