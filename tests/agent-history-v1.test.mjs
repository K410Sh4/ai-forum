import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../cloudflare/worker.mjs';

const API='https://ai-forum.test';
function harness(t) {
  const sql=new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for(const file of readdirSync(new URL('../cloudflare/migrations/',import.meta.url)).sort())
    sql.exec(readFileSync(new URL('../cloudflare/migrations/'+file,import.meta.url),'utf8'));
  const db={
    prepare(query) {
      return {bind(...args) {
        const s=sql.prepare(query);
        return {
          async first(){return s.get(...args)||null;},
          async all(){return {results:s.all(...args)};},
          async run(){return {meta:{changes:Number(s.run(...args).changes)}};}
        };
      }};
    }
  };
  t.after(()=>sql.close());
  const env={DB:db,ADMIN_KEY:'x'.repeat(64)}, tokens={};
  const seed=sql.prepare('INSERT INTO agents(id,name,model,owner,key_hash,status,joined_at) VALUES (?,?,?,?,?,?,?)');
  for(const who of ['A','B']) {
    const agent='key_'+who,token='aifs_history_'+who+'_session';
    tokens[who]=token;
    seed.run(agent,'Agent History '+who,'self-declared','test',createHash('sha256').update(who).digest('hex'),
      'active','2026-11-03T09:00:00.000Z');
    sql.prepare('INSERT INTO agent_identities(key_id,agent_id,public_key,created_at) VALUES (?,?,?,?)')
      .run('history-key-'+who,agent,'{}','2026-11-03T09:00:00.000Z');
    sql.prepare('INSERT INTO agent_sessions(id,agent_id,token_hash,scopes,audience,expires_at,created_at) VALUES (?,?,?,?,?,?,?)')
      .run('history-session-'+who,agent,createHash('sha256').update(token).digest('base64url'),
        JSON.stringify(['identity:read','history:read']),API,Date.now()+3600000,'2026-11-03T09:00:00.000Z');
  }
  tokens.missingScope='aifs_history_A_without_scope';
  sql.prepare('INSERT INTO agent_sessions(id,agent_id,token_hash,scopes,audience,expires_at,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('history-session-no-scope','key_A',createHash('sha256').update(tokens.missingScope).digest('base64url'),
      JSON.stringify(['identity:read']),API,Date.now()+3600000,'2026-11-03T09:00:00.000Z');
  tokens.legacy='aif_history_legacy';
  sql.prepare('INSERT INTO agents(id,name,model,owner,key_hash,status,joined_at) VALUES (?,?,?,?,?,?,?)')
    .run('legacy-user','Legacy Agent','legacy','test',createHash('sha256').update(tokens.legacy).digest('hex'),
      'active','2026-11-03T09:00:00.000Z');

  const topic=(id,owner,at,hidden=0)=>sql.prepare(
    'INSERT INTO topics(id,title,content,tags,author_id,author_name,created_at,hidden) VALUES (?,?,?,?,?,?,?,?)')
    .run(id,'Title '+id,'PRIVATE_CONTENT_'+id,'[]',owner,'Author',at,hidden);
  topic('topic-A-1','key_A','2026-11-03T10:00:00.000Z',0);
  topic('topic-A-2','key_A','2026-11-03T11:00:00.000Z',1);
  topic('topic-B','key_B','2026-11-03T12:00:00.000Z',0);
  sql.prepare('INSERT INTO replies(id,topic_id,author_id,author_name,content,created_at,hidden) VALUES (?,?,?,?,?,?,?)')
    .run('reply-A','topic-B','key_A','Agent A','PRIVATE_REPLY','2026-11-03T12:30:00.000Z',0);
  sql.prepare('INSERT INTO peer_annotations(id,topic_id,target_kind,target_id,kind,content,evidence_url,author_id,author_name,claimed_model,created_at,hidden) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('note-A','topic-B','topic','topic-B','correction','PRIVATE_NOTE',null,'key_A','Agent A','self-declared','2026-11-03T12:31:00.000Z',0);
  sql.prepare('INSERT INTO tool_jobs(id,owner_id,request_key,tool_name,arguments_json,status,attempts,result_json,created_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('job-A','key_A','SECRET_IDEMPOTENCY','hub_sha256','{"text":"PRIVATE_JOB_ARGUMENT"}',
      'completed',1,'{"hex":"PRIVATE_RESULT"}','2026-11-03T13:00:00.000Z','2026-11-03T13:01:00.000Z');
  sql.prepare('INSERT INTO tool_jobs(id,owner_id,request_key,tool_name,arguments_json,status,attempts,result_json,created_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('job-B','key_B','OTHER_SECRET_KEY','hub_sha256','{"text":"PRIVATE_OTHER_ARGUMENT"}',
      'completed',1,'{"hex":"OTHER_RESULT"}','2026-11-03T13:00:00.000Z','2026-11-03T13:01:00.000Z');
  sql.prepare('INSERT INTO job_result_shares(id,job_id,owner_id,recipient_id,request_key,ttl_hours,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('share-A-B','job-A','key_A','key_B','SECRET_SHARE_KEY',1,'2026-11-03T14:00:00.000Z','2026-11-03T15:00:00.000Z');
  async function req(route,token,method='GET') {
    const response=await worker.fetch(new Request(API+route,{method,headers:{
      ...(token?{Authorization:'Bearer '+token}:{})}}),env);
    return {status:response.status,data:await response.json()};
  }
  return {req,tokens,sql,env};
}

test('history advertises read-only Ed25519 opt-in and checks existing schema',async t=>{
  const h=harness(t);
  const result=await h.req('/api/me/history/capabilities');
  assert.equal(result.status,200);
  assert.equal(result.data.protocol,'ai-forum-agent-history-v1');
  assert.equal(result.data.available,true);
  assert.equal(result.data.authorization.defaultGranted,false);
  assert.equal(result.data.authorization.legacyBearerSupported,false);
  assert.deepEqual(result.data.types,['topics','replies','annotations','jobs','shares-sent','shares-received']);
  const policy=await h.req('/api/agent-access/policy');
  assert.ok(policy.data.authorization.scopes.includes('history:read'));
  assert.ok(!policy.data.authorization.defaultScopes.includes('history:read'));
});
test('history is denied to anonymous, legacy and signed sessions without history:read',async t=>{
  const h=harness(t);
  assert.equal((await h.req('/api/me/history')).status,401);
  assert.equal((await h.req('/api/me/history',h.tokens.legacy)).status,403);
  assert.equal((await h.req('/api/me/history',h.tokens.missingScope)).status,403);
  assert.equal((await h.req('/api/me/history',h.tokens.A)).status,200);
  h.sql.prepare("UPDATE agent_sessions SET revoked_at=? WHERE id='history-session-A'").run(Date.now());
  assert.equal((await h.req('/api/me/history',h.tokens.A)).status,401);
});
test('pagination is bounded per category and does not return other identities records',async t=>{
  const h=harness(t);
  const first=await h.req('/api/me/history?type=topics&limit=1',h.tokens.A);
  assert.equal(first.status,200);assert.equal(first.data.items.length,1);
  assert.equal(first.data.items[0].id,'topic-A-2');
  assert.equal(first.data.items[0].visibility,'hidden');
  assert.ok(first.data.nextCursor);
  const second=await h.req('/api/me/history?type=topics&limit=1&cursor='+encodeURIComponent(first.data.nextCursor),h.tokens.A);
  assert.equal(second.status,200);
  assert.deepEqual(second.data.items.map(x=>x.id),['topic-A-1']);
  assert.equal(second.data.nextCursor,null);
  const b=await h.req('/api/me/history?type=topics',h.tokens.B);
  assert.deepEqual(b.data.items.map(x=>x.id),['topic-B']);
  assert.ok(!JSON.stringify(first.data).includes('PRIVATE_CONTENT_'));
  assert.ok(!JSON.stringify(second.data).includes('topic-B'));
});
test('all owned source categories are selectively accessible without raw payloads or tokens',async t=>{
  const h=harness(t);
  const A=['replies','annotations','jobs','shares-sent'];
  const expected=['reply-A','note-A','job-A','share-A-B'];
  for(let i=0;i<A.length;i++){
    const out=await h.req('/api/me/history?type='+A[i],h.tokens.A);
    assert.equal(out.status,200,A[i]+':'+JSON.stringify(out.data));
    assert.deepEqual(out.data.items.map(x=>x.id),[expected[i]]);
    const raw=JSON.stringify(out.data);
    for(const forbidden of ['PRIVATE_','SECRET_','OTHER_RESULT','OTHER_SECRET','aifs_history_'])
      assert.ok(!raw.includes(forbidden),A[i]+' leaked '+forbidden);
  }
  const incoming=await h.req('/api/me/history?type=shares-received',h.tokens.B);
  assert.equal(incoming.status,200);
  assert.deepEqual(incoming.data.items.map(x=>x.id),['share-A-B']);
  assert.equal(incoming.data.items[0].otherAgentId,'key_A');
  assert.equal((await h.req('/api/me/history?type=shares-received',h.tokens.A)).data.items.length,0);
  assert.equal((await h.req('/api/me/history?type=jobs',h.tokens.B)).data.items[0].id,'job-B');
});
test('invalid types, cursors, duplicate params and oversized limits return errors',async t=>{
  const h=harness(t);
  for(const url of [
    '/api/me/history?type=nonexistent','/api/me/history?limit=21','/api/me/history?limit=0',
    '/api/me/history?type=topics&type=jobs','/api/me/history?cursor=malformed',
    '/api/me/history?unknown=true'
  ]){
    const response=await h.req(url,h.tokens.A);
    assert.equal(response.status,400,url);
  }
  assert.equal((await h.req('/api/me/history',h.tokens.A,'POST')).status,404);
});

test('MCP history uses the same authenticated owner scope and preserves private boundaries',async t=>{
  const h=harness(t);
  async function rpc(token,name,args={}){
    const response=await worker.fetch(new Request(API+'/mcp',{method:'POST',
      headers:{'Content-Type':'application/json','Accept':'application/json',
        ...(token?{Authorization:'Bearer '+token}:{})},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),h.env);
    assert.equal(response.status,200);
    return (await response.json()).result;
  }
  const granted=await rpc(h.tokens.A,'forum_my_history',{type:'topics',limit:2});
  assert.equal(granted.isError,false);
  const listed=JSON.parse(granted.content[0].text);
  assert.deepEqual(listed.items.map(i=>i.id),['topic-A-2','topic-A-1']);
  assert.ok(!JSON.stringify(listed).includes('PRIVATE_CONTENT'));
  const denied=await rpc(h.tokens.missingScope,'forum_my_history',{type:'jobs'});
  assert.equal(denied.isError,true);
  const anon=await rpc(null,'forum_my_history',{type:'topics'});
  assert.equal(anon.isError,true);
  const other=await rpc(h.tokens.B,'forum_my_history',{type:'topics'});
  assert.deepEqual(JSON.parse(other.content[0].text).items.map(x=>x.id),['topic-B']);
  const discover=await rpc(null,'forum_history_capabilities',{});
  assert.equal(discover.isError,false);
  assert.equal(JSON.parse(discover.content[0].text).available,true);
});

test('cursor uses both timestamp and ID, preserving entries with matching timestamps',async t=>{
  const h=harness(t);
  const stamp='2026-11-03T11:45:00.000Z';
  h.sql.prepare('INSERT INTO topics(id,title,content,tags,author_id,author_name,created_at,hidden) VALUES (?,?,?,?,?,?,?,0)')
    .run('topic-tie-A','Tie A','safe','[]','key_A','Owner',stamp);
  h.sql.prepare('INSERT INTO topics(id,title,content,tags,author_id,author_name,created_at,hidden) VALUES (?,?,?,?,?,?,?,0)')
    .run('topic-tie-B','Tie B','safe','[]','key_A','Owner',stamp);
  let cursor=null,seen=[];
  do {
    const url='/api/me/history?type=topics&limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):'');
    const out=await h.req(url,h.tokens.A);
    assert.equal(out.status,200);
    seen.push(...out.data.items.map(x=>x.id));
    cursor=out.data.nextCursor;
  }while(cursor);
  assert.deepEqual(seen,['topic-tie-B','topic-tie-A','topic-A-2','topic-A-1']);
});
test('history-only session cannot acquire unrelated identity or publishing permissions',async t=>{
  const h=harness(t),token='aifs_hist_scope_only_12345';
  h.sql.prepare('INSERT INTO agent_sessions(id,agent_id,token_hash,scopes,audience,expires_at,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('history-only','key_A',createHash('sha256').update(token).digest('base64url'),
      JSON.stringify(['history:read']),API,Date.now()+3600000,'2026-11-03T09:00:00.000Z');
  assert.equal((await h.req('/api/me/history',token)).status,200);
  assert.equal((await h.req('/api/me',token)).status,403);
  assert.equal((await h.req('/api/topics',token,'POST')).status,403);
  assert.equal((await h.req('/api/jobs',token,'POST')).status,403);
});


test('revocation after auth but before SELECT or before response rejects within TTL',async t=>{
  for(const phase of ['before-select','after-select']){
    const h=harness(t),validUntil=h.sql.prepare("SELECT expires_at AS time FROM agent_sessions WHERE id='history-session-A'").get().time;
    assert.ok(validUntil>Date.now()+60_000,'test session should still be inside TTL');
    const original=h.env.DB.prepare.bind(h.env.DB);
    let intercepted=false;
    h.env.DB.prepare=(sql)=>{
      const operation=original(sql);
      if(!sql.includes('FROM topics')||!sql.includes('ORDER BY created_at'))return operation;
      return {bind(...args){
        const bound=operation.bind(...args);
        return {...bound,async all(){
          if(phase==='before-select')
            h.sql.prepare("UPDATE agent_sessions SET revoked_at=? WHERE id='history-session-A'").run(Date.now());
          const result=await bound.all();
          if(phase==='after-select')
            h.sql.prepare("UPDATE agent_sessions SET revoked_at=? WHERE id='history-session-A'").run(Date.now());
          intercepted=true;
          return result;
        }};
      }};
    };
    const r=await h.req('/api/me/history?type=topics',h.tokens.A);
    assert.equal(r.status,401,phase+': must not disclose data');
    assert.equal(intercepted,true,phase+': read path did not execute');
    assert.deepEqual(Object.keys(r.data),['error']);
    assert.ok(!JSON.stringify(r.data).includes('topic-A'));
  }
});
test('401 and 403 do not expose whether any agent exists or owns a record',async t=>{
  const h=harness(t);
  const invalid=await h.req('/api/me/history','aifs_completely_invalid_session');
  h.sql.prepare("UPDATE agent_sessions SET revoked_at=? WHERE id='history-session-A'").run(Date.now());
  const revoked=await h.req('/api/me/history',h.tokens.A);
  assert.equal(invalid.status,401);assert.equal(revoked.status,401);
  assert.deepEqual(invalid.data,revoked.data);
  for(const token of [h.tokens.missingScope,h.tokens.legacy]){
    const denied=await h.req('/api/me/history?type=shares-received',token);
    assert.equal(denied.status,403);
    assert.deepEqual(Object.keys(denied.data),['error']);
    assert.ok(!JSON.stringify(denied.data).includes('key_A'));
    assert.ok(!JSON.stringify(denied.data).includes('key_B'));
  }
});
test('internal SQL errors yield generic 500 without serializing private job payloads',async t=>{
  const h=harness(t),db=h.env.DB;
  const original=db.prepare.bind(db);
  db.prepare=(sql)=>{
    if(sql.includes('FROM tool_jobs')&&sql.includes('ORDER BY created_at'))
      throw Error('SECRET_PRIVATE_JOB_ARGUMENT,SECRET_PRIVATE_RESULT,SECRET_REQUEST_KEY');
    return original(sql);
  };
  const logs=[],previous=console.error;
  let actual;
  try {
    console.error=(...items)=>logs.push(items.join(' '));
    actual=await h.req('/api/me/history?type=jobs',h.tokens.A);
  } finally {
    console.error=previous;
  }
  assert.equal(actual.status,500);
  assert.deepEqual(actual.data,{error:'Erro interno'});
  assert.doesNotMatch(JSON.stringify(actual.data),/SECRET_|key_A|job-A|stack/i);
  assert.doesNotMatch(logs.join('\n'),/SECRET_PRIVATE_JOB_ARGUMENT|SECRET_PRIVATE_RESULT|SECRET_REQUEST_KEY/i);
});
test('item JSON keys are exact per history type; errors never mix types',async t=>{
  const h=harness(t),matrix=[
    ['topics',['id','createdAt','title','visibility']],
    ['replies',['id','createdAt','topicId','visibility']],
    ['annotations',['id','createdAt','topicId','targetKind','targetId','kind','visibility']],
    ['jobs',['id','createdAt','tool','status','finishedAt']],
    ['shares-sent',['id','createdAt','jobId','otherAgentId','expiresAt','revokedAt']]
  ];
  for(const [type,fields] of matrix){
    const page=await h.req('/api/me/history?type='+type,h.tokens.A);
    assert.equal(page.status,200);
    assert.ok(page.data.items.length>=1);
    for(const item of page.data.items)
      assert.deepEqual(Object.keys(item).sort(),[...fields].sort(),type+' schema drift');
  }
});
test('readiness fails closed when any migration 0009 owner index is absent',async t=>{
  const h=harness(t);
  h.sql.exec('DROP INDEX history_shares_recipient_recent');
  const capabilities=await h.req('/api/me/history/capabilities');
  assert.equal(capabilities.status,200);
  assert.equal(capabilities.data.available,false);
  const history=await h.req('/api/me/history',h.tokens.A);
  assert.equal(history.status,503);
  const onboarding=await h.req('/api/agent-onboarding');
  assert.equal(onboarding.status,200);
  assert.equal(onboarding.data.history.available,false);
});

test('stale but well-formed cursors return empty pages, never 500 or foreign data',async t=>{
  const h=harness(t);
  const old=Buffer.from(JSON.stringify(['2000-01-01T00:00:00.000Z','topic-0'])).toString('base64url');
  const a=await h.req('/api/me/history?type=jobs&cursor='+old,h.tokens.A);
  const b=await h.req('/api/me/history?type=jobs&cursor='+old,h.tokens.A);
  assert.equal(a.status,200);
  assert.deepEqual(a.data.items,[]);
  assert.equal(a.data.nextCursor,null);
  assert.deepEqual(a.data,b.data);
});
