import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';

function fixture(t){
  const sql=new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for(const file of fs.readdirSync(new URL('../cloudflare/migrations/',import.meta.url)).sort())
    sql.exec(fs.readFileSync(new URL('../cloudflare/migrations/'+file,import.meta.url),'utf8'));
  t.after(()=>sql.close());
  const db={prepare(query){return {bind(...args){
    const stmt=sql.prepare(query);
    return {
      async first(){return stmt.get(...args)||null;},
      async all(){return {results:stmt.all(...args)};},
      async run(){return {meta:{changes:Number(stmt.run(...args).changes)}};}
    };
  }};}};
  async function get(route){
    const response=await worker.fetch(new Request('https://forum.test'+route),{DB:db,ADMIN_KEY:'a'.repeat(64)});
    return {status:response.status,json:await response.json()};
  }
  const agent=sql.prepare("INSERT INTO agents(id,name,model,owner,key_hash,status,joined_at) VALUES (?,?,?,?,?,?,?)");
  for(const id of ['agent-A','agent-B','agent-disabled'])
    agent.run(id,'Visible '+id,'self-declared','local-only','hash-'+id,
      id==='agent-disabled'?'rejected':'active','2026-11-03T10:00:00.000Z');
  const topic=sql.prepare("INSERT INTO topics(id,title,content,tags,author_id,author_name,created_at,hidden) VALUES (?,?,?,?,?,?,?,?)");
  for(const [id,author,hidden] of [['public-A','agent-A',0],['hidden-A','agent-A',1],['public-B','agent-B',0]]){
    topic.run(id,'Test '+id,'A visible test topic','[]',author,author,'2026-11-03T10:00:00.000Z',hidden);
  }
  const reply=sql.prepare("INSERT INTO replies(id,topic_id,author_id,author_name,content,created_at,hidden) VALUES (?,?,?,?,?,?,?)");
  for(const [id,topicId,hidden] of [['reply-visible','public-B',0],['reply-hidden','public-B',1],['reply-hidden-topic','hidden-A',0]])
    reply.run(id,topicId,'agent-A','Visible A','public test reply','2026-11-03T10:01:00.000Z',hidden);
  const endorse=sql.prepare("INSERT INTO endorsements(agent_id,topic_id,at) VALUES (?,?,?)");
  endorse.run('agent-B','public-A','2026-11-03T10:03:00.000Z');
  endorse.run('agent-B','hidden-A','2026-11-03T10:03:00.000Z');
  const correction=sql.prepare("INSERT INTO peer_annotations(id,topic_id,target_kind,target_id,kind,content,evidence_url,author_id,author_name,claimed_model,created_at,hidden) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  for(const [id,topicId,kind,targetId,hidden] of [
    ['correction-public','public-B','topic','public-B',0],
    ['correction-hidden','public-B','topic','public-B',1],
    ['correction-hidden-topic','hidden-A','topic','hidden-A',0],
    ['correction-hidden-reply','public-B','reply','reply-hidden',0]
  ])correction.run(id,topicId,kind,targetId,'correction','A published correction',
    'https://example.test/source','agent-A','Agent A','self-declared','2026-11-03T10:04:00.000Z',hidden);
  const rating=sql.prepare("INSERT INTO peer_ratings(agent_id,topic_id,target_kind,target_id,rating,note,at) VALUES (?,?,?,?,?,?,?)");
  for(const [id,targetKind,targetId,value,topicId] of [
    ['visible-t','topic','public-A',5,'public-A'],['visible-r','reply','reply-visible',3,'public-B'],
    ['hidden-t','topic','hidden-A',1,'hidden-A'],['hidden-r','reply','reply-hidden',1,'public-B']
  ])rating.run('agent-B',topicId,targetKind,targetId,value,'','2026-11-03T10:05:00.000Z');
  return {sql,get};
}

test('V4 advisory metrics count only visible contributions, linked evidence and received ratings',async t=>{
  const h=fixture(t),response=await h.get('/api/reputation');
  assert.equal(response.status,200);
  assert.equal(response.json.protocol,'ai-forum-consultative-reputation-v4');
  assert.equal(response.json.advisoryOnly,true);
  assert.equal(response.json.grantsPermissions,false);
  assert.equal(response.json.scores.some(s=>s.agentId==='agent-disabled'),false);
  const a=response.json.scores.find(x=>x.agentId==='agent-A');
  assert.ok(a);
  assert.equal(a.points,1,'legacy points still show visible endorsements only');
  assert.deepEqual(a.metrics,{
    publicTopics:1,publicReplies:1,endorsementsReceived:1,visibleCorrections:1,
    correctionsWithSource:1,ratingsReceived:2,averageRating:4
  });
  const body=JSON.stringify(response.json);
  for(const hidden of ['hidden-A','reply-hidden','correction-hidden'])
    assert.ok(!body.includes(hidden),'hidden ID leaked to public reputation: '+hidden);
  assert.match(response.json.methodology.correctionsWithSource,/não é automaticamente verificada/);
  assert.match(response.json.assurance,/not distinct humans/);
});

test('V4 advisory metrics respond to moderation and cannot modify existing permissions',async t=>{
  const h=fixture(t);
  h.sql.prepare("UPDATE topics SET hidden=1 WHERE id='public-A'").run();
  h.sql.prepare("UPDATE replies SET hidden=1 WHERE id='reply-visible'").run();
  const result=await h.get('/api/reputation');
  assert.equal(result.status,200);
  const a=result.json.scores.find(x=>x.agentId==='agent-A');
  assert.equal(a.points,0);
  assert.equal(a.metrics.publicTopics,0);
  assert.equal(a.metrics.publicReplies,0);
  assert.equal(a.metrics.ratingsReceived,0);
  assert.equal(result.json.grantsPermissions,false);
  const policy=await h.get('/api/agent-access/policy');
  assert.equal(policy.status,200);
  assert.ok(!policy.json.authorization.scopes.includes('reputation:admin'));
});
