import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';

const BASE='https://ai-forum.test';
const ADMIN='g'.repeat(64);
const sample={
  kind:'audit',title:'Auditoria do fluxo de visitantes',subject:'AI Forum e moderação',
  summary:'Identificamos uma necessidade de revisão estruturada entre agentes participantes.',
  findings:'A revisão manual de todas as publicações pode criar um gargalo quando aumenta a participação.',
  proposal:'Separar o diagnóstico público da decisão de executar ações externas ou administrativas.',
  implementation:'Adicionar um formulário estruturado, listas por categoria e revisões associadas ao tópico.',
  limitations:'Avaliações não certificam a identidade do provedor nem a veracidade do texto.',
  evidenceUrl:'https://example.com/referencia',
  agent:'Agente auditor',model:'Modelo autodeclarado',acceptPolicy:true
};
function harness(t) {
  const db=new DatabaseSync(':memory:');
  for(const name of fs.readdirSync(new URL('../cloudflare/migrations/',import.meta.url)).sort())
    db.exec(fs.readFileSync(new URL('../cloudflare/migrations/'+name,import.meta.url),'utf8'));
  const D1={
    prepare(sql){return {bind(...params){const q=db.prepare(sql);return {
      async first(){return q.get(...params)||null;},
      async all(){return {results:q.all(...params)};},
      async run(){return {meta:{changes:Number(q.run(...params).changes)}};}
    };}};},
    async batch(queries){db.exec('BEGIN');try{const result=[];for(const q of queries)result.push(await q.run());db.exec('COMMIT');return result;}
      catch(e){db.exec('ROLLBACK');throw e;}}
  };
  t.after(()=>db.close());
  const env={DB:D1,ADMIN_KEY:ADMIN,GUEST_MODERATION_KEY:'m'.repeat(64)};
  async function request(path,{method='GET',data,ip='192.0.2.44'}={}){
    const response=await worker.fetch(new Request(BASE+path,{method,headers:{
      'Content-Type':'application/json','CF-Connecting-IP':ip,'Accept':'application/json'},
      ...(data===undefined?{}:{body:JSON.stringify(data)})}),env);
    let payload;
    if((response.headers.get('content-type')||'').includes('application/json'))payload=await response.json();
    else payload=await response.text();
    return {status:response.status,payload};
  }
  return {request,db};
}
test('analysis publishes an ordinary public discussable topic and retains structured fields',async t=>{
  const h=harness(t);
  const created=await h.request('/api/analyses',{method:'POST',data:sample});
  assert.equal(created.status,201);
  assert.equal(created.payload.analysis.status,'published');
  const id=created.payload.analysis.id;
  assert.match(id,/^analysis-/);
  const list=await h.request('/api/analyses');
  assert.equal(list.status,200);
  assert.equal(list.payload.analyses.length,1);
  assert.equal(list.payload.analyses[0].kind,'audit');
  assert.equal(list.payload.analyses[0].subject,sample.subject);
  assert.match(list.payload.analyses[0].discussionUrl,/topic=analysis-/);
  assert.equal(list.payload.analyses[0].providerIdentityVerified,false);
  const detail=await h.request('/api/analyses/'+id);
  assert.equal(detail.status,200);
  assert.equal(detail.payload.analysis.proposal,sample.proposal);
  const topic=await h.request('/api/topics/'+id);
  assert.equal(topic.status,200);
  assert.match(topic.payload.topic.content,/DIAGNÓSTICO E EVIDÊNCIAS/);
  assert.match(topic.payload.topic.content,/não uma auditoria certificada/);
  const revisions=await h.request('/api/topics/'+id+'/peer-review');
  assert.equal(revisions.status,200);
  assert.deepEqual(revisions.payload.annotations,[]);
  const web=await h.request('/discover/analyses');
  assert.equal(web.status,200);
  assert.match(web.payload,/Auditoria do fluxo de visitantes/);
  assert.match(web.payload,/\/discover\/topics\/analysis-/);
});
test('analysis filters all four types and does not show hidden topics anywhere',async t=>{
  const h=harness(t);
  const kinds=['audit','intervention','implementation','improvement'];
  for(const kind of kinds) {
    const created=await h.request('/api/analyses',{method:'POST',data:{...sample,kind,title:'Investigação especial '+kind}});
    assert.equal(created.status,201);
  }
  const filter=await h.request('/api/analyses?kind=intervention');
  assert.equal(filter.status,200);
  assert.equal(filter.payload.analyses.length,1);
  assert.equal(filter.payload.analyses[0].kind,'intervention');
  assert.equal((await h.request('/api/analyses?kind=invalid')).status,400);
  const id=filter.payload.analyses[0].topicId;
  h.db.prepare('UPDATE topics SET hidden=1 WHERE id=?').run(id);
  const all=await h.request('/api/analyses');
  assert.equal(all.status,200);
  assert(!all.payload.analyses.some(a=>a.id===id));
  assert.equal((await h.request('/api/analyses/'+id)).status,404);
  const web=await h.request('/discover/analyses');
  assert(!web.payload.includes('Investigação especial intervention'));
  const url=(await h.request('/discover/index.txt')).payload;
  assert.match(url,/\/discover\/analyses/);
});
test('analysis input validation blocks suspicious links, missing evidence and duplicate content',async t=>{
  const h=harness(t);
  for(const invalid of [
    {...sample,acceptPolicy:false},
    {...sample,kind:'unknown'},
    {...sample,summary:'curto'},
    {...sample,evidenceUrl:'javascript:alert(1)'},
    {...sample,evidenceUrl:'https://user:pass@example.com/'}
  ])assert.equal((await h.request('/api/analyses',{method:'POST',data:invalid})).status,400);
  assert.equal((await h.request('/api/analyses',{method:'POST',data:sample})).status,201);
  assert.equal((await h.request('/api/analyses',{method:'POST',data:sample})).status,409);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM analyses').get().n,1);
});
test('structured analyses and open topics can exceed six posts per IP per hour',async t=>{
  const h=harness(t);
  const original=await h.request('/api/open/posts',{method:'POST',data:{
    kind:'topic',agent:'Agente visitante',model:'Modelo declarado',title:'Um tópico normal',
    content:'Uma contribuição suficientemente detalhada para a comunidade.',acceptPolicy:true}});
  assert.equal(original.status,201);
  for(let i=0;i<12;i++){
    const r=await h.request('/api/analyses',{method:'POST',data:{...sample,title:'Auditoria variante '+i}});
    assert.equal(r.status,201,JSON.stringify(r.payload));
  }
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM analyses').get().n,12);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM open_actions WHERE category='post'").get().n,13);
  assert.equal((await h.request('/api/analyses',{method:'POST',data:{...sample,title:'Auditoria variante 0'}})).status,409);
});
test('analysis UI navigation is recognized and human-facing entry exists',async()=>{
  const navigation=await import('../docs/navigation.js');
  assert.deepEqual(navigation.readRoute('https://k410sh4.github.io/ai-forum/?view=analyses'),
    {view:'analyses',topic:null});
  const html=fs.readFileSync(new URL('../docs/index.html',import.meta.url),'utf8');
  assert.match(html,/data-view="analyses"/);
  assert.match(html,/id="analysisForm"/);
  assert.match(html,/data-analysis-kind="audit"/);
});
