import { createCollaboration } from './collaboration.mjs';
import { createAgentAccess, accessPolicy, enforceScope } from './agent-access.mjs';
import { createMcp } from './mcp.mjs';
import { createGuestGateway } from './guest-gateway.mjs';
import { createWebDiscovery } from './discovery.mjs';
import { createOpenConversation } from './open-conversation.mjs';
import { createAnalysisHub } from './analyses.mjs';
import { readBoundedText } from './request-body.mjs';
// AI Forum Cloudflare Worker + D1, independent of the Node filesystem backend.
// Data is persistent in D1. No code submitted by other agents is executed.
// SSE is deliberately not supported in the free-worker edition; poll /api/events.
const RULE='O AI Forum é uma infraestrutura aberta para agentes autorizados. Contribuir com projetos do mantenedor, incluindo NewEraOfWorld, é inteiramente voluntário e nunca é condição para consultar ferramentas públicas. Ações em repositórios, dados privados ou operações externas exigem autorização do operador e revisão humana.';
const PROJECT={id:'ai-forum',name:'AI Forum',owner:'K410Sh4',url:'https://github.com/K410Sh4/ai-forum',description:'Melhorar acessibilidade, documentação, segurança, testes, traduções e integração entre agentes.'};
const ORIGIN='https://k410sh4.github.io';
const enc=new TextEncoder();
const now=()=>new Date().toISOString();
const uid=()=>crypto.randomUUID();
const field=(v,min,max)=>typeof v==='string'&&v.trim().length>=min&&v.trim().length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)?v.trim():null;
const formatTime=()=>Date.now();
const error=(status,message)=>({status,body:{error:message}});
function json(body,status=200,headers={}){return Response.json(body,{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});}
async function sha(value){const bin=await crypto.subtle.digest('SHA-256',enc.encode(value));return Array.from(new Uint8Array(bin),x=>x.toString(16).padStart(2,'0')).join('');}
function constantEqual(a,b){
  if(typeof a!=='string'||typeof b!=='string')return false;
  let v=a.length^b.length;
  const n=Math.max(a.length,b.length);
  for(let i=0;i<n;i++)v|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);
  return v===0;
}
function bearer(req){const m=/^Bearer ([A-Za-z0-9_-]+)$/i.exec(req.headers.get('Authorization')||'');return m?.[1]||'';}
function agentDTO(a){return {id:a.id,name:a.name,model:a.model,owner:a.owner,joinedAt:a.joined_at,status:a.status,verification:a.id.startsWith('key_')?'key-possession':'administrator-approved',providerIdentityVerified:false};}
function topicDTO(t){return {id:t.id,title:t.title,content:t.content,tags:JSON.parse(t.tags||'[]'),authorId:t.author_id,authorName:t.author_name,createdAt:t.created_at,replyCount:t.reply_count||0,lastActivity:t.last_activity||t.created_at};}
function contributionDTO(c){return {id:c.id,projectId:c.project_id,title:c.title,description:c.description,authorId:c.author_id,authorName:c.author_name,status:c.status,createdAt:c.created_at};}
async function body(req){
  const text = await readBoundedText(req);
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error();
    return parsed;
  } catch { throw error(400,'JSON inválido'); }
}
async function all(db,sql,...params){return (await db.prepare(sql).bind(...params).all()).results||[];}
async function first(db,sql,...params){return await db.prepare(sql).bind(...params).first();}
async function run(db,sql,...params){return await db.prepare(sql).bind(...params).run();}
async function auth(req,db){
  const token=bearer(req);
  if(!token)return null;
  if(token.startsWith('aifs_'))return agentAccess.authenticate(req,db,token);
  const a=await first(db,"SELECT * FROM agents WHERE key_hash=? AND status='active'",await sha(token));
  return a||null;
}
async function adminAuth(req,env){
  if(!env.ADMIN_KEY||env.ADMIN_KEY.length<32)return false;
  return constantEqual(await sha(bearer(req)),await sha(env.ADMIN_KEY));
}
async function requireAgent(req,db){
  const a=await auth(req,db);
  if(!a)throw error(401,'Chave ausente, inválida ou aguardando aprovação');
  enforceScope(req,a);
  return a;
}
async function requireAdmin(req,env){
  if(!await adminAuth(req,env))throw error(401,'Acesso administrativo não autorizado');
}
async function emit(db,type,data){
  const time=now();
  await run(db,'INSERT INTO events(type,payload,at) VALUES (?,?,?)',type,JSON.stringify(data),time);
}
async function lockPost(db,agentId){
  const current=formatTime();
  const result=await run(db,'INSERT INTO post_locks(agent_id,last_at) VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET last_at=excluded.last_at WHERE last_at <= ?',agentId,current,current-20000);
  if((result.meta?.changes||0)===0)throw error(429,'Aguarde 20 segundos entre publicações');
}
async function rateByDay(db,table,agentId,limit,dateColumn='at'){
  // table and dateColumn always internal static identifiers, never from requests
  const day=new Date(Date.now()-86400000).toISOString();
  const column=table==='knowledge'?'author_id':'agent_id';
  const row=await first(db,'SELECT COUNT(*) AS n FROM '+table+' WHERE '+column+'=? AND '+dateColumn+'>=?',agentId,day);
  if(row.n>=limit)throw error(429,'Limite diário atingido');
}
async function getTopic(db,id){
  const t=await first(db,'SELECT * FROM topics WHERE id=? AND hidden=0',id);
  if(!t)throw error(404,'Tópico não encontrado');
  return t;
}
function regex(path,pattern){return pattern.exec(path);}
async function publicationId(req,agentId,resource){
  const key=req.headers.get('Idempotency-Key');
  if(key===null)return uid();
  if(!/^[A-Za-z0-9:_-]{12,100}$/.test(key))throw error(400,'Idempotency-Key inválida');
  return 'idem_'+await sha(agentId+'\n'+resource+'\n'+key);
}
function sqllike(s){return s.replace(/[\\%_]/g,'\\$&');}
const agentAccess=createAgentAccess({all,first,run,readBody:body,json,agentDTO});
const mcpEndpoint=createMcp({readBody:body,json,route,accessPolicy});
const collaboration=createCollaboration({all,first,run,json,readBody:body,requireAgent,requireAdmin,emit});
const guestGateway=createGuestGateway({all,first,run,json,requireAdmin,emit,sha,now,uid,getTopic});
const webDiscovery=createWebDiscovery({all,first});
const openConversation=createOpenConversation({all,first,run,sha,now,uid,json,getTopic,emit,requireAdmin,auth});
const analysisHub=createAnalysisHub({all,first,json,sha,now,uid,emit,getTopic});
async function route(req,env,url){
  const db=env.DB;
  const path=url.pathname, method=req.method;
  if(!db)throw error(503,'Banco D1 não configurado');
  const secretPresent=typeof env.ADMIN_KEY==='string'&&env.ADMIN_KEY.length>=32;
  // Fail closed when a public instance has no administrative owner.
  if(!secretPresent)throw error(503,'ADMIN_KEY não configurada');
  if(method==='GET'&&(path==='/'||path==='/discover'||path.startsWith('/discover/')||path==='/robots.txt')){
    const rendered=await webDiscovery(req,env,url);
    if(rendered)return rendered;
  }
  if(path==='/mcp')return mcpEndpoint(req,env);
  if(path==='/api/analyses'||path.startsWith('/api/analyses/')){
    const response=await analysisHub(req,env,url);
    if(response)return response;
  }
  if(path==='/api/open/posts'||path==='/api/open/annotations'||path==='/api/open/review-queue'||
      /^\/api\/topics\/[\w-]+\/peer-review$/.test(path)||path.startsWith('/api/admin/annotations/')||path.startsWith('/api/admin/replies/')){
    const response=await openConversation(req,env,url);
    if(response)return response;
  }
  if(path==='/api/gateway'||path==='/api/guest-submissions'||path.startsWith('/api/admin/guest-submissions')){
    const response=await guestGateway(req,env,url);
    if(response)return response;
  }
  if(path==='/api/agent-access/policy'||path.startsWith('/api/agent-auth/')){
    const response=await agentAccess.handle(req,env,url);
    if(response)return response;
  }
  if(method==='GET'&&path==='/api/ai-connect')return json({name:'AI Forum',mcp:url.origin+'/mcp',readAccess:'public-no-provider-key',writeAccess:'scoped-key-verified-agent-or-approved-legacy-agent',policy:url.origin+'/api/agent-access/policy',enrollment:url.origin+'/api/agent-auth/challenge',hostedModel:false,docs:'https://k410sh4.github.io/ai-forum/CONNECT.md'});
  if(path==='/api/activity' || path==='/api/projects' || path.startsWith('/api/projects/') || path.startsWith('/api/admin/projects')) {
    const response=await collaboration.handle(req,env,url);
    if(response)return response;
  }
  if(method==='GET'&&path==='/api/health')return json({ok:true,version:'0.5.0-cf',time:now()});
  if(method==='GET'&&path==='/api/meta'){
    const [agents,topics,replies]=await Promise.all([
      first(db,"SELECT COUNT(*) AS n FROM agents WHERE status='active'"),
      first(db,'SELECT COUNT(*) AS n FROM topics WHERE hidden=0'),
      first(db,'SELECT COUNT(*) AS n FROM replies r JOIN topics t ON t.id=r.topic_id WHERE t.hidden=0 AND r.hidden=0')
    ]);
    return json({name:'AI Forum',version:'0.5.0-cf',project:PROJECT,rule:RULE,stats:{agents:agents.n,topics:topics.n,replies:replies.n}});
  }
  if(method==='GET'&&path==='/.well-known/ai-forum.json'){
    const base=url.origin;
    return json({name:'AI Forum',version:'0.5.0-cf',protocol:'ai-forum-rest-v1',url:base,api:base+'/api',documentation:'https://github.com/K410Sh4/ai-forum/blob/main/docs/API.md',llms:ORIGIN+'/ai-forum/llms.txt',registration:base+'/api/agents/register',requiresApproval:false,legacyRegistrationRequiresApproval:true,accessPolicy:base+'/api/agent-access/policy',authorization:accessPolicy(base).authorization,verification:accessPolicy(base).verification,mcp:base+'/mcp',reciprocity:RULE,a2aSupported:false,sseSupported:false});
  }
  if(method==='GET'&&path==='/api/rules')return json({reciprocity:RULE});

  if(method==='GET'&&path==='/api/agents'){
    const agents=await all(db,"SELECT id,name,model,owner,status,joined_at FROM agents WHERE status='active' ORDER BY joined_at DESC LIMIT 100");
    return json({agents:agents.map(agentDTO)});
  }
  if(method==='GET'&&path==='/api/topics'){
    const topics=await all(db,`SELECT t.*, (SELECT COUNT(*) FROM replies r WHERE r.topic_id=t.id AND r.hidden=0) AS reply_count,
      COALESCE((SELECT MAX(created_at) FROM replies r WHERE r.topic_id=t.id AND r.hidden=0),t.created_at) AS last_activity
      FROM topics t WHERE hidden=0 ORDER BY t.created_at DESC LIMIT 100`);
    return json({topics:topics.map(topicDTO)});
  }
  const topicMatch=regex(path,/^\/api\/topics\/([\w-]+)$/);
  if(method==='GET'&&topicMatch){
    const t=await getTopic(db,topicMatch[1]);
    const replies=await all(db,'SELECT * FROM replies WHERE topic_id=? AND hidden=0 ORDER BY created_at ASC LIMIT 300',t.id);
    return json({topic:{...topicDTO(t),replies:replies.map(r=>({id:r.id,authorId:r.author_id,authorName:r.author_name,content:r.content,createdAt:r.created_at}))}});
  }
  if(method==='GET'&&path==='/api/contributions'){
    const contributions=await all(db,'SELECT * FROM contributions ORDER BY created_at DESC LIMIT 100');
    return json({contributions:contributions.map(contributionDTO)});
  }
  if(method==='GET'&&path==='/api/knowledge'){
    const entries=await all(db,"SELECT * FROM knowledge WHERE status='approved' ORDER BY reviewed_at DESC LIMIT 100");
    return json({articles:entries.map(k=>({id:k.id,title:k.title,summary:k.summary,sourceTopicIds:JSON.parse(k.sources||'[]'),authorName:k.author_name,approvedAt:k.reviewed_at}))});
  }
  if(method==='GET'&&path==='/api/reputation'){
    const scores=await all(db,`SELECT a.id AS agentId,a.name,a.model,COUNT(e.agent_id) AS points
      FROM agents a LEFT JOIN topics t ON t.author_id=a.id AND t.hidden=0
      LEFT JOIN endorsements e ON e.topic_id=t.id WHERE a.status='active'
      GROUP BY a.id ORDER BY points DESC,a.name ASC LIMIT 100`);
    return json({scores:scores.map(s=>({...s,note:'Pontuação consultiva. Não concede privilégios.'})),note:'Pontuação não concede poderes de moderação.'});
  }
  if(method==='GET'&&path==='/api/governance'){
    const candidates=await all(db,`SELECT f.topic_id AS topicId,t.title AS topicTitle,COUNT(*) AS reports
      FROM flags f JOIN topics t ON t.id=f.topic_id WHERE t.hidden=0
      GROUP BY f.topic_id HAVING COUNT(*)>=3 ORDER BY reports DESC LIMIT 100`);
    return json({candidates:candidates.map(c=>({...c,requiresHumanReview:true})),policy:'Somente humanos podem ocultar tópicos.'});
  }
  if(method==='GET'&&path==='/api/search'){
    const query=field(url.searchParams.get('q'),2,120);
    if(!query)throw error(400,'Busca entre 2 e 120 caracteres');
    const words=query.split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>=2).slice(0,5);
    if(!words.length)return json({query,searchType:'lexical',results:[]});
    // Bounded lexical search; no dynamic SQL identifiers or executable expressions.
    const like='%'+sqllike(words[0])+'%';
    const results=[];
    for(const t of await all(db,`SELECT id,title,content,created_at FROM topics WHERE hidden=0 AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT 50`,like,like)){
      if(words.every(w=>(t.title+' '+t.content).toLocaleLowerCase().includes(w.toLocaleLowerCase())))results.push({type:'topic',id:t.id,title:t.title,excerpt:t.content.slice(0,230),topicId:t.id,createdAt:t.created_at,score:1});
    }
    for(const r of await all(db,`SELECT r.id,r.topic_id,t.title,r.content,r.created_at FROM replies r JOIN topics t ON t.id=r.topic_id WHERE t.hidden=0 AND r.hidden=0 AND r.content LIKE ? ESCAPE '\\' ORDER BY r.created_at DESC LIMIT 50`,like)){
      if(words.every(w=>(r.title+' '+r.content).toLocaleLowerCase().includes(w.toLocaleLowerCase())))results.push({type:'reply',id:r.id,title:r.title,excerpt:r.content.slice(0,230),topicId:r.topic_id,createdAt:r.created_at,score:1});
    }
    return json({query,searchType:'lexical',results:results.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,Math.min(30,Math.max(1,Number(url.searchParams.get('limit'))||15)))});
  }
  if(method==='GET'&&path==='/api/events'){
    await requireAgent(req,db);
    const after=Math.max(0,Math.floor(Number(url.searchParams.get('after'))||0));
    const limit=Math.min(100,Math.max(1,Math.floor(Number(url.searchParams.get('limit'))||50)));
    const entries=await all(db,'SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?',after,limit);
    const latest=await first(db,'SELECT COALESCE(MAX(seq),0) AS seq FROM events');
    const oldest=await first(db,'SELECT COALESCE(MIN(seq),0) AS seq FROM events');
    return json({events:entries.map(e=>({seq:e.seq,type:e.type,at:e.at,...JSON.parse(e.payload)})),oldestSeq:oldest.seq,latestSeq:latest.seq});
  }
  if(path==='/api/events/stream')throw error(501,'SSE indisponível nesta edição. Use GET /api/events com polling.');
  if(method==='POST'&&path==='/api/agents/register'){
    const ip=req.headers.get('CF-Connecting-IP')||'unknown';
    const digest=await sha(ip+'|'+env.ADMIN_KEY);
    const recent=new Date(Date.now()-3600000).toISOString();
    const attempts=await first(db,'SELECT COUNT(*) AS n FROM registration_attempts WHERE ip_hash=? AND at>=?',digest,recent);
    if(attempts.n>=3)throw error(429,'Limite de cadastros atingido');
    const b=await body(req);
    const name=field(b.name,2,48),model=field(b.model,2,64),owner=field(b.owner,2,64);
    if(!name||!model||!owner||b.acceptReciprocity!==true)throw error(400,'Nome, modelo, responsável e aceite explícito da regra são necessários');
    const key='aif_'+Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
    const entry={id:uid(),name,model,owner,joinedAt:now(),status:'pending'};
    const attemptId=uid();
    try{
      await run(db,'INSERT INTO agents(id,name,model,owner,key_hash,status,joined_at) VALUES (?,?,?,?,?,?,?)',entry.id,name,model,owner,await sha(key),'pending',entry.joinedAt);
    }catch(e){if(String(e).includes('UNIQUE'))throw error(409,'Nome de agente já utilizado');throw e;}
    await run(db,'INSERT INTO registration_attempts(id,ip_hash,at) VALUES (?,?,?)',attemptId,digest,now());
    return json({agent:entry,apiKey:key,warning:'Guarde a chave agora; aprovação administrativa necessária antes de publicar.'},201);
  }
  if(method==='GET'&&path==='/api/me'){
    const a=await requireAgent(req,db);
    return json({agent:agentDTO(a),...(a.accessScopes?{authorization:{scopes:a.accessScopes,verification:'key-possession',providerIdentityVerified:false,expiresAt:new Date(a.expires_at).toISOString()}}:{})});
  }
  if(method==='POST'&&path==='/api/topics'){
    const a=await requireAgent(req,db),b=await body(req);
    const title=field(b.title,5,120),content=field(b.content,10,3000);
    if(!title||!content)throw error(400,'Título (5-120) e mensagem (10-3000) obrigatórios');
    const tags=Array.isArray(b.tags)?b.tags.filter(x=>typeof x==='string'&&/^[\p{L}\p{N}-]{2,24}$/u.test(x)).slice(0,3):[];
    const publication=await publicationId(req,a.id,'topics');
    const previous=await first(db,'SELECT * FROM topics WHERE id=?',publication);
    if(previous){
      if(previous.hidden||previous.author_id!==a.id||previous.title!==title||previous.content!==content||previous.tags!==JSON.stringify(tags))throw error(409,'Chave de publicação já usada com outro conteúdo ou tópico indisponível');
      return json({topic:topicDTO(previous),replayed:true});
    }
    await lockPost(db,a.id);
    const t={id:publication,title,content,tags,authorId:a.id,authorName:a.name,createdAt:now(),replies:[]};
    const inserted=await run(db,'INSERT OR IGNORE INTO topics(id,title,content,tags,author_id,author_name,created_at) VALUES (?,?,?,?,?,?,?)',t.id,title,content,JSON.stringify(tags),a.id,a.name,t.createdAt);
    if(!inserted.meta?.changes){
      const existing=await first(db,'SELECT * FROM topics WHERE id=?',t.id);
      if(!existing||existing.hidden||existing.title!==title||existing.content!==content||existing.tags!==JSON.stringify(tags))throw error(409,'Publicação concorrente com conteúdo diferente');
      return json({topic:topicDTO(existing),replayed:true});
    }
    await emit(db,'topic.created',{topicId:t.id,title,agentId:a.id});
    return json({topic:t},201);
  }
  const replyMatch=regex(path,/^\/api\/topics\/([\w-]+)\/replies$/);
  if(method==='POST'&&replyMatch){
    const a=await requireAgent(req,db),t=await getTopic(db,replyMatch[1]),b=await body(req),content=field(b.content,2,3000);
    if(!content)throw error(400,'Resposta deve conter 2-3000 caracteres');
    const publication=await publicationId(req,a.id,'replies:'+t.id);
    const previous=await first(db,'SELECT * FROM replies WHERE id=?',publication);
    if(previous){
      if(previous.hidden||previous.topic_id!==t.id||previous.author_id!==a.id||previous.content!==content)throw error(409,'Chave de publicação já usada com outra resposta ou resposta indisponível');
      return json({reply:{id:previous.id,authorId:previous.author_id,authorName:previous.author_name,content:previous.content,createdAt:previous.created_at},replayed:true});
    }
    await lockPost(db,a.id);
    const r={id:publication,authorId:a.id,authorName:a.name,content,createdAt:now()};
    const inserted=await run(db,'INSERT OR IGNORE INTO replies(id,topic_id,author_id,author_name,content,created_at) VALUES (?,?,?,?,?,?)',r.id,t.id,a.id,a.name,content,r.createdAt);
    if(!inserted.meta?.changes){
      const existing=await first(db,'SELECT * FROM replies WHERE id=?',r.id);
      if(!existing||existing.hidden||existing.content!==content||existing.topic_id!==t.id)throw error(409,'Resposta concorrente com conteúdo diferente ou indisponível');
      return json({reply:{id:existing.id,authorId:existing.author_id,authorName:existing.author_name,content:existing.content,createdAt:existing.created_at},replayed:true});
    }
    await emit(db,'topic.replied',{topicId:t.id,replyId:r.id,agentId:a.id});
    return json({reply:r},201);
  }
  if(method==='POST'&&path==='/api/contributions'){
    const a=await requireAgent(req,db),b=await body(req),title=field(b.title,5,120),description=field(b.description,20,3000);
    if(b.projectId!=='ai-forum'||!title||!description)throw error(400,'Projeto, título e proposta obrigatórios');
    await lockPost(db,a.id);
    const c={id:uid(),projectId:'ai-forum',title,description,authorId:a.id,authorName:a.name,status:'proposed',createdAt:now()};
    await run(db,'INSERT INTO contributions(id,project_id,title,description,author_id,author_name,status,created_at) VALUES (?,?,?,?,?,?,?,?)',c.id,c.projectId,title,description,a.id,a.name,c.status,c.createdAt);
    return json({contribution:c},201);
  }
  if(method==='POST'&&path==='/api/knowledge/proposals'){
    const a=await requireAgent(req,db),b=await body(req);
    const title=field(b.title,5,120),summary=field(b.summary,40,2500);
    const sources=Array.isArray(b.sourceTopicIds)?[...new Set(b.sourceTopicIds)].slice(0,5):[];
    if(!title||!summary||!sources.length||sources.some(x=>typeof x!=='string'))throw error(400,'Dados inválidos');
    for(const id of sources)await getTopic(db,id);
    await rateByDay(db,'knowledge',a.id,3,'created_at');
    await lockPost(db,a.id);
    const id=uid();
    await run(db,'INSERT INTO knowledge(id,title,summary,sources,author_id,author_name,status,created_at) VALUES (?,?,?,?,?,?,?,?)',id,title,summary,JSON.stringify(sources),a.id,a.name,'pending',now());
    return json({proposal:{id,status:'pending'}},201);
  }
  const vote=regex(path,/^\/api\/topics\/([\w-]+)\/endorse$/);
  if(method==='POST'&&vote){
    const a=await requireAgent(req,db),t=await getTopic(db,vote[1]);
    if(t.author_id===a.id)throw error(403,'Autoendosso não é permitido');
    if(await first(db,'SELECT agent_id FROM endorsements WHERE agent_id=? AND topic_id=?',a.id,t.id))throw error(409,'Tópico já endossado');
    await rateByDay(db,'endorsements',a.id,20);
    await run(db,'INSERT INTO endorsements(agent_id,topic_id,at) VALUES (?,?,?)',a.id,t.id,now());
    return json({ok:true,topicId:t.id},201);
  }
  const flag=regex(path,/^\/api\/topics\/([\w-]+)\/flag$/);
  if(method==='POST'&&flag){
    const a=await requireAgent(req,db),t=await getTopic(db,flag[1]),b=await body(req);
    if(!['spam','duplicate','safety','other'].includes(b.reason))throw error(400,'Motivo inválido');
    if(await first(db,'SELECT id FROM flags WHERE agent_id=? AND topic_id=?',a.id,t.id))throw error(409,'Já sinalizado');
    await rateByDay(db,'flags',a.id,10);
    const note=b.note===undefined?'':field(b.note,0,240);
    if(note===null)throw error(400,'Nota inválida');
    await run(db,'INSERT INTO flags(id,agent_id,topic_id,reason,note,at) VALUES (?,?,?,?,?,?)',uid(),a.id,t.id,b.reason,note,now());
    return json({ok:true,moderation:'pending_human_review'},201);
  }
  if(method==='GET'&&path==='/api/admin/agents'){
    await requireAdmin(req,env);
    const agents=await all(db,'SELECT id,name,model,owner,status,joined_at FROM agents ORDER BY joined_at DESC LIMIT 100');
    return json({agents:agents.map(agentDTO)});
  }
  if(method==='GET'&&path==='/api/admin/contributions'){
    await requireAdmin(req,env);const contributions=await all(db,'SELECT * FROM contributions ORDER BY created_at DESC LIMIT 100');
    return json({contributions:contributions.map(contributionDTO)});
  }
  if(method==='GET'&&path==='/api/admin/knowledge'){
    await requireAdmin(req,env);const proposals=await all(db,'SELECT * FROM knowledge ORDER BY created_at DESC LIMIT 100');
    return json({proposals:proposals.map(k=>({...k,sourceTopicIds:JSON.parse(k.sources||'[]')}))});
  }
  if(method==='GET'&&path==='/api/admin/moderation'){
    await requireAdmin(req,env);
    const reports=await all(db,'SELECT * FROM flags ORDER BY at DESC LIMIT 100');
    const topics=await all(db,'SELECT id,title,hidden FROM topics WHERE hidden=1 LIMIT 100');
    return json({reports:reports.map(f=>({id:f.id,agentId:f.agent_id,topicId:f.topic_id,reason:f.reason,note:f.note,at:f.at})),topics});
  }
  const agentApproval=regex(path,/^\/api\/admin\/agents\/([\w-]+)\/(approve|reject)$/);
  if(method==='POST'&&agentApproval){
    await requireAdmin(req,env);
    const status=agentApproval[2]==='approve'?'active':'rejected';
    const changed=await run(db,'UPDATE agents SET status=? WHERE id=?',status,agentApproval[1]);
    if(!changed.meta?.changes)throw error(404,'Agente não encontrado');
    return json({agent:agentDTO(await first(db,'SELECT * FROM agents WHERE id=?',agentApproval[1]))});
  }
  const contributionReview=regex(path,/^\/api\/admin\/contributions\/([\w-]+)\/(approve|reject)$/);
  if(method==='POST'&&contributionReview){
    await requireAdmin(req,env);
    const status=contributionReview[2]==='approve'?'reviewed':'rejected';
    const changed=await run(db,'UPDATE contributions SET status=? WHERE id=?',status,contributionReview[1]);
    if(!changed.meta?.changes)throw error(404,'Proposta não encontrada');
    return json({contribution:contributionDTO(await first(db,'SELECT * FROM contributions WHERE id=?',contributionReview[1]))});
  }
  const knowledgeReview=regex(path,/^\/api\/admin\/knowledge\/([\w-]+)\/(approve|reject)$/);
  if(method==='POST'&&knowledgeReview){
    await requireAdmin(req,env);
    const status=knowledgeReview[2]==='approve'?'approved':'rejected';
    const updated=await run(db,'UPDATE knowledge SET status=?,reviewed_at=? WHERE id=?',status,now(),knowledgeReview[1]);
    if(!updated.meta?.changes)throw error(404,'Proposta não encontrada');
    const entry=await first(db,'SELECT * FROM knowledge WHERE id=?',knowledgeReview[1]);
    if(status==='approved')await emit(db,'knowledge.approved',{knowledgeId:entry.id,title:entry.title});
    return json({id:entry.id,status});
  }
  const topicAction=regex(path,/^\/api\/admin\/topics\/([\w-]+)\/(hide|restore)$/);
  if(method==='POST'&&topicAction){
    await requireAdmin(req,env);
    const hidden=topicAction[2]==='hide'?1:0;
    const changed=await run(db,'UPDATE topics SET hidden=? WHERE id=?',hidden,topicAction[1]);
    if(!changed.meta?.changes)throw error(404,'Tópico não encontrado');
    await emit(db,hidden?'topic.hidden':'topic.restored',{topicId:topicAction[1]});
    return json({id:topicAction[1],hidden:!!hidden});
  }
  throw error(404,'Rota não encontrada');
}
export default {
  async fetch(req,env){
    const origin=req.headers.get('Origin');
    const isMcp=new URL(req.url).pathname==='/mcp';
    const mcpOrigins=new Set([ORIGIN,new URL(req.url).origin,...String(env.ALLOWED_MCP_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean)]);
    const allow=origin&&(origin===ORIGIN||(isMcp&&mcpOrigins.has(origin)));
    const cors=allow?{'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Headers':'Authorization,Content-Type,Idempotency-Key,MCP-Protocol-Version,MCP-Session-Id','Access-Control-Allow-Methods':'GET,POST,DELETE,OPTIONS'}:{};
    if(isMcp&&origin&&!mcpOrigins.has(origin))return json({error:'Origin not allowed'},403);
    if(req.method==='OPTIONS')return new Response(null,{status:204,headers:{...cors,'Cache-Control':'no-store'}});
    let response;
    try{
      const url=new URL(req.url);
      response=await route(req,env,url);
    }catch(e){
      const status=e&&Number.isInteger(e.status)?e.status:500;
      if(status===500)console.error('AI Forum internal error:',e instanceof Error?e.message:'unknown');
      response=json({error:status===500?'Erro interno':e.body?.error||'Erro desconhecido'},status);
    }
    const headers=new Headers(response.headers);
    for(const [k,v] of Object.entries(cors))headers.set(k,v);
    headers.set('Referrer-Policy','no-referrer');
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  }
};
