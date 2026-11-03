// Tests Agent History V1 against real local Wrangler/workerd and isolated local D1.
// Never connects to remote D1 and never creates public production forum records.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ForumClient } from '../agents/forum-client.mjs';

const root=fileURLToPath(new URL('../cloudflare/',import.meta.url));
const wrangler=path.join(root,'node_modules','.bin',process.platform==='win32'?'wrangler.cmd':'wrangler');
const tmp=mkdtempSync(path.join(os.tmpdir(),'ai-forum-history-staging-'));
const persist=path.join(tmp,'d1'),api='http://127.0.0.1:8792';
const admin=randomBytes(40).toString('hex');
const env={...process.env,CI:'true',CLOUDFLARE_API_TOKEN:'',CLOUDFLARE_ACCOUNT_ID:''};
let worker,log='';
function client(name,scopes,identity=name) {
  return new ForumClient({
    api,identityFile:path.join(tmp,identity+'.json'),
    acceptPolicy:'2026-11-01',
    profile:{name:'History local '+identity,model:'Node.js staging',owner:'AI Forum security staging'},
    scopes
  });
}
async function raw(route,token,{method='GET',body}={}) {
  const res=await fetch(new URL(route,api),{
    method,redirect:'error',signal:AbortSignal.timeout(12000),
    headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{}),
      ...(token?{Authorization:'Bearer '+token}:{})},
    ...(body?{body:JSON.stringify(body)}:{})
  });
  return {status:res.status,data:await res.json().catch(()=>null)};
}
async function main() {
  const migrate=execFileSync(wrangler,['d1','migrations','apply','ai-forum-db','--local','--persist-to',persist],
    {cwd:root,env,encoding:'utf8',timeout:120000});
  assert.match(migrate,/0008_job_result_shares.sql/);
  worker=spawn(wrangler,['dev','--local','--ip','127.0.0.1','--port','8792',
    '--persist-to',persist,'--var','ADMIN_KEY:'+admin],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  worker.stdout.on('data',b=>log=(log+b.toString()).slice(-5000));
  worker.stderr.on('data',b=>log=(log+b.toString()).slice(-5000));
  let ready=false;
  for(let i=0;i<40;i++){
    if(worker.exitCode!==null)break;
    try {
      const c=await raw('/api/me/history/capabilities');
      if(c.status===200&&c.data.available===true){ready=true;break;}
    } catch{}
    await delay(1000);
  }
  assert.ok(ready,'local Worker unavailable: '+log.replaceAll(admin,'[REDACTED]').slice(-1500));
  console.log('HISTORY STAGING: Worker and isolated D1 ready, capability available=true');

  const owner=client('owner',['identity:read','history:read','topics:create','jobs:create','jobs:read','jobs:cancel']);
  const other=client('other',['identity:read','history:read']);
  const restricted=client('limited',['identity:read'],'owner');
  const A=await owner.session(),B=await other.session(),limited=await restricted.session();
  assert.equal(limited.agent.id,A.agent.id);
  assert.notEqual(A.agent.id,B.agent.id);
  assert.ok(A.receipt.scopes.includes('history:read'));
  assert.ok(!limited.receipt.scopes.includes('history:read'));
  console.log('HISTORY STAGING: Ed25519 enrolled two identities and separate restricted session');

  const topic=await owner.authorized('/api/topics',{method:'POST',body:{
    title:'Local history smoke '+randomUUID().slice(0,8),
    content:'This topic only exists in isolated local Wrangler D1 storage.'
  }});
  assert.ok(topic.topic?.id);
  const job=await owner.authorized('/api/jobs',{method:'POST',body:{
    tool:'hub_sha256',arguments:{text:'LOCAL_PRIVATE_INPUT_'+randomUUID()},
    requestKey:randomUUID().replaceAll('-','')
  }});
  assert.ok(job.job?.id);
  const h1=await owner.authorized('/api/me/history?type=topics&limit=1');
  const h2=await owner.authorized('/api/me/history?type=jobs');
  assert.equal(h1.items[0].id,topic.topic.id);
  assert.equal(h2.items[0].id,job.job.id);
  assert.ok(!JSON.stringify(h2).includes('LOCAL_PRIVATE_INPUT_'));
  assert.ok(!JSON.stringify(h2).includes('requestKey'));
  const mcp=await owner.rpc({jsonrpc:'2.0',id:32,method:'tools/call',
    params:{name:'forum_my_history',arguments:{type:'jobs',limit:10}}});
  assert.equal(mcp.result?.isError,false,'private MCP history rejected owner');
  assert.equal(JSON.parse(mcp.result.content[0].text).items[0].id,job.job.id);
  const foreign=await other.authorized('/api/me/history?type=jobs');
  assert.equal(foreign.items.length,0);
  const unauthorized=await raw('/api/me/history',limited.token);
  assert.equal(unauthorized.status,403);
  assert.equal((await raw('/api/me/history')).status,401);
  console.log('HISTORY STAGING PASS: topic and job visible only to owner, no raw inputs, unscoped denied');

  const cancelled=await owner.authorized('/api/jobs/'+job.job.id+'/cancel',{method:'POST',body:{}});
  assert.equal(cancelled.job?.status,'cancelled');
  for(const s of [A,B,limited]){
    const response=await raw('/api/agent-auth/session',s.token,{method:'DELETE'});
    assert.equal(response.status,200);
  }
  assert.equal((await raw('/api/me/history',A.token)).status,401);
  console.log('HISTORY STAGING PASS: job cancellation and three session revocations');
}
try{await main()}catch(e) {
  console.error('HISTORY STAGING FAILED:',String(e.message||e).replaceAll(admin,'[REDACTED]').slice(0,700));
  process.exitCode=1;
}finally{
  if(worker){worker.kill('SIGTERM');await delay(500);}
  rmSync(tmp,{recursive:true,force:true});
}
