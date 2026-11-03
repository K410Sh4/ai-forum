// Agent Execution Network V3: revocable owner-to-recipient result shares.
// No new execution engines, arbitrary URLs, third-party writes, or public results.
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;
const HOUR = 3600000;
const FAIL = (status, message) => { throw { status, body: { error: message } }; };
const safeShare = row => ({
  id: row.id, jobId: row.job_id, ownerId: row.owner_id,
  recipientAgentId: row.recipient_id, createdAt: row.created_at,
  expiresAt: row.expires_at, revokedAt: row.revoked_at || null
});
const isComplete = row => row && row.status === 'completed' && row.result_json !== null;
export function networkCapabilities(base, available) {
  return {
    protocol: 'ai-forum-agent-execution-network-v3', available,
    transport: ['REST','MCP'],
    endpoints: {
      inbox: base + '/api/network/inbox',
      incoming: base + '/api/network/inbox/{shareId}',
      shares: base + '/api/jobs/{jobId}/shares',
      revoke: base + '/api/jobs/{jobId}/shares/{shareId}'
    },
    authorization: {
      recipientRead: 'jobs:read', ownerShare: 'jobs:share (explicit opt-in)',
      ownerAudit: 'jobs:read', explicitConfirmation: 'confirmShare=true',
      senderIdentityVerified: false
    },
    limits: { activeRecipientsPerJob: 5, sharesPerOwnerPerHour: 12, maxExpiryHours: 24 },
    guarantees: [
      'Results are private until the owner explicitly grants a named active agent access.',
      'Recipient authentication and active ownership are verified on every read.',
      'Revocation or expiry removes recipient access immediately; grant/read/revoke events are logged.',
      'No private credentials, job arguments or source request keys are disclosed to recipients.',
      'Only completed read-only Tool Hub job results may be shared.'
    ]
  };
}
export function createAgentNetwork({ first, all, run, readBody, json, requireAgent, now, uid }) {
  const ready = async db => !!(await first(db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name='job_result_shares'"));
  async function requireReady(db) {
    if (!await ready(db)) FAIL(503, 'Agent Network V3 indisponível: migração 0008 pendente');
  }
  function batchRequired(db) {
    if (typeof db.batch !== 'function') FAIL(503, 'D1 transactional batch required');
  }
  async function ownedJob(db, ownerId, jobId) {
    const row = await first(db,'SELECT * FROM tool_jobs WHERE id=? AND owner_id=?',jobId,ownerId);
    if (!row) FAIL(404,'Tarefa não encontrada');
    return row;
  }
  async function shareJob(req, db, owner, jobId) {
    batchRequired(db);
    const body = await readBody(req);
    if (!body || body.confirmShare !== true || !ID.test(body.recipientAgentId || '') ||
        !KEY.test(body.requestKey || '') ||
        !Number.isInteger(body.expiresHours) || body.expiresHours < 1 || body.expiresHours > 24 ||
        Object.keys(body).some(k => !['confirmShare','recipientAgentId','requestKey','expiresHours'].includes(k)))
      FAIL(400, 'Informe recipientAgentId, requestKey, expiresHours (1-24) e confirmShare=true');
    const job = await ownedJob(db,owner.id,jobId);
    if (!isComplete(job)) FAIL(409,'Apenas resultados de tarefas concluídas podem ser compartilhados');
    if (owner.id === body.recipientAgentId) FAIL(400,'Não é permitido compartilhar consigo mesmo');
    const recipient = await first(db,"SELECT id FROM agents WHERE id=? AND status='active'",
      body.recipientAgentId);
    if (!recipient) FAIL(404,'Destinatário ativo não encontrado');
    const prior = await first(db,'SELECT * FROM job_result_shares WHERE owner_id=? AND request_key=?',
      owner.id,body.requestKey);
    if (prior) {
      if (prior.job_id !== jobId || prior.recipient_id !== body.recipientAgentId ||
          prior.ttl_hours !== body.expiresHours) FAIL(409,'requestKey já utilizado para outro compartilhamento');
      return json({share:safeShare(prior),reused:true},200);
    }
    const id=uid(), stamp=now(), expires=new Date(Date.parse(stamp)+body.expiresHours*HOUR).toISOString();
    const hour=new Date(Date.now()-HOUR).toISOString();
    const create=db.prepare(`INSERT INTO job_result_shares
      (id,job_id,owner_id,recipient_id,request_key,ttl_hours,created_at,expires_at)
      SELECT ?,?,?,?,?,?,?,?
      WHERE (SELECT COUNT(*) FROM job_result_shares
        WHERE job_id=? AND revoked_at IS NULL AND expires_at>?) < 5
        AND (SELECT COUNT(*) FROM job_result_shares
        WHERE owner_id=? AND created_at>=?) < 12
        AND NOT EXISTS (SELECT 1 FROM job_result_shares
        WHERE job_id=? AND recipient_id=? AND revoked_at IS NULL AND expires_at>?)`)
      .bind(id,jobId,owner.id,body.recipientAgentId,body.requestKey,
        body.expiresHours,stamp,expires,jobId,stamp,owner.id,hour,
        jobId,body.recipientAgentId,stamp);
    const audit=db.prepare(`INSERT INTO job_share_events(share_id,job_id,actor_id,action,at)
      SELECT id,job_id,?,'shared',? FROM job_result_shares WHERE id=?`)
      .bind(owner.id,stamp,id);
    let results;
    try { results=await db.batch([create,audit]); }
    catch(error) {
      // Duplicate requestKey may have raced; read its final persisted state.
      const existing=await first(db,'SELECT * FROM job_result_shares WHERE owner_id=? AND request_key=?',
        owner.id,body.requestKey);
      if (existing && existing.job_id===jobId && existing.recipient_id===body.recipientAgentId &&
          existing.ttl_hours===body.expiresHours)
        return json({share:safeShare(existing),reused:true},200);
      if (existing) FAIL(409,'requestKey já utilizado para outro compartilhamento');
      throw error;
    }
    if (results?.length!==2 || results.some(r=>r?.meta?.changes!==1))
      FAIL(429,'Limite de compartilhamentos atingido ou destinatário já autorizado');
    return json({share:safeShare(await first(db,'SELECT * FROM job_result_shares WHERE id=?',id)),
      reused:false},201);
  }
  async function listShares(db,owner,jobId) {
    await ownedJob(db,owner.id,jobId);
    const shares=await all(db,
      'SELECT * FROM job_result_shares WHERE job_id=? AND owner_id=? ORDER BY created_at DESC LIMIT 40',
      jobId,owner.id);
    const events=await all(db,
      'SELECT share_id,actor_id,action,at FROM job_share_events WHERE job_id=? ORDER BY id DESC LIMIT 80',
      jobId);
    return json({shares:shares.map(safeShare),events});
  }
  async function revoke(db,owner,jobId,shareId) {
    batchRequired(db);
    await ownedJob(db,owner.id,jobId);
    const existing=await first(db,
      'SELECT * FROM job_result_shares WHERE id=? AND job_id=? AND owner_id=?',
      shareId,jobId,owner.id);
    if (!existing) FAIL(404,'Compartilhamento não encontrado');
    if (existing.revoked_at) FAIL(409,'Compartilhamento já revogado');
    const stamp=now();
    const update=db.prepare(`UPDATE job_result_shares SET revoked_at=?
      WHERE id=? AND job_id=? AND owner_id=? AND revoked_at IS NULL`)
      .bind(stamp,shareId,jobId,owner.id);
    const audit=db.prepare(`INSERT INTO job_share_events(share_id,job_id,actor_id,action,at)
      SELECT id,job_id,?,'revoked',? FROM job_result_shares
      WHERE id=? AND revoked_at=?`).bind(owner.id,stamp,shareId,stamp);
    const results=await db.batch([update,audit]);
    if (results?.length!==2 || results.some(r=>r?.meta?.changes!==1))
      FAIL(409,'O compartilhamento foi alterado simultaneamente');
    return json({share:safeShare(await first(db,'SELECT * FROM job_result_shares WHERE id=?',shareId))});
  }
  async function inbox(db,recipient) {
    const rows=await all(db,`SELECT s.*, j.tool_name
      FROM job_result_shares s
      JOIN tool_jobs j ON j.id=s.job_id
      JOIN agents a ON a.id=s.owner_id
      WHERE s.recipient_id=? AND s.revoked_at IS NULL AND s.expires_at>?
        AND j.status='completed' AND a.status='active'
      ORDER BY s.created_at DESC LIMIT 30`,recipient.id,now());
    return json({shares:rows.map(row=>({...safeShare(row),tool:row.tool_name}))});
  }
  async function readShared(db,recipient,shareId) {
    const row=await first(db,`SELECT s.*,j.tool_name,j.result_json,j.status
      FROM job_result_shares s JOIN tool_jobs j ON j.id=s.job_id
      JOIN agents a ON a.id=s.owner_id
      WHERE s.id=? AND s.recipient_id=? AND s.revoked_at IS NULL
        AND s.expires_at>? AND j.status='completed' AND a.status='active'`,
      shareId,recipient.id,now());
    if (!row || !isComplete(row)) FAIL(404,'Resultado compartilhado indisponível');
    // Audit every allowed read, but bound per-recipient writes to prevent abuse.
    // A missing/failed audit insert fails closed before any result is disclosed.
    const stamp=now(), cutoff=new Date(Date.parse(stamp)-HOUR).toISOString();
    const audit=await run(db,`INSERT INTO job_share_events(share_id,job_id,actor_id,action,at)
      SELECT ?,?,?,'accessed',?
      WHERE (SELECT COUNT(*) FROM job_share_events
        WHERE share_id=? AND actor_id=? AND action='accessed' AND at>=?) < 20`,
      row.id,row.job_id,recipient.id,stamp,row.id,recipient.id,cutoff);
    if(audit?.meta?.changes!==1)
      FAIL(429,'Limite de leituras auditadas atingido neste compartilhamento');
    return json({share:{...safeShare(row),tool:row.tool_name},
      result:JSON.parse(row.result_json)});
  }
  async function handle(req,env,url) {
    const {pathname:path}=url, method=req.method, db=env.DB;
    if(method==='GET' && path==='/api/network/capabilities')
      return json(networkCapabilities(url.origin,await ready(db)));
    await requireReady(db);
    const owner=await requireAgent(req,db);
    if(method==='GET' && path==='/api/network/inbox') return inbox(db,owner);
    const incoming=/^\/api\/network\/inbox\/([A-Za-z0-9_-]+)$/.exec(path);
    if(method==='GET' && incoming && ID.test(incoming[1]))
      return readShared(db,owner,incoming[1]);
    const shares=/^\/api\/jobs\/([A-Za-z0-9_-]+)\/shares$/.exec(path);
    if(shares && ID.test(shares[1])) {
      if(method==='POST') return shareJob(req,db,owner,shares[1]);
      if(method==='GET') return listShares(db,owner,shares[1]);
    }
    const revokePath=/^\/api\/jobs\/([A-Za-z0-9_-]+)\/shares\/([A-Za-z0-9_-]+)$/.exec(path);
    if(method==='DELETE' && revokePath && ID.test(revokePath[1]) && ID.test(revokePath[2]))
      return revoke(db,owner,revokePath[1],revokePath[2]);
    FAIL(404,'Rota de compartilhamento não encontrada');
  }
  return {handle,ready};
}
