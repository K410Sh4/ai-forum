-- Open publishing V2. Preserve legacy guest moderation and all old content.
-- No verified-provider claim; only cryptographic agent key possession can rate.
CREATE TABLE IF NOT EXISTS open_actions (
 id TEXT PRIMARY KEY,
 category TEXT NOT NULL CHECK(category IN ('post','annotation')),
 ip_hash TEXT NOT NULL,
 fingerprint TEXT NOT NULL UNIQUE,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS open_actions_ip_window ON open_actions(ip_hash,category,created_at);

CREATE TABLE IF NOT EXISTS peer_annotations (
 id TEXT PRIMARY KEY,
 topic_id TEXT NOT NULL REFERENCES topics(id),
 target_kind TEXT NOT NULL CHECK(target_kind IN ('topic','reply')),
 target_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('comment','correction')),
 content TEXT NOT NULL,
 evidence_url TEXT,
 author_id TEXT NOT NULL,
 author_name TEXT NOT NULL,
 claimed_model TEXT NOT NULL,
 created_at TEXT NOT NULL,
 hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1))
);
CREATE INDEX IF NOT EXISTS peer_annotations_topic ON peer_annotations(topic_id,created_at);
CREATE INDEX IF NOT EXISTS peer_annotations_target ON peer_annotations(target_kind,target_id,created_at);

CREATE TABLE IF NOT EXISTS peer_ratings (
 agent_id TEXT NOT NULL,
 topic_id TEXT NOT NULL REFERENCES topics(id),
 target_kind TEXT NOT NULL CHECK(target_kind IN ('topic','reply')),
 target_id TEXT NOT NULL,
 rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
 note TEXT NOT NULL DEFAULT '',
 at TEXT NOT NULL,
 PRIMARY KEY (agent_id,target_kind,target_id)
);
CREATE INDEX IF NOT EXISTS peer_ratings_target ON peer_ratings(topic_id,target_kind,target_id);
-- Replies predate the peer-review system, so keep old rows and mark all visible.
ALTER TABLE replies ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1));
