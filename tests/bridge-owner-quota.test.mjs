import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';

const BASE='https://ai-forum.test';
const ADMIN='g'.repeat(64);
const OWNER='b'.repeat(64);
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
  const env={DB:db, ADMIN_KEY:ADMIN, GUEST_MODERATION_KEY:'m'.repeat(64), BRIDGE_OWNER_PUBLISH_KEY:OWNER};
  async function req(path,{method='GET',data,ip='198.51.100.2',admin=false,type='application/json',accept='application/json',bearer,bridgeClaim=false}={}){
    const headers={'Content-Type':type, Accept:accept, 'CF-Connecting-IP':ip};
    if(admin)headers.Authorization='Bearer '+ADMIN;
    if(bearer)headers.Authorization='Bearer '+bearer;
    if(bridgeClaim)headers['X-AI-Forum-Bridge']='v2.3.0';
    const body=data===undefined?undefined:type==='application/x-www-form-urlencoded'?new URLSearchParams(data).toString():JSON.stringify(data);
    const result=await worker.fetch(new Request(BASE+path,{method,headers,...(body===undefined?{}:{body})}),env);
    return {status:result.status,data:result.status===303?null:await result.json(),location:result.headers.get('location')};
  }
  return {req,sql,env};
}

const topic={kind:'topic',agent:'Agente Externo',model:'Modelo declarado',title:'Debate original de teste',content:'Conteúdo público usado para validar o comportamento de quotas.',acceptPolicy:true};
const pub=(h,n,opts={})=>h.req('/api/open/posts',{method:'POST',data:{...topic,title:'Publicação '+n},...opts});
const owner=(h,n,opts={})=>h.req('/api/bridge/owner/posts',{method:'POST',data:{...topic,title:'Publicação privilegiada '+n},bearer:OWNER,...opts});
test('unverified Bridge claims cannot access owner route, while public posting has no hourly quota',async t=>{
 const h=harness(t);
 for(let i=0;i<12;i++)assert.equal((await pub(h,i,{bridgeClaim:true})).status,201);
 assert.equal((await owner(h,0,{bearer:'wrong'})).status,401);
 assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM open_actions').get().n,12);
});
test('owner route remains gated and does not consume public quota',async t=>{
 const h=harness(t);
 for(let i=0;i<8;i++)assert.equal((await pub(h,i)).status,201);
 for(let i=0;i<15;i++){
   const result=await owner(h,i);
   assert.equal(result.status,201,JSON.stringify(result.data));
   assert.equal(result.data.publication.status,'published');
   assert.match(result.data.publication.authorName,/não verificado/);
 }
 assert.equal((await pub(h,8)).status,201);
 assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM open_actions').get().n,24);
});
test('owner route fails closed without secret, with admin secret reused, and with malformed auth',async t=>{
 const h=harness(t);
 assert.equal((await owner(h,1,{bearer:'x'.repeat(64)})).status,401);
 assert.equal((await owner(h,2,{bearer:ADMIN})).status,401);
 h.env.BRIDGE_OWNER_PUBLISH_KEY=ADMIN;
 assert.equal((await owner(h,3,{bearer:ADMIN})).status,503);
 delete h.env.BRIDGE_OWNER_PUBLISH_KEY;
 assert.equal((await owner(h,4)).status,503);
 assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM open_actions').get().n,0);
});
test('owner quota exemption preserves consent, content length and UNIQUE duplicates',async t=>{
 const h=harness(t);
 assert.equal((await h.req('/api/bridge/owner/posts',{method:'POST',data:{...topic,acceptPolicy:false},bearer:OWNER})).status,400);
 assert.equal((await h.req('/api/bridge/owner/posts',{method:'POST',data:{...topic,content:'A'.repeat(3001)},bearer:OWNER})).status,400);
 assert.equal((await owner(h,1)).status,201);
 assert.equal((await owner(h,1)).status,409);
 assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM open_actions').get().n,1);
});
test('owner credential never grants administrator privileges',async t=>{
 const h=harness(t);
 assert.equal((await owner(h,1)).status,201);
 const id=h.sql.prepare('SELECT id FROM topics WHERE id LIKE \'open-%\'').get().id;
 assert.equal((await h.req('/api/admin/topics/'+id+'/hide',{method:'POST',bearer:OWNER})).status,401);
 assert.equal((await h.req('/api/topics/'+id)).status,200);
});
