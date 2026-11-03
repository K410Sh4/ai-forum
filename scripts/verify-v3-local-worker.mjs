// Agent Network V3 E2E in an isolated Wrangler local Worker+D1 runtime.
// Uses --local only; never connects to the production D1 or Worker.
// Requires: npm ci --prefix cloudflare, Node 22+, no Cloudflare credentials.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ForumClient } from '../agents/forum-client.mjs';

const root=new URL('../cloudflare/',import.meta.url).pathname;
const wrangler=path.join(root,'node_modules','.bin',process.platform==='win32'?'wrangler.cmd':'wrangler');
const tmp=mkdtempSync(path.join(os.tmpdir(),'ai-forum-v3-staging-'));
const admin=crypto.randomBytes(48).toString('hex');
const api='http://127.0.0.1:8787', persist=path.join(tmp,'isolated-d1');
let worker,log='';
const assert=(ok,msg)=>{if(!ok)throw Error(msg)};
const sh=(args)=>execFileSync(wrangler,args,{cwd:root,encoding:'utf8',
  timeout:120000,env:{...process.env,CI:'true',CLOUDFLARE_API_TOKEN:'',CLOUDFLARE_ACCOUNT_ID:''}});

async function request(url,opts={}) {
  const r=await fetch(new URL(url,api),{...opts,redirect:'error',signal:AbortSignal.timeout(12000)});
  return {status:r.status,body:await r.json().catch(()=>null)};
}
function client(name,scopes) {
  return new ForumClient({
    api,identityFile:path.join(tmp,name+'.json'),acceptPolicy:'2026-11-01',
    profile:{name:'V3 staging '+name,model:'CI Node 22',owner:'local isolated staging'},
    scopes
  });
}
function authRequest(client,route,opts) {return client.authorized(route,opts);}
async function test() {
  const migrated=sh(['d1','migrations','apply','ai-forum-db','--local','--persist-to',persist]);
  assert(migrated.includes('0008_job_result_shares.sql'),'0008 migration not executed');
  console.log('STAGING migration 0008 OK — isolated local D1');

  worker=spawn(wrangler,['dev','--local','--ip','127.0.0.1','--port','8787',
    '--persist-to',persist,'--var','ADMIN_KEY:'+admin],{
    cwd:root,env:{...process.env,CI:'true',CLOUDFLARE_API_TOKEN:'',CLOUDFLARE_ACCOUNT_ID:''},
    stdio:['ignore','pipe','pipe']
  });
  worker.stdout.on('data',b=>{log=(log+b.toString()).slice(-5000)});
  worker.stderr.on('data',b=>{log=(log+b.toString()).slice(-5000)});
  let ready=false;
  for(let i=0;i<45;i++){
    if(worker.exitCode!==null)break;
    try{const r=await request('/api/network/capabilities');if(r.status===200&&r.body.available===true){ready=true;break}}catch{}
    await delay(1000);
  }
  assert(ready,'Wrangler Worker failed to start with local D1: '+log.replaceAll(admin,'[REDACTED]').slice(-1500));
  console.log('STAGING Worker online with migration 0008; no production connection');

  const owner=client('owner',['identity:read','jobs:create','jobs:read','jobs:cancel','jobs:share']);
  const reader=client('reader',['identity:read','jobs:read']);
  const third=client('third',['identity:read','jobs:read']);
  const withoutShare=client('without-share',['identity:read','jobs:create','jobs:read']);
  const [ownerSession,readerSession,thirdSession,unprivilegedSession]=await Promise.all(
    [owner.session(),reader.session(),third.session(),withoutShare.session()]);
  const recipientAgentId=readerSession.agent.id;
  assert(ownerSession.receipt.scopes.includes('jobs:share'),'owner missing scope');
  assert(!readerSession.receipt.scopes.includes('jobs:share'),'reader unintentionally received share scope');
  console.log('STAGING authenticated agents with explicitly scoped Ed25519 identities');

  const message='AI Forum isolated V3 Worker+D1 local E2E '+crypto.randomUUID();
  const job=await authRequest(owner,'/api/jobs',{method:'POST',body:{
    tool:'hub_sha256',arguments:{text:message},
    requestKey:'v3stage_'+crypto.randomUUID().replaceAll('-','')}});
  assert(job.job?.id && job.job.status==='queued','job not queued');
  const scheduled=await request('/api/jobs/admin/run-next',{method:'POST',
    headers:{Authorization:'Bearer '+admin,'Content-Type':'application/json'},body:'{}'});
  assert(scheduled.status===200&&scheduled.body.completed===1,'internal runner failed');
  const detail=await authRequest(owner,'/api/jobs/'+job.job.id);
  const expected=crypto.createHash('sha256').update(message).digest('hex');
  assert(detail.job.status==='completed'&&detail.job.result?.hex===expected,'job result mismatch');
  console.log('STAGING read-only job processed and SHA-256 independently verified');

  const sharePath='/api/jobs/'+job.job.id+'/shares';
  const reqBody={recipientAgentId,requestKey:'v3share_'+crypto.randomUUID().replaceAll('-',''),
    expiresHours:1,confirmShare:true};
  const denied=await request(sharePath,{method:'POST',
    headers:{Authorization:'Bearer '+unprivilegedSession.token,'Content-Type':'application/json'},
    body:JSON.stringify(reqBody)});
  assert(denied.status===403,'unprivileged session could share a job');
  const created=await authRequest(owner,sharePath,{method:'POST',body:reqBody});
  assert(created.share?.id && created.reused===false,'share was not created');
  const replay=await authRequest(owner,sharePath,{method:'POST',body:reqBody});
  assert(replay.reused===true && replay.share.id===created.share.id,'share idempotency failed');
  const shareId=created.share.id;

  const foreign=await request('/api/network/inbox/'+shareId,
    {headers:{Authorization:'Bearer '+thirdSession.token}});
  assert(foreign.status===404,'foreign agent saw private shared output');
  const inbox=await authRequest(reader,'/api/network/inbox');
  assert(inbox.shares.some(x=>x.id===shareId),'recipient inbox missing share');
  const result=await authRequest(reader,'/api/network/inbox/'+shareId);
  assert(result.result?.hex===expected,'recipient did not receive correct SHA-256');
  assert(!JSON.stringify(result).includes(message),'input arguments leaked');
  assert(!JSON.stringify(result).includes(reqBody.requestKey),'idempotency key leaked');

  const audit=await authRequest(owner,sharePath);
  assert(audit.events.some(x=>x.action==='accessed'),'read audit event missing');
  const revoked=await authRequest(owner,sharePath+'/'+shareId,{method:'DELETE'});
  assert(revoked.share?.revokedAt,'share revocation failed');
  const revokedRead=await request('/api/network/inbox/'+shareId,
    {headers:{Authorization:'Bearer '+readerSession.token}});
  assert(revokedRead.status===404,'revoked share remained accessible');
  console.log('STAGING PASS: scope isolation, consent, idempotency, audit, private inbox, revoke');

  for(const session of [ownerSession,readerSession,thirdSession,unprivilegedSession]){
    const res=await request('/api/agent-auth/session',
      {method:'DELETE',headers:{Authorization:'Bearer '+session.token}});
    assert(res.status===200&&res.body.revoked===true,'test session revocation failed');
  }
  console.log('STAGING PASS: four scoped sessions revoked; remote D1 untouched');
}
try{await test()}catch(e){
  console.error('STAGING FAIL:',e.message.replaceAll(admin,'[REDACTED]'));
  process.exitCode=1;
}finally{
  if(worker){worker.kill('SIGTERM');await delay(600);}
  rmSync(tmp,{recursive:true,force:true});
}
