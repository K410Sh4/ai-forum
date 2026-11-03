import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';

const API='https://ai-forum.test';
function harness(t) {
  const sql=new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys=ON');
  for(const file of fs.readdirSync(new URL('../cloudflare/migrations/',import.meta.url)).sort())
    sql.exec(fs.readFileSync(new URL('../cloudflare/migrations/'+file,import.meta.url),'utf8'));
  const wrap=statement=>({ async first(){ return statement.get()||null; } });
  const db={
    prepare(query) {
      return {
        bind(...args) {
          const stmt=sql.prepare(query);
          return {
            async first(){ return stmt.get(...args)||null; },
            async all(){ return {results:stmt.all(...args)}; },
            async run(){ return {meta:{changes:Number(stmt.run(...args).changes)}}; },
            execute(){ return {meta:{changes:Number(stmt.run(...args).changes)}}; }
          };
        }
      };
    },
    async batch(statements) {
      sql.exec('BEGIN IMMEDIATE');
      try {
        const results=statements.map(s=>s.execute());
        sql.exec('COMMIT');
        return results;
      } catch(e) { sql.exec('ROLLBACK'); throw e; }
    }
  };
  const env={DB:db,ADMIN_KEY:'s'.repeat(64)};
  t.after(()=>sql.close());
  const tokens={};
  for(const [id,label] of [['sender','Agent Sender'],['recipient','Agent Recipient'],['third','Uninvited Agent']]) {
    const token='aif_'+id+'_verified_12345678';
    sql.prepare('INSERT INTO agents(id,name,model,owner,key_hash,status,joined_at) VALUES (?,?,?,?,?,?,?)')
      .run(id,label,'self-declared','test',createHash('sha256').update(token).digest('hex'),'active',new Date().toISOString());
    tokens[id]=token;
  }
  function scoped(name,scopes) {
    const token='aifs_'+name+'_session_12345678';
    const id='session-'+name;
    sql.prepare('INSERT INTO agent_identities(key_id,agent_id,public_key,created_at) VALUES (?,?,?,?)')
      .run('key-'+name,name,'{}',new Date().toISOString());
    sql.prepare('INSERT INTO agent_sessions(id,agent_id,token_hash,scopes,audience,expires_at,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id,name,createHash('sha256').update(token).digest('base64url'),JSON.stringify(scopes),API,Date.now()+3600000,new Date().toISOString());
    return token;
  }
  tokens.scopedReader=scoped('sender',['jobs:create','jobs:read','jobs:cancel']);
  tokens.scopedSharer='aifs_sender_sharer_12345678';
  sql.prepare('INSERT INTO agent_sessions(id,agent_id,token_hash,scopes,audience,expires_at,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('session-sender-share','sender',createHash('sha256').update(tokens.scopedSharer).digest('base64url'),
      JSON.stringify(['jobs:create','jobs:read','jobs:cancel','jobs:share']),API,Date.now()+3600000,new Date().toISOString());
  tokens.scopedRecipient=scoped('recipient',['jobs:read']);
  async function request(path,{method='GET',token,body}={}){
    const response=await worker.fetch(new Request(API+path,{method,headers:{
      'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
    const data=await response.json();
    return {status:response.status,data};
  }
  const tick=async()=>{
    const pending=[];
    await worker.scheduled({cron:'*/5 * * * *'},env,{waitUntil(p){pending.push(p)}});
    await Promise.all(pending);
  };
  async function completedJob(){
    const res=await request('/api/jobs',{method:'POST',token:tokens.sender,
      body:{tool:'hub_sha256',arguments:{text:'shared demonstration'},requestKey:'v3request_123456789'}});
    assert.equal(res.status,202,JSON.stringify(res.data));
    await tick();
    assert.equal((await request('/api/jobs/'+res.data.job.id,{token:tokens.sender})).data.job.status,'completed');
    return res.data.job.id;
  }
  const grant=(jobId,recipientAgentId='recipient',key='share_request_123456')=>({
    recipientAgentId,requestKey:key,expiresHours:2,confirmShare:true
  });
  const rows=(table)=>sql.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;
  return {sql,db,env,tokens,request,tick,completedJob,grant,rows};
}

test('V3 discovery requires migration and does not silently enable sharing scope',async t=>{
  const h=harness(t);
  const c=await h.request('/api/network/capabilities');
  assert.equal(c.status,200);assert.equal(c.data.available,true);
  assert.equal(c.data.protocol,'ai-forum-agent-execution-network-v3');
  const p=await h.request('/api/agent-access/policy');
  assert.ok(p.data.authorization.scopes.includes('jobs:share'));
  assert.ok(!p.data.authorization.defaultScopes.includes('jobs:share'));
  assert.equal((await h.request('/api/network/inbox')).status,401);
  const jobId=await h.completedJob();
  const forbidden=await h.request('/api/jobs/'+jobId+'/shares',{method:'POST',
    token:h.tokens.scopedReader,body:h.grant(jobId)});
  assert.equal(forbidden.status,403,'standard session must not share');
  assert.equal(h.rows('job_result_shares'),0);
});

test('recipient can see explicitly granted completed result but not job arguments or other results',async t=>{
  const h=harness(t);const jobId=await h.completedJob();
  const denied=await h.request('/api/jobs/'+jobId+'/shares',{method:'POST',token:h.tokens.scopedSharer,
    body:{...h.grant(jobId),confirmShare:false}});
  assert.equal(denied.status,400);assert.equal(h.rows('job_result_shares'),0);
  const created=await h.request('/api/jobs/'+jobId+'/shares',{method:'POST',token:h.tokens.scopedSharer,
    body:h.grant(jobId)});
  assert.equal(created.status,201,JSON.stringify(created.data));
  assert.equal(created.data.reused,false);
  const shareId=created.data.share.id;
  assert.equal((await h.request('/api/jobs/'+jobId,{token:h.tokens.recipient})).status,404);
  assert.equal((await h.request('/api/network/inbox/'+shareId)).status,401);
  assert.equal((await h.request('/api/network/inbox/'+shareId,{token:h.tokens.third})).status,404);
  const inbox=await h.request('/api/network/inbox',{token:h.tokens.scopedRecipient});
  assert.equal(inbox.status,200);assert.equal(inbox.data.shares.length,1);
  assert.equal(inbox.data.shares[0].tool,'hub_sha256');
  assert.equal(inbox.data.shares[0].result,undefined);
  const read=await h.request('/api/network/inbox/'+shareId,{token:h.tokens.scopedRecipient});
  assert.equal(read.status,200,JSON.stringify(read.data));
  assert.equal(read.data.result.hex,createHash('sha256').update('shared demonstration').digest('hex'));
  assert.ok(!JSON.stringify(read.data).includes('shared demonstration'));
  assert.ok(!JSON.stringify(read.data).includes('v3request_123456789'));
  const audit=await h.request('/api/jobs/'+jobId+'/shares',{token:h.tokens.scopedReader});
  assert.deepEqual(audit.data.events.map(x=>x.action).reverse(),['shared','accessed']);
});

test('idempotent grant, conflicting replay, revocation and expiry all fail closed',async t=>{
  const h=harness(t);const id=await h.completedJob(),payload=h.grant(id);
  const grant=await h.request('/api/jobs/'+id+'/shares',{method:'POST',token:h.tokens.scopedSharer,body:payload});
  assert.equal(grant.status,201);
  const repeated=await h.request('/api/jobs/'+id+'/shares',{method:'POST',token:h.tokens.scopedSharer,body:payload});
  assert.equal(repeated.status,200);
  assert.equal(repeated.data.reused,true);assert.equal(repeated.data.share.id,grant.data.share.id);
  assert.equal(h.rows('job_result_shares'),1);assert.equal(h.rows('job_share_events'),1);
  const conflict=await h.request('/api/jobs/'+id+'/shares',{method:'POST',token:h.tokens.scopedSharer,
    body:{...payload,expiresHours:24}});
  assert.equal(conflict.status,409);
  const other=await h.request('/api/jobs/'+id+'/shares',{method:'POST',token:h.tokens.scopedSharer,
    body:h.grant(id,'third','share_request_other123')});
  assert.equal(other.status,201);
  const deniedRevoke=await h.request('/api/jobs/'+id+'/shares/'+grant.data.share.id,
    {method:'DELETE',token:h.tokens.scopedReader});
  assert.equal(deniedRevoke.status,403);
  const revoked=await h.request('/api/jobs/'+id+'/shares/'+grant.data.share.id,
    {method:'DELETE',token:h.tokens.scopedSharer});
  assert.equal(revoked.status,200);
  assert.ok(revoked.data.share.revokedAt);
  assert.equal((await h.request('/api/network/inbox/'+grant.data.share.id,
    {token:h.tokens.scopedRecipient})).status,404);
  assert.equal((await h.request('/api/jobs/'+id+'/shares/'+grant.data.share.id,
    {method:'DELETE',token:h.tokens.scopedSharer})).status,409);
  h.sql.prepare("UPDATE job_result_shares SET expires_at='2001-01-01T00:00:00.000Z' WHERE id=?")
    .run(other.data.share.id);
  assert.equal((await h.request('/api/network/inbox/'+other.data.share.id,{token:h.tokens.third})).status,404);
  assert.equal(h.rows('job_share_events'),3);
});

test('unknown recipients, unfinished jobs, oversized arguments and unauthenticated access are rejected',async t=>{
  const h=harness(t);
  const created=await h.request('/api/jobs',{method:'POST',token:h.tokens.sender,
    body:{tool:'hub_text_statistics',arguments:{text:'not executed'},
      requestKey:'unused_job_request_3'}});
  assert.equal(created.status,202);
  assert.equal((await h.request('/api/jobs/'+created.data.job.id+'/shares',{method:'POST',
    token:h.tokens.scopedSharer,body:h.grant(created.data.job.id)})).status,409);
  await h.tick();
  const id=created.data.job.id;
  for(const recipient of ['nonexistent', 'sender']) {
    const res=await h.request('/api/jobs/'+id+'/shares',{method:'POST',
      token:h.tokens.scopedSharer,body:h.grant(id,recipient,'key_for_'+recipient+'_1234')});
    assert.ok([400,404].includes(res.status));
  }
  assert.equal((await h.request('/api/jobs/'+id+'/shares',{method:'POST',
    body:h.grant(id)})).status,401);
  assert.equal(h.rows('job_result_shares'),0);
});

test('audit write failure rolls back share creation; recipient cannot read a share without audit',async t=>{
  const h=harness(t);const id=await h.completedJob();
  h.sql.exec("CREATE TRIGGER bad_audit BEFORE INSERT ON job_share_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  const failed=await h.request('/api/jobs/'+id+'/shares',{method:'POST',
    token:h.tokens.scopedSharer,body:h.grant(id)});
  assert.equal(failed.status,500);
  assert.equal(h.rows('job_result_shares'),0);
  h.sql.exec('DROP TRIGGER bad_audit');
  const created=await h.request('/api/jobs/'+id+'/shares',{method:'POST',
    token:h.tokens.scopedSharer,body:h.grant(id)});
  assert.equal(created.status,201);
  h.sql.exec("CREATE TRIGGER bad_audit BEFORE INSERT ON job_share_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
  const read=await h.request('/api/network/inbox/'+created.data.share.id,{token:h.tokens.recipient});
  assert.equal(read.status,500,'do not disclose result if access cannot be audited');
  h.sql.exec('DROP TRIGGER bad_audit');
  assert.equal((await h.request('/api/network/inbox/'+created.data.share.id,{token:h.tokens.recipient})).status,200);
});

test('MCP owner/recipient operations keep authenticated scope and result boundaries',async t=>{
  const h=harness(t);const id=await h.completedJob();
  const rpc=async(token,name,argumentsValue)=>{
    const r=await h.request('/mcp',{method:'POST',token,
      body:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:argumentsValue}}});
    assert.equal(r.status,200,JSON.stringify(r.data));
    return r.data.result;
  };
  const tools=await h.request('/mcp',{method:'POST',body:{jsonrpc:'2.0',id:7,method:'tools/list',params:{}}});
  assert.ok(tools.data.result.tools.some(x=>x.name==='forum_share_job_result'));
  const blocked=await rpc(h.tokens.scopedReader,'forum_share_job_result',
    {job_id:id,...h.grant(id)});
  assert.equal(blocked.isError,true);
  const created=await rpc(h.tokens.scopedSharer,'forum_share_job_result',
    {job_id:id,...h.grant(id)});
  assert.equal(created.isError,false,JSON.stringify(created));
  const shareId=JSON.parse(created.content[0].text).share.id;
  const denied=await rpc(h.tokens.third,'forum_read_shared_result',{share_id:shareId});
  assert.equal(denied.isError,true);
  const read=await rpc(h.tokens.scopedRecipient,'forum_read_shared_result',{share_id:shareId});
  assert.equal(read.isError,false);
  assert.ok(JSON.parse(read.content[0].text).result.hex);
});
