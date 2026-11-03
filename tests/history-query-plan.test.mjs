// Performance regression: prove each V1 history query has an indexed keyset plan.
// Uses a realistic number of separate owner/foreign records in isolated local SQLite.
// This is NOT a measurement of Cloudflare remote D1 latency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const TYPES=[
  ['topics','topics','author_id','history_topics_owner_recent','id,title,hidden,created_at'],
  ['replies','replies','author_id','history_replies_owner_recent','id,topic_id,hidden,created_at'],
  ['annotations','peer_annotations','author_id','history_annotations_owner_recent','id,topic_id,target_kind,target_id,kind,hidden,created_at'],
  ['jobs','tool_jobs','owner_id','history_jobs_owner_recent','id,tool_name,status,created_at,finished_at'],
  ['shares-sent','job_result_shares','owner_id','history_shares_sender_recent','id,job_id,recipient_id,expires_at,revoked_at,created_at'],
  ['shares-received','job_result_shares','recipient_id','history_shares_recipient_recent','id,job_id,owner_id,expires_at,revoked_at,created_at']
];
const count=3600;
function p95(values) {
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.ceil(sorted.length*.95)-1];
}
test('six history categories have indexed recent/deep cursor queries and bounded SQLite latency',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for(const file of readdirSync(new URL('../cloudflare/migrations/',import.meta.url)).sort())
      db.exec(readFileSync(new URL('../cloudflare/migrations/'+file,import.meta.url),'utf8'));
    const joined='2026-11-03T12:00:00.000Z';
    const insAgent=db.prepare('INSERT INTO agents(id,name,model,owner,key_hash,status,joined_at) VALUES (?,?,?,?,?,?,?)');
    for(const name of ['key_A','key_B'])insAgent.run(name,name,'benchmark','benchmark','hash-'+name,'active',joined);
    const topic=db.prepare('INSERT INTO topics(id,title,content,tags,author_id,author_name,created_at,hidden) VALUES (?,?,?,?,?,?,?,?)');
    const reply=db.prepare('INSERT INTO replies(id,topic_id,author_id,author_name,content,created_at,hidden) VALUES (?,?,?,?,?,?,?)');
    const ann=db.prepare('INSERT INTO peer_annotations(id,topic_id,target_kind,target_id,kind,content,evidence_url,author_id,author_name,claimed_model,created_at,hidden) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    const job=db.prepare('INSERT INTO tool_jobs(id,owner_id,request_key,tool_name,arguments_json,status,attempts,result_json,created_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
    const share=db.prepare('INSERT INTO job_result_shares(id,job_id,owner_id,recipient_id,request_key,ttl_hours,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)');
    db.exec('BEGIN IMMEDIATE');
    for(let i=0;i<count;i++){
      const id=String(i).padStart(6,'0'),owner=i%4===0?'key_B':'key_A',other=owner==='key_A'?'key_B':'key_A';
      const at=new Date(Date.parse(joined)+i*1000).toISOString();
      topic.run('topic-'+id,'title','public','[]',owner,owner,at,0);
      reply.run('reply-'+id,'welcome',owner,owner,'public',at,0);
      ann.run('annotation-'+id,'welcome','topic','welcome','comment','public',null,owner,owner,'benchmark',at,0);
      job.run('job-'+id,owner,'request-'+id,'hub_sha256','{"text":"test"}','completed',1,'{"hex":"test"}',at,at);
      share.run('share-'+id,'job-'+id,owner,other,'share-request-'+id,1,at,'2027-11-03T12:00:00.000Z');
    }
    db.exec('COMMIT');
    const metrics=[];
    for(const [type,table,owner,index,fields] of TYPES){
      // The equality owner predicate is constant; deep pagination uses a tuple
      // comparison instead of OR, allowing a start-bound scan in composite idx.
      const cases=[
        {name:'recent',sql:`SELECT ${fields} FROM ${table} WHERE ${owner}=? ORDER BY created_at DESC,id DESC LIMIT ?`,
          args:['key_A',21]},
        {name:'deep',sql:`SELECT ${fields} FROM ${table} WHERE ${owner}=? AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?`,
          args:['key_A','2026-11-03T12:30:00.000Z','job-001800',21]}
      ];
      for(const sample of cases){
        const plan=db.prepare('EXPLAIN QUERY PLAN '+sample.sql).all(...sample.args);
        const details=plan.map(x=>x.detail).join(' | ');
        assert.ok(details.includes(index),type+' '+sample.name+' missing '+index+': '+details);
        assert.doesNotMatch(details,/SCAN \w+|USE TEMP B-TREE/i,type+' '+sample.name+' costly plan: '+details);
        if(sample.name==='deep')
          assert.match(details,/created_at,id|created_at|\(created_at,id\)/,type+' deep bound not applied: '+details);
        const stmt=db.prepare(sample.sql);
        for(let k=0;k<15;k++) stmt.all(...sample.args);
        const durations=[];
        for(let j=0;j<150;j++){
          const start=process.hrtime.bigint();
          const rows=stmt.all(...sample.args);
          const ms=Number(process.hrtime.bigint()-start)/1e6;
          assert.ok(rows.length<=21,'DB query exceeded limit');
          durations.push(ms);
        }
        const ms=p95(durations);
        assert.ok(ms<100,type+' '+sample.name+' local SQLite p95 over 100ms: '+ms.toFixed(2));
        metrics.push({type,mode:sample.name,p95Ms:Number(ms.toFixed(3)),plan:details});
      }
    }
    console.log('HISTORY QUERY PLANS (SQLite only, '+count+' records/category, 150 reads per query):');
    for(const sample of metrics)
      console.log(sample.type+' '+sample.mode+' p95='+sample.p95Ms+'ms '+sample.plan);
  } finally {db.close();}
});
