// Measured local workerd + isolated D1 history latency with realistic 12k records.
// This is a staging performance experiment, NEVER remote Cloudflare production.
// Bench fixture session is synthetic; separate staging verifies real Ed25519 signatures.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';

const root=fileURLToPath(new URL('../cloudflare/',import.meta.url));
const wrangler=path.join(root,'node_modules','.bin',process.platform==='win32'?'wrangler.cmd':'wrangler');
const tmp=mkdtempSync(path.join(os.tmpdir(),'aif-history-load-'));
const state=path.join(tmp,'d1');
const api='http://127.0.0.1:8793';
const env={...process.env,CI:'true',CLOUDFLARE_API_TOKEN:'',CLOUDFLARE_ACCOUNT_ID:''};
const admin=randomBytes(48).toString('hex');
const token='aifs_'+randomBytes(32).toString('base64url');
const hash=createHash('sha256').update(token).digest('base64url');
let worker,log='';
const command=args=>execFileSync(wrangler,args,{cwd:root,encoding:'utf8',
  timeout:150000,maxBuffer:16*1024*1024,env});
const quoted=s=>"'"+String(s).replaceAll("'","''")+"'";
function percentile(samples,p=.95) {
  const sorted=[...samples].sort((a,b)=>a-b);
  return sorted[Math.ceil(samples.length*p)-1];
}
function buildFixture(n) {
  const queries=[
    `INSERT INTO agents(id,name,model,owner,key_hash,status,joined_at) VALUES
    ('key_perf','Perf test owner','local','staging','local-perf-agent-hash','active','2026-01-01T00:00:00.000Z'),
    ('key_foreign','Foreign benchmark','local','staging','local-foreign-agent-hash','active','2026-01-01T00:00:00.000Z');`,
    `INSERT INTO agent_identities(key_id,agent_id,public_key,created_at) VALUES
      ('perf-key','key_perf','{}','2026-01-01T00:00:00.000Z');`,
    `INSERT INTO agent_sessions(id,agent_id,token_hash,scopes,audience,expires_at,created_at)
      VALUES ('perf-session','key_perf',${quoted(hash)},'["history:read"]',${quoted(api)},
      ${Date.now()+3600000},'2026-01-01T00:00:00.000Z');`
  ];
  for(let i=0;i<n;i++) {
    const s=String(i).padStart(6,'0'),owner=i%4?'key_perf':'key_foreign';
    const other=owner==='key_perf'?'key_foreign':'key_perf';
    const at=new Date(Date.parse('2026-01-01T00:00:00.000Z')+i*1000).toISOString();
    const q=quoted;
    queries.push(`INSERT INTO topics(id,title,content,tags,author_id,author_name,created_at,hidden)
      VALUES (${q('bm-topic-'+s)},'benchmark','not confidential','[]',${q(owner)},${q(owner)},${q(at)},0);`);
    queries.push(`INSERT INTO replies(id,topic_id,author_id,author_name,content,created_at,hidden)
      VALUES (${q('bm-reply-'+s)},'welcome',${q(owner)},${q(owner)},'benchmark',${q(at)},0);`);
    queries.push(`INSERT INTO peer_annotations(id,topic_id,target_kind,target_id,kind,content,evidence_url,author_id,author_name,claimed_model,created_at,hidden)
      VALUES (${q('bm-note-'+s)},'welcome','topic','welcome','comment','benchmark',NULL,${q(owner)},${q(owner)},'local',${q(at)},0);`);
    queries.push(`INSERT INTO tool_jobs(id,owner_id,request_key,tool_name,arguments_json,status,attempts,result_json,created_at,finished_at)
      VALUES (${q('bm-job-'+s)},${q(owner)},${q('bm-request-'+s)},'hub_sha256','{"text":"not-shared"}','completed',1,'{"hex":"example"}',${q(at)},${q(at)});`);
    queries.push(`INSERT INTO job_result_shares(id,job_id,owner_id,recipient_id,request_key,ttl_hours,created_at,expires_at)
      VALUES (${q('bm-share-'+s)},${q('bm-job-'+s)},${q(owner)},${q(other)},${q('bm-grant-'+s)},1,${q(at)},'2027-01-01T00:00:00.000Z');`);
  }
  const file=path.join(tmp,'fixtures.sql');
  writeFileSync(file,queries.join('\n')+'\n',{mode:0o600});
  return file;
}
async function get(route) {
  const start=process.hrtime.bigint();
  const resp=await fetch(new URL(route,api),{
    redirect:'error',signal:AbortSignal.timeout(10000),
    headers:{Accept:'application/json',Authorization:'Bearer '+token}
  });
  const result=await resp.json();
  const elapsed=Number(process.hrtime.bigint()-start)/1e6;
  assert.equal(resp.status,200,route+': HTTP '+resp.status+', body='+JSON.stringify(result).slice(0,120));
  assert.equal(result.ownerId,'key_perf');
  assert.ok(result.items.length<=20);
  assert.ok(!JSON.stringify(result).includes('not-shared'));
  return elapsed;
}
async function main(){
  const migration=command(['d1','migrations','apply','ai-forum-db','--local','--persist-to',state]);
  assert.match(migration,/0009_history_owner_indexes.sql/);
  const n=2400;
  const file=buildFixture(n);
  command(['d1','execute','ai-forum-db','--local','--persist-to',state,'--file',file]);
  console.log('HISTORY LOAD: seeded '+n+' records for each of five tables in isolated D1');
  worker=spawn(wrangler,['dev','--local','--ip','127.0.0.1','--port','8793',
    '--persist-to',state,'--var','ADMIN_KEY:'+admin],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  worker.stdout.on('data',b=>log=(log+b.toString()).slice(-3000));
  worker.stderr.on('data',b=>log=(log+b.toString()).slice(-3000));
  let ready=false;
  for(let i=0;i<45;i++){
    if(worker.exitCode!==null)break;
    try{
      const r=await fetch(api+'/api/me/history/capabilities');
      if(r.ok&&(await r.json()).available===true){ready=true;break}
    }catch{}
    await delay(1000);
  }
  assert.ok(ready,'Workerd start failed: '+log.replaceAll(admin,'[REDACTED]'));
  const types=['topics','replies','annotations','jobs','shares-sent','shares-received'];
  const cursor=Buffer.from(JSON.stringify([
    new Date(Date.parse('2026-01-01T00:00:00.000Z')+1200*1000).toISOString(),
    'bm-topic-001200'
  ])).toString('base64url');
  for(const type of types){
    for(const deep of [false,true]){
      const url='/api/me/history?type='+type+'&limit=20'+(deep?'&cursor='+cursor:'');
      for(let i=0;i<10;i++)await get(url);
      const times=[];
      for(let i=0;i<70;i++)times.push(await get(url));
      const p95=percentile(times),median=percentile(times,.5);
      console.log('HISTORY WORKER P95: '+type+' '+(deep?'deep':'recent')+
        ' median='+median.toFixed(2)+'ms p95='+p95.toFixed(2)+'ms n='+times.length);
      assert.ok(p95<500,'staging p95 too high: '+type+' '+p95);
    }
  }
  console.log('HISTORY WORKER LOAD PASS: owner-only 12 route variants, isolated D1, no 500/403, bounded results');
}
try {await main()}catch(e){
  console.error('HISTORY WORKER LOAD FAIL:',String(e.message||e).replaceAll(admin,'[REDACTED]').slice(0,900));
  process.exitCode=1;
}finally{
  if(worker){worker.kill('SIGTERM');await delay(500);}
  rmSync(tmp,{recursive:true,force:true});
}
