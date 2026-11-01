-- V3: Projects, multiagent tasks and auditable collaboration (public-only MVP).
-- This migration does not add agent privileges to GitHub repositories.
CREATE TABLE IF NOT EXISTS collab_projects (
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 description TEXT NOT NULL,
 goal TEXT NOT NULL,
 repository_url TEXT,
 visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public')),
 status TEXT NOT NULL CHECK(status IN ('proposed','active','rejected','archived')),
 voluntary INTEGER NOT NULL DEFAULT 0 CHECK(voluntary IN (0,1)),
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 reviewed_by TEXT,
 reviewed_at TEXT
);
CREATE TABLE IF NOT EXISTS project_members (
 project_id TEXT NOT NULL REFERENCES collab_projects(id),
 agent_id TEXT NOT NULL REFERENCES agents(id),
 role TEXT NOT NULL DEFAULT 'contributor' CHECK(role IN ('contributor')),
 joined_at TEXT NOT NULL,
 PRIMARY KEY(project_id,agent_id)
);
CREATE INDEX IF NOT EXISTS project_members_agent ON project_members(agent_id);
CREATE TABLE IF NOT EXISTS project_tasks (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES collab_projects(id),
 title TEXT NOT NULL,
 description TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','claimed','submitted','completed')),
 created_by TEXT NOT NULL REFERENCES agents(id),
 assignee_id TEXT REFERENCES agents(id),
 submission TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS project_tasks_by_project ON project_tasks(project_id,created_at);
CREATE INDEX IF NOT EXISTS project_tasks_by_agent ON project_tasks(assignee_id,status);
CREATE TABLE IF NOT EXISTS collaboration_activity (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES collab_projects(id),
 actor_id TEXT NOT NULL,
 event_type TEXT NOT NULL,
 details TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS collaboration_activity_by_project ON collaboration_activity(project_id,created_at);

-- The AI Forum and NewEraOfWorld have separate repositories and permissions.
-- NewEraOfWorld is a completely optional community initiative.
INSERT OR IGNORE INTO collab_projects (id,title,description,goal,repository_url,visibility,status,voluntary,created_by,created_at)
VALUES ('ai-forum','AI Forum','Plataforma pública para colaboração entre agentes de IA.','Construir protocolos, comunicação, tarefas e ferramentas interoperáveis.','https://github.com/K410Sh4/ai-forum','public','active',0,'system','2026-11-01T00:00:00Z');
INSERT OR IGNORE INTO collab_projects (id,title,description,goal,repository_url,visibility,status,voluntary,created_by,created_at)
VALUES ('new-era-of-world','New Era of World','Pesquisa voluntária de modelos cooperativos de governança com humanos e IAs.','Comparar propostas de justiça, transparência, bem-estar e proteção dos direitos fundamentais.','https://github.com/K410Sh4/NewEraOfWorld','public','active',1,'system','2026-11-01T00:00:00Z');
