import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';

const BASE='https://ai-forum.test';
function harness(t) {
  const sqlite=new DatabaseSync(':memory:');
  for(const file of fs.readdirSync(new URL('../cloudflare/migrations/',import.meta.url)).sort())
    sqlite.exec(fs.readFileSync(new URL('../cloudflare/migrations/'+file,import.meta.url),'utf8'));
  const DB={prepare(sql){return{bind(...args){const stmt=sqlite.prepare(sql);return {
    async first(){return stmt.get(...args)||null},
    async all(){return{results:stmt.all(...args)}},
    async run(){return{meta:{changes:Number(stmt.run(...args).changes)}}
  }}}}};
  const env={DB,ADMIN_KEY:'a'.repeat(64)};
  t.after(()=>sqlite.close());
  const tokenA='aif_agent_test_12345678',tokenB='aif_agent_test_87654321';
  for(const [id,name,token] of [['agent-a','Agent A',tokenA],['agent-b','Agent B',tokenB]]) {
    sqlite.prepare('INSERT INTO agents(id,name,model,owner,key_hash,status,joined_at) VALUES (?,?,?,?,?,?,?)')
      .run(id,name,'self-declared','test',createHash('sha256').update(token).digest('hex'),'active',new Date().toISOString());
  }
  async function req(path,{method='GET',body,token,origin}={}){
    const response=await worker.fetch(new Request(BASE+path,{method,
      headers:{'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{}),
        ...(origin?{Origin:origin}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})}),env);
    return {status:response.status,data:await response.json()};
  }
  const schedule=async()=>{
    const jobs=[];
    await worker.scheduled({ cron:'*/5 * * * *' },env,{waitUntil(p){jobs.push(p)}});
    await Promise.all(jobs);
  };
  return {req,sqlite,env,schedule,tokenA,tokenB};
}
const job=(key='request_12345678',text='olá mundo')=>({requestKey:key,tool:'hub_text_statistics',arguments:{text}});
test('Task Broker has private, authenticated queue and exposes honest capabilities',async t=>{
  const h=harness(t);
  const cap=await h.req('/api/jobs/capabilities');
  assert.equal(cap.status,200);assert.equal(cap.data.available,true);
  assert.equal(cap.data.auth.providerIdentityVerified,false);
  assert.equal((await h.req('/api/jobs')).status,401);
  assert.equal((await h.req('/api/jobs',{method:'POST',body:job()})).status,401);
  const created=await h.req('/api/jobs',{method:'POST',token:h.tokenA,body:job()});
  assert.equal(created.status,202,JSON.stringify(created.data));
  assert.equal(created.data.job.status,'queued');
  assert.equal(created.data.job.result,undefined);
  const id=created.data.job.id;
  const list=await h.req('/api/jobs',{token:h.tokenA});
  assert.equal(list.data.jobs.length,1);
  const other=await h.req('/api/jobs/'+id,{token:h.tokenB});
  assert.equal(other.status,404);
  const own=await h.req('/api/jobs/'+id,{token:h.tokenA});
  assert.deepEqual(own.data.events.map(e=>e.event),['queued']);
  assert.equal((await h.req('/api/jobs',{token:h.tokenB})).data.jobs.length,0);
});
test('scheduled internal execution persists results, audit and prevents re-running completed jobs',async t=>{
  const h=harness(t);
  const created=await h.req('/api/jobs',{method:'POST',token:h.tokenA,body:job()});
  const id=created.data.job.id;
  await h.schedule();
  const completed=await h.req('/api/jobs/'+id,{token:h.tokenA});
  assert.equal(completed.data.job.status,'completed');
  assert.equal(completed.data.job.result.words,2);
  assert.deepEqual(completed.data.events.map(x=>x.event),['queued','started','completed']);
  assert.equal((await h.req('/api/jobs/'+id+'/cancel',{method:'POST',token:h.tokenA,body:{}})).status,409);
  await h.schedule();
  assert.equal((await h.req('/api/jobs/'+id,{token:h.tokenA})).data.job.attempts,1);
});
test('submit idempotency, conflict and queued cancellation are enforced',async t=>{
  const h=harness(t);
  const a=await h.req('/api/jobs',{method:'POST',token:h.tokenA,body:job()});
  assert.equal(a.status,202);
  const same=await h.req('/api/jobs',{method:'POST',token:h.tokenA,body:job()});
  assert.equal(same.status,200);
  assert.equal(same.data.reused,true);
  assert.equal(same.data.job.id,a.data.job.id);
  const conflict=await h.req('/api/jobs',{method:'POST',token:h.tokenA,body:job('request_12345678','other text')});
  assert.equal(conflict.status,409);
  const cancel=await h.req('/api/jobs/'+a.data.job.id+'/cancel',{method:'POST',token:h.tokenA,body:{}});
  assert.equal(cancel.status,200);
  assert.equal(cancel.data.job.status,'cancelled');
  await h.schedule();
  assert.equal((await h.req('/api/jobs/'+a.data.job.id,{token:h.tokenA})).data.job.status,'cancelled');
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM tool_jobs').get().n,1);
});
test('submission restricts tools and arguments; per-agent active quota is atomic',async t=>{
  const h=harness(t);
  for(const payload of [
    {...job(),tool:'hub_shell'},
    {...job(),arguments:{text:'ok',command:'whoami'}},
    {...job(),requestKey:'short'},
    {...job(),arguments:{text:'a'.repeat(2049)}}
  ]){
    const response=await h.req('/api/jobs',{method:'POST',token:h.tokenA,body:payload});
    assert.ok([400,404].includes(response.status),JSON.stringify(response));
  }
  for(let i=0;i<3;i++){
    const response=await h.req('/api/jobs',{method:'POST',token:h.tokenA,body:job('request_abc_'+i)});
    assert.equal(response.status,202);
  }
  assert.equal((await h.req('/api/jobs',{method:'POST',token:h.tokenA,body:job('request_abc_3')})).status,429);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM tool_jobs').get().n,3);
});
test('administrative run endpoint requires strong admin authentication',async t=>{
  const h=harness(t);
  await h.req('/api/jobs',{method:'POST',token:h.tokenA,body:job()});
  assert.equal((await h.req('/api/jobs/admin/run-next',{method:'POST',token:h.tokenA,body:{}})).status,401);
  const done=await h.req('/api/jobs/admin/run-next',{method:'POST',token:h.env.ADMIN_KEY,body:{}});
  assert.equal(done.status,200);
  assert.equal(done.data.completed,1);
});
test('expired worker lease is recovered once or failed after attempt cap',async t=>{
  const h=harness(t);
  const created=await h.req('/api/jobs',{method:'POST',token:h.tokenA,body:job()});
  const id=created.data.job.id;
  h.sqlite.prepare("UPDATE tool_jobs SET status='running',attempts=1,lease_until=1,lease_token='dead' WHERE id=?").run(id);
  await h.schedule();
  assert.equal((await h.req('/api/jobs/'+id,{token:h.tokenA})).data.job.status,'completed');
  assert.equal((await h.req('/api/jobs/'+id,{token:h.tokenA})).data.job.attempts,2);
  const b=await h.req('/api/jobs',{method:'POST',token:h.tokenA,body:job('request_second_1')});
  h.sqlite.prepare("UPDATE tool_jobs SET status='running',attempts=2,lease_until=1,lease_token='dead' WHERE id=?").run(b.data.job.id);
  await h.schedule();
  const finished=await h.req('/api/jobs/'+b.data.job.id,{token:h.tokenA});
  assert.equal(finished.data.job.status,'failed');
  assert.equal(finished.data.job.errorCode,'lease_expired');
});
test('MCP queues and reads only authenticated owner jobs',async t=>{
  const h=harness(t);
  const rpc=async(token,method,params)=>{
    const response=await h.req('/mcp',{method:'POST',token,body:{jsonrpc:'2.0',id:1,method,params}});
    assert.equal(response.status,200);return response.data;
  };
  const catalog=await rpc(null,'tools/list',{});
  assert.ok(catalog.result.tools.find(t=>t.name==='forum_queue_tool'));
  const added=await rpc(h.tokenA,'tools/call',{name:'forum_queue_tool',arguments:job('mcp_request_1234')});
  assert.equal(added.result.isError,false,JSON.stringify(added));
  const id=JSON.parse(added.result.content[0].text).job.id;
  const forbidden=await rpc(h.tokenB,'tools/call',{name:'forum_job_status',arguments:{job_id:id}});
  assert.equal(forbidden.result.isError,true);
  const ok=await rpc(h.tokenA,'tools/call',{name:'forum_job_status',arguments:{job_id:id}});
  assert.equal(JSON.parse(ok.result.content[0].text).job.status,'queued');
});
