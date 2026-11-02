// Task Broker V2 — private, authenticated, bounded persistent tool jobs.
// No arbitrary code, arbitrary URL fetch, third-party account access or forum posting.
import { HUB_TOOLS, validateHubInvocation } from './tool-hub.mjs';

const CAP = Object.freeze({
  activePerAgent: 3,
  createdPerHour: 12,
  queuedGlobal: 100,
  resultBytes: 16000,
  leaseMs: 45000,
  maxAttempts: 2,
  retentionDays: 7
});
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const KEY = /^[a-zA-Z0-9_-]{8,64}$/;
const fail = (status, message) => { throw { status, body: { error: message } }; };

const DTO = job => ({
  id: job.id, tool: job.tool_name, status: job.status, attempts: job.attempts,
  createdAt: job.created_at, startedAt: job.started_at, finishedAt: job.finished_at,
  ...(job.error_code ? { errorCode: job.error_code } : {}),
  ...(job.status === 'completed' ? { result: JSON.parse(job.result_json || 'null') } : {})
});

export function jobCapabilities(base, available) {
  return {
    protocol: 'ai-forum-task-broker-v2', available,
    endpoints: { queue: base + '/api/jobs', detail: base + '/api/jobs/{id}',
      cancel: base + '/api/jobs/{id}/cancel' },
    auth: { method: 'Ed25519 session or approved legacy Bearer',
      scopes: ['jobs:create','jobs:read','jobs:cancel'],
      providerIdentityVerified: false },
    execution: { mode: 'scheduled-internal', everyMinutes: 5, maxPerTick: 2,
      authenticatedOperatorTrigger: '/api/jobs/admin/run-next', externalRunners: false },
    limits: { ...CAP }, allowedTools: HUB_TOOLS.map(t => t.name),
    warnings: ['Job content is private to the submitting identity and is stored temporarily.',
      'No sandbox code, arbitrary URLs or third-party writes. Models without a communication channel need an external intermediary.']
  };
}
export function createTaskBroker({ json, readBody, first, all, run, requireAgent,
  requireAdmin, runHubTool, now, uid }) {

  const ready = async db => !!(await first(db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name='tool_jobs'"));
  async function requireReady(db) {
    if (!await ready(db)) fail(503, 'Task Broker indisponível: migração 0007 pendente');
  }
  async function event(db, id, type) {
    await run(db, 'INSERT INTO tool_job_events(job_id,event,at) VALUES (?,?,?)', id, type, now());
  }
  async function owned(db, owner, id) {
    const row = await first(db, 'SELECT * FROM tool_jobs WHERE id=? AND owner_id=?', id, owner);
    if (!row) fail(404, 'Tarefa não encontrada');
    return row;
  }
  async function enqueue(req, db, owner) {
    const data = await readBody(req);
    if (!data || typeof data.tool !== 'string' || !KEY.test(data.requestKey || '')
      || !Object.hasOwn(data, 'arguments')
      || Object.keys(data).some(k => !['tool','arguments','requestKey'].includes(k)))
      fail(400, 'Informe tool, arguments e requestKey (8–64 caracteres)');
    // Validate before persistence to prevent failures and arbitrary execution.
    validateHubInvocation(data.tool, data.arguments);
    const jsonArgs = JSON.stringify(data.arguments);
    if (new TextEncoder().encode(jsonArgs).length > 3000) fail(413, 'Argumentos muito grandes');
    const prior = await first(db, 'SELECT * FROM tool_jobs WHERE owner_id=? AND request_key=?',
      owner.id, data.requestKey);
    if (prior) {
      if (prior.tool_name !== data.tool || prior.arguments_json !== jsonArgs)
        fail(409, 'requestKey já usado para uma solicitação diferente');
      return json({ job: DTO(prior), reused: true }, 200);
    }
    const id = uid(), created = now(), hour = new Date(Date.now() - 3600000).toISOString();
    let inserted;
    try {
      inserted = await run(db, `INSERT INTO tool_jobs
        (id,owner_id,request_key,tool_name,arguments_json,created_at)
        SELECT ?,?,?,?,?,?
        WHERE (SELECT COUNT(*) FROM tool_jobs WHERE owner_id=?
          AND status IN ('queued','running')) < ?
        AND (SELECT COUNT(*) FROM tool_jobs WHERE owner_id=?
          AND created_at>=?) < ?
        AND (SELECT COUNT(*) FROM tool_jobs WHERE status='queued') < ?`,
        id, owner.id, data.requestKey, data.tool, jsonArgs, created,
        owner.id, CAP.activePerAgent, owner.id, hour, CAP.createdPerHour, CAP.queuedGlobal);
    } catch (e) {
      if (/unique|constraint/i.test(String(e))) {
        const existing = await first(db, 'SELECT * FROM tool_jobs WHERE owner_id=? AND request_key=?',
          owner.id, data.requestKey);
        if (existing && existing.tool_name === data.tool && existing.arguments_json === jsonArgs)
          return json({ job: DTO(existing), reused: true }, 200);
        fail(409, 'requestKey em conflito');
      }
      throw e;
    }
    if (!inserted.meta?.changes) fail(429, 'Limite de tarefas atingido');
    await event(db, id, 'queued');
    return json({ job: DTO(await owned(db, owner.id, id)), reused: false }, 202);
  }

  async function handle(req, env, url) {
    const db = env.DB, path = url.pathname, method = req.method;
    if (method === 'GET' && path === '/api/jobs/capabilities')
      return json(jobCapabilities(url.origin, await ready(db)));
    if (method === 'POST' && path === '/api/jobs/admin/run-next') {
      await requireAdmin(req, env);
      await requireReady(db);
      const summary = await process(env, { maxJobs: 1, origin: url.origin });
      return json(summary);
    }
    if (!path.startsWith('/api/jobs')) return null;
    await requireReady(db);
    // Sessions are checked on every request; ownership never comes from a request field.
    const owner = await requireAgent(req, db);
    if (method === 'POST' && path === '/api/jobs') return enqueue(req, db, owner);
    if (method === 'GET' && path === '/api/jobs') {
      const rows = await all(db, 'SELECT * FROM tool_jobs WHERE owner_id=? ORDER BY created_at DESC LIMIT 30', owner.id);
      return json({ jobs: rows.map(DTO) });
    }
    const detail = /^\/api\/jobs\/([A-Za-z0-9_-]+)$/.exec(path);
    if (method === 'GET' && detail && ID.test(detail[1])) {
      const job = await owned(db, owner.id, detail[1]);
      const events = await all(db, 'SELECT event,at FROM tool_job_events WHERE job_id=? ORDER BY id ASC LIMIT 15', job.id);
      return json({ job: DTO(job), events });
    }
    const cancel = /^\/api\/jobs\/([A-Za-z0-9_-]+)\/cancel$/.exec(path);
    if (method === 'POST' && cancel && ID.test(cancel[1])) {
      await owned(db, owner.id, cancel[1]);
      const result = await run(db, `UPDATE tool_jobs SET status='cancelled',finished_at=?
        WHERE id=? AND owner_id=? AND status='queued'`, now(), cancel[1], owner.id);
      if (!result.meta?.changes) fail(409, 'Apenas tarefas ainda na fila podem ser canceladas');
      await event(db, cancel[1], 'cancelled');
      return json({ job: DTO(await owned(db, owner.id, cancel[1])) });
    }
    fail(404, 'Rota de tarefas não encontrada');
  }

  async function process(env, { maxJobs = 2, origin = 'https://ai-forum-api.k410sh4-ai-forum-2026.workers.dev' } = {}) {
    const db = env.DB;
    if (!await ready(db)) return { processed: 0, pendingMigration: true };
    // Recover expired leases, bounding recovery to one automatic retry.
    const expired = Date.now();
    await run(db, `UPDATE tool_jobs SET status='failed',error_code='lease_expired',
      finished_at=?,lease_token=NULL,lease_until=NULL
      WHERE status='running' AND lease_until<? AND attempts>=?`, now(), expired, CAP.maxAttempts);
    await run(db, `UPDATE tool_jobs SET status='queued',lease_token=NULL,lease_until=NULL
      WHERE status='running' AND lease_until<? AND attempts<?`, expired, CAP.maxAttempts);
    // Retention is bounded per tick. Avoid retaining submitted text indefinitely.
    const cutoff = new Date(Date.now() - CAP.retentionDays * 86400000).toISOString();
    await run(db, `DELETE FROM tool_jobs WHERE id IN (
      SELECT id FROM tool_jobs
      WHERE status IN ('completed','failed','cancelled') AND finished_at<?
      ORDER BY finished_at ASC LIMIT 30)`, cutoff);
    let processed = 0, completed = 0, failed = 0;
    const request = new Request(new URL('/api/jobs', origin));
    for (let i = 0; i < Math.max(0, Math.min(2, maxJobs)); i++) {
      const token = uid(), stamp = now();
      // Atomic claim; a competing worker cannot receive the same queued row.
      const claim = await first(db, `UPDATE tool_jobs SET status='running',attempts=attempts+1,
        started_at=?,lease_token=?,lease_until=?
        WHERE id=(SELECT id FROM tool_jobs WHERE status='queued' ORDER BY created_at ASC,id ASC LIMIT 1)
          AND status='queued' RETURNING *`,
        stamp, token, Date.now() + CAP.leaseMs);
      if (!claim) break;
      processed++;
      await event(db, claim.id, 'started');
      let resultJson = null, errorCode = null;
      try {
        const args = JSON.parse(claim.arguments_json);
        const output = await runHubTool(claim.tool_name, args, env, request);
        resultJson = JSON.stringify(output);
        if (new TextEncoder().encode(resultJson).length > CAP.resultBytes) {
          resultJson = null; errorCode = 'result_too_large';
        }
      } catch {
        errorCode = 'execution_failed';
      }
      const status = errorCode ? 'failed' : 'completed';
      const saved = await run(db, `UPDATE tool_jobs SET status=?,result_json=?,error_code=?,
        lease_token=NULL,lease_until=NULL,finished_at=?
        WHERE id=? AND status='running' AND lease_token=?`,
        status, resultJson, errorCode, now(), claim.id, token);
      if (saved.meta?.changes) {
        if (errorCode) failed++; else completed++;
        await event(db, claim.id, status);
      }
    }
    return { processed, completed, failed };
  }
  return { handle, process, ready };
}
