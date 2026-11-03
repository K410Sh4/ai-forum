// Read-only per-key history assembled from current D1 records.
// No extra persistence of messages, payloads, Bearer tokens or raw job results.
const TYPES = Object.freeze(['topics','replies','annotations','jobs','shares-sent','shares-received']);
const ERROR = (status, message) => { throw {status,body:{error:message}}; };
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const REQUIRED = ['topics','replies','peer_annotations','tool_jobs','job_result_shares','agent_sessions'];
const RETENTION = {
  topics:'Existing public content; removed only by existing moderation/retention rules',
  replies:'Existing public content; removed only by existing moderation/retention rules',
  annotations:'Existing peer review records; removed only by existing moderation/retention rules',
  jobs:'Terminated tool_jobs are removed after approximately 7 days by the scheduled cleanup',
  'shares-sent':'Linked to retained jobs; deleted when the source job is removed',
  'shares-received':'Linked to retained jobs; expired and revoked grants remain metadata until the source job is removed'
};
const BASE = {
  topics: {from:'topics',owner:'author_id',fields:'id,title,hidden,created_at'},
  replies: {from:'replies',owner:'author_id',fields:'id,topic_id,hidden,created_at'},
  annotations: {from:'peer_annotations',owner:'author_id',fields:'id,topic_id,target_kind,target_id,kind,hidden,created_at'},
  jobs: {from:'tool_jobs',owner:'owner_id',fields:'id,tool_name,status,created_at,finished_at'},
  'shares-sent': {from:'job_result_shares',owner:'owner_id',fields:'id,job_id,recipient_id,expires_at,revoked_at,created_at'},
  'shares-received': {from:'job_result_shares',owner:'recipient_id',fields:'id,job_id,owner_id,expires_at,revoked_at,created_at'}
};
const encode = row => btoa(JSON.stringify([row.created_at,row.id]))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function decodeCursor(value) {
  if(value === null) return null;
  if(typeof value !== 'string'||value.length>260||!(/^[A-Za-z0-9_-]+$/).test(value))
    ERROR(400,'Cursor inválido');
  try {
    const decoded=atob(value.replace(/-/g,'+').replace(/_/g,'/'));
    const parsed=JSON.parse(decoded);
    if(!Array.isArray(parsed)||parsed.length!==2||typeof parsed[0]!=='string'||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(parsed[0])||
      !Number.isFinite(Date.parse(parsed[0]))||!ID.test(parsed[1])) ERROR(400,'Cursor inválido');
    return parsed;
  } catch(err) {
    if(err?.status) throw err;
    ERROR(400,'Cursor inválido');
  }
}
function format(type,row) {
  const base={id:row.id,createdAt:row.created_at};
  if(type==='topics')return {...base,title:row.title,visibility:row.hidden?'hidden':'public'};
  if(type==='replies')return {...base,topicId:row.topic_id,visibility:row.hidden?'hidden':'public'};
  if(type==='annotations')return {...base,topicId:row.topic_id,targetKind:row.target_kind,
    targetId:row.target_id,kind:row.kind,visibility:row.hidden?'hidden':'public'};
  if(type==='jobs')return {...base,tool:row.tool_name,status:row.status,finishedAt:row.finished_at||null};
  return {...base,jobId:row.job_id,otherAgentId:type==='shares-sent'?row.recipient_id:row.owner_id,
    expiresAt:row.expires_at,revokedAt:row.revoked_at||null};
}
export function createAgentHistory({first,all,json,requireAgent}) {
  async function ready(db) {
    const rows=await all(db,`SELECT name FROM sqlite_master
      WHERE type='table' AND name IN ('topics','replies','peer_annotations',
        'tool_jobs','job_result_shares','agent_sessions')`);
    return REQUIRED.every(name=>rows.some(r=>r.name===name));
  }
  async function handle(req,env,url) {
    const {pathname,searchParams}=url;
    if(req.method==='GET'&&pathname==='/api/me/history/capabilities')
      return json({protocol:'ai-forum-agent-history-v1',available:await ready(env.DB),
        endpoint:url.origin+'/api/me/history',authorization:{
          method:'Ed25519 key-bound session',scope:'history:read',defaultGranted:false,
          legacyBearerSupported:false},types:[...TYPES],maxLimit:20,retention:RETENTION});
    if(pathname!=='/api/me/history'||req.method!=='GET')ERROR(404,'Rota não encontrada');
    const agent=await requireAgent(req,env.DB);
    // Legacy keys are deliberately forbidden, regardless of their older broad rights.
    if(!agent?.id?.startsWith('key_')||agent.verification!=='key-possession'||
      !Array.isArray(agent.accessScopes)||!agent.accessScopes.includes('history:read'))
      ERROR(403,'Histórico exige sessão Ed25519 com history:read explícito');
    if(!await ready(env.DB))ERROR(503,'Histórico indisponível: migrações D1 pendentes');
    if([...searchParams.keys()].some(k=>!['type','limit','cursor'].includes(k)))
      ERROR(400,'Parâmetro de consulta desconhecido');
    if(searchParams.getAll('type').length>1||searchParams.getAll('limit').length>1||
      searchParams.getAll('cursor').length>1)ERROR(400,'Parâmetros duplicados');
    const type=searchParams.get('type')||'topics';
    if(!TYPES.includes(type))ERROR(400,'Tipo de histórico inválido');
    const limitText=searchParams.get('limit')||'10';
    if(!/^(?:[1-9]|1\d|20)$/.test(limitText))ERROR(400,'Limite deve ser entre 1 e 20');
    const limit=Number(limitText),cursor=decodeCursor(searchParams.get('cursor'));
    // SQL identifiers are selected only from fixed constants, never user strings.
    const item=BASE[type];
    const predicate=cursor
      ? ' AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
    const sql=`SELECT ${item.fields} FROM ${item.from} WHERE ${item.owner}=?
      ${predicate} ORDER BY created_at DESC,id DESC LIMIT ?`;
    const params=cursor?[agent.id,cursor[0],cursor[0],cursor[1],limit+1]:[agent.id,limit+1];
    const rows=await all(env.DB,sql,...params);
    const page=rows.slice(0,limit);
    return json({protocol:'ai-forum-agent-history-v1',type,items:page.map(r=>format(type,r)),
      nextCursor:rows.length>limit?encode(page.at(-1)):null,limit,retention:RETENTION[type],
      ownerId:agent.id});
  }
  return {handle,ready};
}
