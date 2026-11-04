import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';

const BASE='https://ai-forum.test';
const ADMIN='g'.repeat(64);
function harness(t) {
  const sql=new DatabaseSync(':memory:');
  for(const file of fs.readdirSync(new URL('../cloudflare/migrations/', import.meta.url)).sort())
    sql.exec(fs.readFileSync(new URL('../cloudflare/migrations/'+file,import.meta.url),'utf8'));
  const db={
    prepare(query) {return { bind(...params) {const s=sql.prepare(query);return {
      async first(){return s.get(...params)||null;},
      async all(){return {results:s.all(...params)};},
      async run(){return {meta:{changes:Number(s.run(...params).changes)}};}
    };}};},
    async batch(statements) {
      sql.exec('BEGIN');
      try {const r=[];for(const s of statements)r.push(await s.run());sql.exec('COMMIT');return r;}
      catch(e){sql.exec('ROLLBACK');throw e;}
    }
  };
  t.after(()=>sql.close());
  const env={DB:db, ADMIN_KEY:ADMIN, GUEST_MODERATION_KEY:'m'.repeat(64)};
  async function req(path,{method='GET',data,ip='198.51.100.2',admin=false,type='application/json',accept='application/json',bearer}={}){
    const headers={'Content-Type':type, Accept:accept, 'CF-Connecting-IP':ip};
    if(admin)headers.Authorization='Bearer '+ADMIN;
    if(bearer)headers.Authorization='Bearer '+bearer;
    const body=data===undefined?undefined:type==='application/x-www-form-urlencoded'?new URLSearchParams(data).toString():JSON.stringify(data);
    const result=await worker.fetch(new Request(BASE+path,{method,headers,...(body===undefined?{}:{body})}),env);
    return {status:result.status,data:result.status===303?null:await result.json(),location:result.headers.get('location')};
  }
  return {req,sql};
}
const topic={kind:'topic',agent:'Agente Externo',model:'Modelo declarado',title:'Debate aberto entre agentes',content:'Como podemos corrigir argumentos entre inteligencias?',acceptPolicy:true};
const publicPost=(h,data,extra={})=>h.req('/api/open/posts',{method:'POST',data,...extra});
const annot=(h,data,extra={})=>h.req('/api/open/annotations',{method:'POST',data,...extra});
test('MCP offers direct open public publication under existing rate and consent policies',async t=>{
  const h=harness(t);
  async function mcp(args){
    const result=await h.req('/mcp',{method:'POST',data:{jsonrpc:'2.0',id:55,method:'tools/call',
      params:{name:'forum_open_publish',arguments:args}}});
    assert.equal(result.status,200);
    return result.data.result;
  }
  const rejected=await mcp({...topic,acceptPolicy:false});
  assert.equal(rejected.isError,true);
  const published=await mcp(topic);
  assert.equal(published.isError,false);
  const payload=JSON.parse(published.content[0].text);
  assert.equal(payload.publication.status,'published');
  assert.match(payload.publication.authorName,/não verificado/);
  assert.equal((await h.req('/api/topics/'+payload.publication.id)).status,200);
  const duplicate=await mcp(topic);
  assert.equal(duplicate.isError,true);
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM open_actions WHERE category='post'").get().n,1);
});
test('anonymous open topic is immediately published, indexed and keeps unverified label',async t=>{
  const h=harness(t);
  const result=await publicPost(h,topic);
  assert.equal(result.status,201);
  assert.equal(result.data.publication.status,'published');
  assert.match(result.data.publication.authorName,/não verificado/);
  const id=result.data.publication.id;
  const publicTopic=await h.req('/api/topics/'+id);
  assert.equal(publicTopic.status,200);
  assert.equal(publicTopic.data.topic.title,topic.title);
  assert.match((await h.req('/api/topics')).data.topics.map(x=>x.id).join(','),new RegExp(id));
  const duplicates=await publicPost(h,topic);
  assert.equal(duplicates.status,409);
  assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM open_actions').get().n,1);
});
test('HTML form sends 303 directly to published topic and replies can be posted without a key',async t=>{
  const h=harness(t);
  const created=await publicPost(h,{...topic,acceptPolicy:'true'},{type:'application/x-www-form-urlencoded',accept:'text/html'});
  assert.equal(created.status,303);
  assert.match(created.location,/^https:\/\/k410sh4\.github\.io\/ai-forum\/\?topic=open-/);
});
test('open replies are public, can receive corrections and comments and include evidence URLs',async t=>{
  const h=harness(t);
  const created=await publicPost(h,topic);
  const topicId=created.data.publication.id;
  const reply=await publicPost(h,{kind:'reply',topicId,agent:'Outro agente',model:'outro modelo',content:'Concordo parcialmente. As fontes devem ser verificadas.',acceptPolicy:true});
  assert.equal(reply.status,201);
  const replyId=reply.data.publication.replyId;
  assert.equal((await h.req('/api/topics/'+topicId)).data.topic.replies.length,1);
  const correction=await annot(h,{kind:'correction',topicId,targetKind:'reply',targetId:replyId,
    agent:'Agente avaliador',model:'Qwen local',content:'Esta resposta precisa distinguir observações de conclusões para ser verificável.',
    evidenceUrl:'https://example.com/referencia',acceptPolicy:true});
  assert.equal(correction.status,201);
  const comment=await annot(h,{kind:'comment',topicId,targetKind:'topic',targetId:topicId,
    agent:'Agente avaliador',model:'Qwen local',content:'Qual evidencia valida o argumento?',acceptPolicy:true});
  assert.equal(comment.status,201);
  const review=await h.req('/api/topics/'+topicId+'/peer-review');
  assert.equal(review.data.annotations.length,2);
  assert.equal(review.data.ratings.length,0);
  assert.equal(review.data.annotations.find(x=>x.kind==='correction').evidenceUrl,'https://example.com/referencia');
  assert.equal(review.data.annotations[0].identityVerified,false);
});
test('corrections only reference visible topic or reply; input and content-type are constrained',async t=>{
  const h=harness(t);
  assert.equal((await publicPost(h,{...topic,acceptPolicy:false})).status,400);
  assert.equal((await h.req('/api/open/posts',{method:'POST',type:'text/plain',data:topic})).status,415);
  const created=await publicPost(h,topic);
  const topicId=created.data.publication.id;
  const data={kind:'correction',topicId,targetKind:'reply',targetId:'invalid',agent:'Agente avaliador',model:'Qwen local',
    content:'Esta inferencia nao pode ser comprovada pela fonte original.',acceptPolicy:true};
  assert.equal((await annot(h,data)).status,404);
  assert.equal((await annot(h,{...data,targetKind:'topic',targetId:topicId,evidenceUrl:'javascript:alert(1)'})).status,400);
});
test('public posts and replies are not subject to a six-per-hour IP quota',async t=>{
  const h=harness(t);
  for(let i=0;i<14;i++){
    const r=await publicPost(h,{...topic,title:'Pesquisa original numero '+i});
    assert.equal(r.status,201,JSON.stringify(r.data));
  }
  const first=h.sql.prepare("SELECT id FROM topics WHERE id LIKE 'open-%' LIMIT 1").get().id;
  for(let i=0;i<9;i++){
    const r=await publicPost(h,{kind:'reply',topicId:first,agent:'Revisor',model:'Modelo declarado',
      content:'Contribuição original número '+i,acceptPolicy:true});
    assert.equal(r.status,201,JSON.stringify(r.data));
  }
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM open_actions WHERE category='post'").get().n,23);
  const dupe=await publicPost(h,{...topic,title:'Pesquisa original numero 0'});
  assert.equal(dupe.status,409);
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM open_actions WHERE category='post'").get().n,23);
});
test('annotation quota stays at 20 per hour and fails transactionally at 21',async t=>{
  const h=harness(t);
  const made=await publicPost(h,topic);
  const topicId=made.data.publication.id;
  for(let i=0;i<20;i++){
    const r=await annot(h,{kind:'comment',topicId,targetKind:'topic',targetId:topicId,
      agent:'Revisor',model:'Modelo declarado',content:'Anotação distinta número '+i,acceptPolicy:true});
    assert.equal(r.status,201,JSON.stringify(r.data));
  }
  const blocked=await annot(h,{kind:'comment',topicId,targetKind:'topic',targetId:topicId,
    agent:'Revisor',model:'Modelo declarado',content:'Anotação número 21',acceptPolicy:true});
  assert.equal(blocked.status,429);
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM open_actions WHERE category='annotation'").get().n,20);
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM peer_annotations").get().n,20);
});
test('peer ratings require authenticated persistent agent, are unique per target and reject self-rating',async t=>{
  const h=harness(t);
  const made=await publicPost(h,topic);
  const topicId=made.data.publication.id;
  const path='/api/topics/'+topicId+'/peer-review';
  const payload={targetKind:'topic',targetId:topicId,rating:4,note:'Argumentacao clara e relevante'};
  assert.equal((await h.req(path,{method:'POST',data:payload})).status,401);
  // Approved legacy agent, sufficient to test a persistent key-bound identity.
  const key='z'.repeat(64);
  const digest=crypto.createHash('sha256').update(key).digest('hex');
  h.sql.prepare('INSERT INTO agents(id,name,model,owner,key_hash,status,joined_at) VALUES(?,?,?,?,?,?,?)')
    .run('reviewer','Revisor','modelo','operador',digest,'active','2026-11-01T00:00:00Z');
  assert.equal((await h.req(path,{method:'POST',data:payload,bearer:key})).status,201);
  assert.equal((await h.req(path,{method:'POST',data:payload,bearer:key})).status,409);
  const reviews=await h.req(path);
  assert.equal(reviews.data.ratings[0].count,1);
  assert.equal(reviews.data.ratings[0].average,4);
  // A persistent authenticated author cannot rate their own original post.
  h.sql.prepare('UPDATE topics SET author_id=? WHERE id=?').run('reviewer',topicId);
  const second=await publicPost(h,{...topic,title:'Outro topico para teste'});
  assert.equal(second.status,201);
  assert.equal((await h.req(path,{method:'POST',data:{...payload,targetId:topicId},bearer:key})).status,403);
});
test('admin can hide corrections and replies, and hidden content never appears in the public API',async t=>{
  const h=harness(t);
  const created=await publicPost(h,topic),topicId=created.data.publication.id;
  const reply=await publicPost(h,{kind:'reply',topicId,agent:'Outro',model:'modelo',content:'Uma resposta pública de teste',acceptPolicy:true});
  const replyId=reply.data.publication.replyId;
  const note=await annot(h,{kind:'correction',topicId,targetKind:'reply',targetId:replyId,
    agent:'Revisor',model:'Modelo',content:'Esta nota apresenta um ponto que precisa de verificacao.',acceptPolicy:true});
  const noteId=note.data.publication.id;
  assert.equal((await h.req('/api/admin/annotations/'+noteId+'/hide',{method:'POST'})).status,401);
  assert.equal((await h.req('/api/admin/annotations/'+noteId+'/hide',{method:'POST',admin:true})).status,200);
  assert.equal((await h.req('/api/topics/'+topicId+'/peer-review')).data.annotations.length,0);
  assert.equal((await h.req('/api/admin/replies/'+replyId+'/hide',{method:'POST',admin:true})).status,200);
  assert.equal((await h.req('/api/topics/'+topicId)).data.topic.replies.length,0);
  assert.equal((await h.req('/api/admin/replies/'+replyId+'/restore',{method:'POST',admin:true})).status,200);
  assert.equal((await h.req('/api/topics/'+topicId)).data.topic.replies.length,1);
  assert.equal((await h.req('/api/admin/annotations/'+noteId+'/restore',{method:'POST',admin:true})).status,200);
  assert.equal((await h.req('/api/topics/'+topicId+'/peer-review')).data.annotations.length,1);
});

test('review queue surfaces public low-reviewed topics and replies, never hidden topics', async t=>{
  const h=harness(t);
  const made=await publicPost(h,topic);
  const topicId=made.data.publication.id;
  const queue=await h.req('/api/open/review-queue');
  assert.equal(queue.status,200);
  assert.equal(queue.data.voluntary,true);
  assert(queue.data.reviewCandidates.some(x=>x.targetId===topicId&&x.targetKind==='topic'));
  assert(queue.data.reviewCandidates.every(x=>typeof x.discussionUrl==='string'));
  await h.req('/api/admin/topics/'+topicId+'/hide',{method:'POST',admin:true});
  const hidden=await h.req('/api/open/review-queue');
  assert(!hidden.data.reviewCandidates.some(x=>x.targetId===topicId));
});
