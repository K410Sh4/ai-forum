// One-shot AI Forum V3 PRODUCTION E2E using disposable cryptographic identities.
// Authorized scope: SHA-256 read-only job, one explicitly consented result grant,
// a few read probes and revocation. No public posts or administrator credentials.
// The tests intentionally create private, ephemeral audit records in production D1.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ForumClient } from '../agents/forum-client.mjs';

const API='https://ai-forum-api.k410sh4-ai-forum-2026.workers.dev';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ai-forum-live-e2e-'));
const marker='AI Forum V3 consented read-only production test '+crypto.randomUUID();
const expected=crypto.createHash('sha256').update(marker).digest('hex');
const shortKey=()=>crypto.randomUUID().replaceAll('-','');
const profile=name=>({name:'V3 live audit '+name,model:'Node.js controlled E2E',owner:'AI Forum operator authorized'});
const make=(name,scopes,identity=name)=>new ForumClient({
  api:API,identityFile:path.join(dir,identity+'.json'),
  acceptPolicy:'2026-11-01',profile:profile(identity),scopes
});
const owner=make('owner',['identity:read','jobs:create','jobs:read','jobs:share','jobs:cancel']);
const restricted=make('owner-readonly',['identity:read','jobs:read'],'owner');
const recipient=make('recipient',['identity:read','jobs:read']);
const outsider=make('outsider',['identity:read','jobs:read']);
const active=[];
let jobId=null,shareId=null,finished=false;

async function raw(route,session,{method='GET',body}={}){
  const response=await fetch(new URL(route,API),{
    method,redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{
      Accept:'application/json',
      ...(body===undefined?{}:{'Content-Type':'application/json'}),
      ...(session?{Authorization:'Bearer '+session.token}:{})
    },
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  const data=await response.json().catch(()=>null);
  return {status:response.status,data};
}
function ok(status,want,label){assert.equal(status,want,label+' expected HTTP '+want+' got '+status);}
async function enroll(client,label){
  const session=await client.session();
  assert.ok(session.agent.id.startsWith('key_'),label+' identity enrollment not key bound');
  active.push(session);
  console.log('AUTH OK:',label,'Ed25519, scopes validated');
  return session;
}
async function main(){
  const [network,broker,policy]=await Promise.all([
    owner.request('/api/network/capabilities'),
    owner.request('/api/jobs/capabilities'),
    owner.request('/api/agent-access/policy')
  ]);
  assert.equal(network.protocol,'ai-forum-agent-execution-network-v3');
  assert.equal(network.available,true);
  assert.equal(broker.available,true);
  assert.ok(broker.allowedTools.includes('hub_sha256'));
  assert.ok(policy.authorization.scopes.includes('jobs:share'));
  assert.ok(!policy.authorization.defaultScopes.includes('jobs:share'));
  console.log('PREFLIGHT OK: V3, V2, SHA-256 and least-privilege policy available');

  // Serialize enrollment to stay well within the public per-IP challenge quota.
  const A=await enroll(owner,'A owner');
  const Areadonly=await enroll(restricted,'A restricted');
  const B=await enroll(recipient,'B recipient');
  const C=await enroll(outsider,'C outsider');
  assert.ok(A.receipt.scopes.includes('jobs:share'));
  assert.ok(!Areadonly.receipt.scopes.includes('jobs:share'));
  assert.ok(!B.receipt.scopes.includes('jobs:share'));
  assert.notEqual(A.agent.id,B.agent.id);
  assert.notEqual(B.agent.id,C.agent.id);

  const requestKey=shortKey();
  const payload={tool:'hub_sha256',arguments:{text:marker},requestKey};
  const created=await raw('/api/jobs',A,{method:'POST',body:payload});
  ok(created.status,202,'queue creation');
  assert.equal(created.data?.job?.status,'queued');
  assert.equal(created.data?.reused,false);
  jobId=created.data.job.id;
  console.log('QUEUE OK: read-only job accepted');

  const replay=await raw('/api/jobs',A,{method:'POST',body:payload});
  ok(replay.status,200,'queue idempotent replay');
  assert.equal(replay.data?.job?.id,jobId);
  assert.equal(replay.data?.reused,true);
  const otherJob=await raw('/api/jobs/'+jobId,B);
  ok(otherJob.status,404,'B may not read A private job');
  const anonymousJob=await raw('/api/jobs/'+jobId,null);
  ok(anonymousJob.status,401,'anonymous private job access');

  const sharePath='/api/jobs/'+jobId+'/shares';
  const sharePayload={recipientAgentId:B.agent.id,requestKey:shortKey(),expiresHours:1,confirmShare:true};
  const withoutScope=await raw(sharePath,Areadonly,{method:'POST',body:sharePayload});
  ok(withoutScope.status,403,'A without jobs:share must be denied');

  const deniedConsent=await raw(sharePath,A,{method:'POST',body:{...sharePayload,confirmShare:false}});
  ok(deniedConsent.status,400,'missing explicit sharing consent');

  const deadline=Date.now()+9*60000;
  let lastStatus='queued',detail;
  for(;;){
    detail=await owner.authorized('/api/jobs/'+jobId);
    assert.equal(detail.job.id,jobId);
    if(detail.job.status!==lastStatus){
      console.log('JOB STATUS:',detail.job.status,'attempts:',detail.job.attempts);
      lastStatus=detail.job.status;
    }
    if(detail.job.status==='completed') break;
    if(['failed','cancelled'].includes(detail.job.status))
      throw Error('Cron job ended with non-completed status: '+detail.job.status);
    if(Date.now()>deadline)throw Error('Cron job timeout; last status '+detail.job.status);
    await sleep(15000);
  }
  assert.equal(detail.job.result?.algorithm,'SHA-256');
  assert.equal(detail.job.result?.hex,expected);
  assert.ok(detail.events.map(e=>e.event).includes('completed'));
  console.log('CRON OK: SHA-256 verified independently; audit job completed');

  const invalidRecipient=await raw(sharePath,A,{method:'POST',body:{
    ...sharePayload,recipientAgentId:'nonexistent-v3-audit-agent-'+shortKey().slice(0,8),requestKey:shortKey()
  }});
  ok(invalidRecipient.status,404,'unknown recipient');
  const shared=await raw(sharePath,A,{method:'POST',body:sharePayload});
  ok(shared.status,201,'owner share creation');
  assert.equal(shared.data?.reused,false);
  shareId=shared.data.share.id;
  assert.equal(shared.data.share.recipientAgentId,B.agent.id);
  const repeated=await raw(sharePath,A,{method:'POST',body:sharePayload});
  ok(repeated.status,200,'share idempotent replay');
  assert.equal(repeated.data?.reused,true);
  assert.equal(repeated.data.share.id,shareId);
  const conflict=await raw(sharePath,A,{method:'POST',body:{...sharePayload,expiresHours:2}});
  ok(conflict.status,409,'conflicting requestKey');
  console.log('GRANT OK: 1-hour consent, same-key replay and conflict control');

  const third=await raw('/api/network/inbox/'+shareId,C);
  ok(third.status,404,'C cannot access B result');
  const anonymous=await raw('/api/network/inbox/'+shareId,null);
  ok(anonymous.status,401,'anonymous shared result access');
  const bInbox=await recipient.authorized('/api/network/inbox');
  assert.ok(bInbox.shares.some(x=>x.id===shareId));
  const cInbox=await outsider.authorized('/api/network/inbox');
  assert.ok(!cInbox.shares.some(x=>x.id===shareId));
  const received=await recipient.authorized('/api/network/inbox/'+shareId);
  assert.equal(received.result?.hex,expected);
  const serialized=JSON.stringify(received);
  assert.ok(!serialized.includes(marker),'private job arguments exposed');
  assert.ok(!serialized.includes(requestKey),'private request key exposed');
  assert.ok(!serialized.includes(sharePayload.requestKey),'share idempotency key exposed');
  assert.ok(!serialized.includes(A.token),'owner session token exposed');
  console.log('ISOLATION OK: B receives only the authorized result; C and anonymous denied');

  const mcp=await recipient.rpc({jsonrpc:'2.0',id:17,method:'tools/call',
    params:{name:'forum_read_shared_result',arguments:{share_id:shareId}}});
  assert.equal(mcp.result?.isError,false,'MCP result read failed');
  assert.equal(JSON.parse(mcp.result.content[0].text).result.hex,expected);
  const grants=await owner.authorized(sharePath);
  const acts=grants.events.map(x=>x.action);
  assert.ok(acts.includes('shared'));
  assert.ok(acts.filter(x=>x==='accessed').length>=2,'REST+MCP audit incomplete');
  console.log('AUDIT OK: grant and both REST/MCP reads recorded');

  const deniedRevoke=await raw(sharePath+'/'+shareId,B,{method:'DELETE'});
  ok(deniedRevoke.status,403,'recipient may not revoke owner grant');
  const revoked=await raw(sharePath+'/'+shareId,A,{method:'DELETE'});
  ok(revoked.status,200,'owner revocation');
  assert.ok(revoked.data?.share?.revokedAt);
  const stale=await raw('/api/network/inbox/'+shareId,B);
  ok(stale.status,404,'revoked share unavailable to B');
  const after=await owner.authorized(sharePath);
  assert.ok(after.events.some(x=>x.action==='revoked'));
  const bAfter=await recipient.authorized('/api/network/inbox');
  assert.ok(!bAfter.shares.some(x=>x.id===shareId));
  finished=true;
  console.log('REVOCATION OK: revoked access returns 404 and audit records revocation');
  console.log('LIVE V3 E2E SUCCESS: A -> B -> revoke, C excluded, no public posts');
}
async function cleanup(){
  if(shareId&&!finished){
    try{
      const A=active.find(s=>s.agent?.id===owner.authorization?.agent?.id && s.receipt?.scopes.includes('jobs:share'));
      if(A){
        const r=await raw('/api/jobs/'+jobId+'/shares/'+shareId,A,{method:'DELETE'});
        console.log('CLEANUP share:',r.status===200||r.status===409?'revoked/previously revoked':'unconfirmed');
      }
    }catch{console.log('CLEANUP share unconfirmed');}
  }
  if(jobId&&!shareId&&!finished){
    try{
      const A=owner.authorization;
      const r=await raw('/api/jobs/'+jobId+'/cancel',A,{method:'POST',body:{}});
      if(r.status===200)console.log('CLEANUP queued job cancelled');
    }catch{}
  }
  let revoked=0;
  for(const session of active){
    try{
      const response=await raw('/api/agent-auth/session',session,{method:'DELETE'});
      if(response.status===200&&response.data?.revoked===true)revoked++;
    }catch{}
  }
  console.log('CLEANUP sessions revoked:',revoked+'/'+active.length);
  if(revoked!==active.length)process.exitCode=1;
  fs.rmSync(dir,{recursive:true,force:true});
}
try{await main()}
catch(error){
  // Never log request headers, Bearer tokens, identities or private key files.
  console.error('LIVE V3 E2E FAILED:',String(error?.message||'unknown').slice(0,320));
  process.exitCode=1;
}
finally{await cleanup()}
