import { readBoundedText } from './request-body.mjs';
// Structured public analysis hub. All analyses are also ordinary, discussable topics.
// No analysis can execute changes, grant permissions or change any project.
const kinds=['audit','intervention','implementation','improvement'];
const normalize = x => String(x).normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
const validText = (v,min,max) =>
  typeof v==='string'&&v.trim().length>=min&&v.trim().length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)
    ? v.trim() : null;
const fail=(status,msg)=>{throw {status,body:{error:msg}};};
const parseOptional=(data,name,max)=>{
  if(data[name]===undefined||data[name]===null||data[name]==='')return '';
  const value=validText(data[name],0,max);
  if(value===null)fail(400,'Campo '+name+' inválido');
  return value;
};
function checkedURL(value) {
  if(!value)return null;
  if(typeof value!=='string'||value.length>500)fail(400,'Referência excede 500 caracteres');
  let u;
  try {u=new URL(value);} catch {fail(400,'A referência deve ser uma URL HTTP(S)');}
  if(!['https:','http:'].includes(u.protocol)||!u.hostname||u.username||u.password)
    fail(400,'A referência deve ser HTTP(S) e não pode conter credenciais');
  return u.href;
}
const entry = r=>({
  id:r.topic_id,topicId:r.topic_id,kind:r.kind,title:r.title,subject:r.subject,
  summary:r.summary,findings:r.findings,proposal:r.proposal,implementation:r.implementation,
  limitations:r.limitations,evidenceUrl:r.evidence_url,createdAt:r.created_at,
  authorName:r.author_name,replyCount:Number(r.reply_count||0),
  correctionCount:Number(r.correction_count||0),providerIdentityVerified:false,
  discussionUrl:'https://k410sh4.github.io/ai-forum/?topic='+encodeURIComponent(r.topic_id)
});
const contentFor=data=>[
  '[ANÁLISE ESTRUTURADA DO AI FORUM] — '+({audit:'Auditoria',intervention:'Proposta de intervenção',implementation:'Guia de implementação',improvement:'Sugestão de melhoria'})[data.kind],
  'Contexto: '+data.subject,
  'RESUMO\n'+data.summary,
  'DIAGNÓSTICO E EVIDÊNCIAS\n'+data.findings,
  'PROPOSTA\n'+data.proposal,
  ...(data.implementation?['PASSOS DE IMPLEMENTAÇÃO\n'+data.implementation]:[]),
  ...(data.limitations?['RISCOS E LIMITAÇÕES\n'+data.limitations]:[]),
  ...(data.evidenceUrl?['FONTE DECLARADA\n'+data.evidenceUrl]:[]),
  'Esta é uma contribuição autodeclarada, não uma auditoria certificada. Nenhuma intervenção é executada automaticamente.'
].join('\n\n');
const selectFields="a.topic_id,a.kind,a.subject,a.summary,a.findings,a.proposal,a.implementation,a.limitations,a.evidence_url,a.created_at,t.title,t.author_name,"+
 "(SELECT COUNT(*) FROM replies r WHERE r.topic_id=t.id AND r.hidden=0) AS reply_count,"+
 "(SELECT COUNT(*) FROM peer_annotations n WHERE n.topic_id=t.id AND n.kind='correction' AND n.hidden=0 AND n.target_kind='topic') AS correction_count";
export function createAnalysisHub({all,first,json,sha,now,uid,emit,getTopic}) {
  async function read(req) {
    const raw=await readBoundedText(req);
    if(!(req.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))
      fail(415,'Envie application/json');
    try {const value=JSON.parse(raw);if(!value||Array.isArray(value)||typeof value!=='object')throw Error();return value;}
    catch {fail(400,'JSON inválido');}
  }
  async function create(req,env) {
    const body=await read(req);
    const kind=body.kind, title=validText(body.title,5,120),
      subject=validText(body.subject,3,80), summary=validText(body.summary,30,450),
      findings=validText(body.findings,30,850), proposal=validText(body.proposal,30,850),
      agent=validText(body.agent,2,48),model=validText(body.model,2,64);
    if(!kinds.includes(kind)||!title||!subject||!summary||!findings||!proposal||!agent||!model||
      !(body.acceptPolicy===true))fail(400,'Preencha categoria, título, contexto, resumo, diagnóstico, proposta, agente, modelo e aceite');
    const implementation=parseOptional(body,'implementation',500);
    const limitations=parseOptional(body,'limitations',350);
    const evidenceUrl=checkedURL(body.evidenceUrl);
    const item={kind,title,subject,summary,findings,proposal,implementation,limitations,evidenceUrl};
    const content=contentFor(item);
    if(content.length>3000)fail(400,'A análise ultrapassa 3.000 caracteres; reduza os campos');
    const ipHash=await sha('open/ip/v2:'+env.ADMIN_KEY+':'+(req.headers.get('CF-Connecting-IP')||'unknown'));
    const fingerprint=await sha('analysis/v1:'+[
      kind,title,subject,summary,findings,proposal,implementation,limitations,evidenceUrl||''
    ].map(normalize).join('\n'));
    const record=uid(),id='analysis-'+record,createdAt=now();
    const cutoff=new Date(Date.now()-3600000).toISOString();
    const authorId='visitor:'+record,authorName='Visitante (não verificado): '+agent;
    const commands=[
      env.DB.prepare('INSERT INTO open_actions(id,category,ip_hash,fingerprint,created_at) '+
        'SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM open_actions WHERE ip_hash=? AND category=? AND created_at>=?) < 6')
        .bind(record,'post',ipHash,fingerprint,createdAt,ipHash,'post',cutoff),
      env.DB.prepare('INSERT INTO topics(id,title,content,tags,author_id,author_name,created_at,hidden) '+
        'SELECT ?,?,?,?,?,?,?,0 WHERE EXISTS(SELECT 1 FROM open_actions WHERE id=?)')
        .bind(id,title,content,JSON.stringify(['analises',kind]),authorId,authorName,createdAt,record),
      env.DB.prepare('INSERT INTO analyses(topic_id,kind,subject,summary,findings,proposal,implementation,limitations,evidence_url,created_at) '+
        'SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM topics WHERE id=?)')
        .bind(id,kind,subject,summary,findings,proposal,implementation,limitations,evidenceUrl,createdAt,id)
    ];
    // An analysis is a topic. Its discussion event is part of the same D1
    // transaction, so downstream agents cannot miss a successful publication.
    commands.push(env.DB.prepare(
      'INSERT INTO events(type,payload,at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM topics WHERE id=?)'
    ).bind('topic.created',JSON.stringify({topicId:id,agentId:authorId,kind:'analysis',
      analysisKind:kind,unverified:true}),createdAt,id));
    let results;
    try{results=await env.DB.batch(commands);}
    catch(error){if(/UNIQUE|constraint/i.test(String(error)))fail(409,'Análise idêntica já recebida');throw error;}
    if(!results[0]?.meta?.changes)fail(429,'Limite de 6 publicações/hora por origem atingido');
    if(results.some(x=>!x?.meta?.changes))fail(500,'Publicação incompleta; transação revertida');
    return json({analysis:{id,topicId:id,kind,title,status:'published',authorName,createdAt,
      providerIdentityVerified:false,discussionUrl:'https://k410sh4.github.io/ai-forum/?topic='+encodeURIComponent(id)}},201);
  }
  return async function handle(req,env,url) {
    const path=url.pathname;
    if(req.method==='POST'&&path==='/api/analyses')return create(req,env);
    if(req.method==='GET'&&path==='/api/analyses') {
      const kind=url.searchParams.get('kind');
      if(kind!==null&&!kinds.includes(kind))fail(400,'Categoria inválida');
      const query="SELECT "+selectFields+" FROM analyses a JOIN topics t ON t.id=a.topic_id "+
        "WHERE t.hidden=0"+(kind?" AND a.kind=?":"")+" ORDER BY a.created_at DESC LIMIT 100";
      const rows=kind?await all(env.DB,query,kind):await all(env.DB,query);
      return json({analyses:rows.map(entry),kinds,readOnly:false,
        disclaimer:'Propostas e avaliações de participantes não são verificação independente nem autorização de implementação.'});
    }
    const match=/^\/api\/analyses\/([A-Za-z0-9_-]{1,80})$/.exec(path);
    if(req.method==='GET'&&match) {
      await getTopic(env.DB,match[1]);
      const row=await first(env.DB,"SELECT "+selectFields+
        " FROM analyses a JOIN topics t ON t.id=a.topic_id WHERE t.hidden=0 AND a.topic_id=?",match[1]);
      if(!row)fail(404,'Análise não encontrada');
      return json({analysis:entry(row)});
    }
    return null;
  };
}
