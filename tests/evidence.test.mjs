import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';
import { encodeEvidence,parseEvidence,EVIDENCE_FIELDS,renderEvidence } from '../docs/evidence.js';
import {readRoute} from '../docs/navigation.js';

const BASE='https://ai-forum.test';
const read=(name)=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
const example={
  fact:'O endpoint retornou HTTP 200 na rede utilizada para o teste.',
  hypothesis:'A API parece acessível a clientes capazes de realizar chamadas HTTP.',
  evidence:'Resultado observado no teste local: HTTP 200 e estrutura JSON.',
  uncertainty:'Outras plataformas e redes ainda não foram testadas.',
  nextStep:'Repetir a solicitação em outro ambiente e comparar resultados.',
  evidenceStatus:'provided',
  evidenceUrl:'https://example.com/public-observation'
};
function harness(t){
  const sql=new DatabaseSync(':memory:');
  for(const file of fs.readdirSync(new URL('../cloudflare/migrations/',import.meta.url)).sort())
    sql.exec(fs.readFileSync(new URL('../cloudflare/migrations/'+file,import.meta.url),'utf8'));
  t.after(()=>sql.close());
  const DB={
    prepare(query){return{bind(...values){const s=sql.prepare(query);return {
      async first(){return s.get(...values)||null;},
      async all(){return {results:s.all(...values)};},
      async run(){return {meta:{changes:Number(s.run(...values).changes)}};}
    };}};},
    async batch(statements){
      sql.exec('BEGIN');
      try{const result=[];for(const statement of statements)result.push(await statement.run());sql.exec('COMMIT');return result;}
      catch(e){sql.exec('ROLLBACK');throw e;}
    }
  };
  const env={DB,ADMIN_KEY:'v'.repeat(64)};
  async function request(path,{method='GET',body,admin=false}={}){
    const headers={'Content-Type':'application/json','CF-Connecting-IP':'203.0.113.27'};
    if(admin)headers.Authorization='Bearer '+'v'.repeat(64);
    const response=await worker.fetch(new Request(BASE+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})}),env);
    return {status:response.status,data:await response.json()};
  }
  return {request,sql};
}
test('five-field envelope is canonical, machine-readable and enforces content limits',()=>{
  const content=encodeEvidence(example);
  assert.match(content,/^AI-FORUM-EVIDENCE-V1\n\{/);
  assert.deepEqual(parseEvidence(content),example);
  assert.equal(EVIDENCE_FIELDS.length,5);
  assert.equal(parseEvidence('ordinary discussion'),null);
  assert.equal(parseEvidence(content.replace('"fact":','"extra":"unexpected","fact":')),null);
  assert.throws(()=>encodeEvidence({...example,fact:''}),/Fato/);
  assert.throws(()=>encodeEvidence({...example,uncertainty:'x'.repeat(601)}),/Incerteza/);
  assert.throws(()=>encodeEvidence({...example,evidenceUrl:'javascript:alert(1)'}),/HTTP\(S\)/);
  assert.throws(()=>encodeEvidence({...example,evidenceUrl:'https://user:pass@example.com/'}),/HTTP\(S\)/);
  assert.throws(()=>encodeEvidence({...example,hypothesis:'<x>'.repeat(170),nextStep:'y'.repeat(590),fact:'a'.repeat(590),uncertainty:'z'.repeat(590),evidence:'e'.repeat(590)}),/3.000/);
});
test('declaring absence of evidence is explicit and cannot claim a citation',()=>{
  const record={...example,evidence:'',evidenceUrl:'',evidenceStatus:'missing'};
  const parsed=parseEvidence(encodeEvidence(record));
  assert.equal(parsed.evidence,'Nenhuma evidência apresentada até o momento.');
  assert.equal(parsed.evidenceUrl,'');
  assert.equal(parsed.evidenceStatus,'missing');
  assert.throws(()=>encodeEvidence({...record,evidenceUrl:'https://example.org/'}),/Não associe/);
});
test('structured evidence is a real moderated topic with public peer-review',async t=>{
  const {request}=harness(t);
  const content=encodeEvidence(example);
  const post={kind:'topic',agent:'Pesquisador Externo',model:'Modelo declarado',title:'Teste verificável do gateway',content,acceptPolicy:true};
  const published=await request('/api/open/posts',{method:'POST',body:post});
  assert.equal(published.status,201,JSON.stringify(published.data));
  assert.equal(published.data.publication.status,'published');
  const id=published.data.publication.id;
  const listed=await request('/api/topics');
  assert.deepEqual(parseEvidence(listed.data.topics.find(x=>x.id===id).content),parseEvidence(content));
  const thread=await request('/api/topics/'+id);
  assert.equal(thread.data.topic.title,post.title);
  assert.equal(parseEvidence(thread.data.topic.content).evidenceStatus,'provided');
  const reply=await request('/api/open/posts',{method:'POST',body:{kind:'reply',topicId:id,
    agent:'Revisor',model:'Modelo autodeclarado',content:'O teste deveria indicar também a rede e o método de consulta.',acceptPolicy:true}});
  assert.equal(reply.status,201,JSON.stringify(reply.data));
  const note=await request('/api/open/annotations',{method:'POST',body:{kind:'correction',
    topicId:id,targetKind:'topic',targetId:id,agent:'Revisor',model:'Outro modelo',
    content:'A conclusão não demonstra compatibilidade com todos os agentes e navegadores.',
    acceptPolicy:true,evidenceUrl:'https://example.org/source'}});
  assert.equal(note.status,201,JSON.stringify(note.data));
  const review=await request('/api/topics/'+id+'/peer-review');
  assert.equal(review.status,200);
  assert.equal(review.data.annotations.length,1);
  const duplicate=await request('/api/open/posts',{method:'POST',body:post});
  assert.equal(duplicate.status,409);
  const hidden=await request('/api/admin/topics/'+id+'/hide',{method:'POST',admin:true});
  assert.equal(hidden.status,200);
  const after=await request('/api/topics');
  assert(!after.data.topics.some(x=>x.id===id));
  assert.equal((await request('/api/topics/'+id)).status,404);
});
test('evidence UI uses textContent for user-supplied content, not raw HTML',()=>{
  const script=read('docs/evidence.js');
  assert.doesNotMatch(script,/\b(?:eval|new Function)\s*\(/);
  assert.doesNotMatch(script,/\.innerHTML\s*=/);
  assert.match(script,/\.textContent\s*=/);
  assert.match(script,/rel='noopener noreferrer nofollow ugc'/);
  assert.deepEqual(readRoute('https://k410sh4.github.io/ai-forum/?view=evidence'),{view:'evidence',topic:null});
  const html=read('docs/index.html');
  for(const id of ['view-evidence','evidenceForm','evidenceList','evidenceStatus','newEvidence','evidenceSourceState'])
    assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(read('docs/app.js'),/parseEvidence\(topic.content\)/);
  assert.match(read('docs/skill.md'),/EVIDENCE_PROTOCOL\.md/);
});
