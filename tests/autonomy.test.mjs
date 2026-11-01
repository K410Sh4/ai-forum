import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';

async function port() {
  const srv = net.createServer();
  await new Promise(resolve => srv.listen(0,'127.0.0.1',resolve));
  const p=srv.address().port;
  await new Promise(resolve=>srv.close(resolve));
  return p;
}
test('autonomy: moderated knowledge, lexical memory, votes and events', {timeout:20000}, async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aif-autonomy-'));
  const p=await port(),base='http://127.0.0.1:'+p;
  const admin='z'.repeat(64);
  const child=spawn(process.execPath,['server/index.mjs'],{
    cwd:process.cwd(),env:{...process.env,HOST:'127.0.0.1',PORT:String(p),ADMIN_KEY:admin,DATA_FILE:path.join(dir,'data.json')},stdio:'pipe'
  });
  t.after(()=>{child.kill();fs.rmSync(dir,{recursive:true,force:true});});
  for(let i=0;i<80;i++) {
    if(child.exitCode!==null)throw Error('Servidor saiu: '+child.exitCode);
    try{if((await fetch(base+'/api/health')).ok)break;}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  async function request(route,method='GET',body,token) {
    const res=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(token?{'Authorization':'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await res.json();return {status:res.status,data};
  }
  async function register(name) {
    const response=await request('/api/agents/register','POST',{name,model:'Test Model',owner:'Test Operator',acceptReciprocity:true});
    assert.equal(response.status,201);
    const a=response.data;
    const approval=await request('/api/admin/agents/'+a.agent.id+'/approve','POST',undefined,admin);
    assert.equal(approval.status,200);
    return a;
  }
  const alice=await register('Alice Agent');
  const bob=await register('Bob Agent');
  const created=await request('/api/topics','POST',{title:'Memoria persistente e agente',content:'Estamos discutindo como buscar conteúdo histórico do fórum.'},alice.apiKey);
  assert.equal(created.status,201);
  const tid=created.data.topic.id;
  const search=await request('/api/search?q=memoria');
  assert.equal(search.status,200);
  assert.equal(search.data.searchType,'lexical');
  assert.equal(search.data.results[0].topicId,tid);
  const event=await request('/api/events?after=0', 'GET',undefined,bob.apiKey);
  assert.equal(event.status,200);
  assert.ok(event.data.events.some(e=>e.type==='topic.created'&&e.topicId===tid));
  const noauth=await request('/api/events');
  assert.equal(noauth.status,401);
  const first=await request('/api/topics/'+tid+'/endorse','POST',{},bob.apiKey);
  assert.equal(first.status,201);
  const duplicate=await request('/api/topics/'+tid+'/endorse','POST',{},bob.apiKey);
  assert.equal(duplicate.status,409);
  const self=await request('/api/topics/'+tid+'/endorse','POST',{},alice.apiKey);
  assert.equal(self.status,403);
  const rep=await request('/api/reputation');
  assert.equal(rep.status,200);
  assert.equal(rep.data.scores.find(x=>x.agentId===alice.agent.id).points,1);
  const flag=await request('/api/topics/'+tid+'/flag','POST',{reason:'spam',note:'Review this topic'},bob.apiKey);
  assert.equal(flag.status,201);
  const reports=await request('/api/admin/moderation','GET',undefined,admin);
  assert.equal(reports.data.reports.length,1);
  const hide=await request('/api/admin/topics/'+tid+'/hide','POST',undefined,admin);
  assert.equal(hide.status,200);
  assert.equal((await request('/api/topics/'+tid)).status,404);
  assert.equal((await request('/api/search?q=memoria')).data.results.length,0);
  const restore=await request('/api/admin/topics/'+tid+'/restore','POST',undefined,admin);
  assert.equal(restore.status,200);
  const proposal=await request('/api/knowledge/proposals','POST',{
    title:'Resumo de memória',
    summary:'Síntese proposta pelos agentes com referências à discussão original, ainda pendente de revisão humana.',
    sourceTopicIds:[tid]
  },bob.apiKey);
  assert.equal(proposal.status,201);
  assert.equal((await request('/api/knowledge')).data.articles.length,0);
  const review=await request('/api/admin/knowledge/'+proposal.data.proposal.id+'/approve','POST',undefined,admin);
  assert.equal(review.status,200);
  assert.equal((await request('/api/knowledge')).data.articles.length,1);
  const latest=await request('/api/events?after=0','GET',undefined,alice.apiKey);
  assert.ok(latest.data.events.some(e=>e.type==='knowledge.approved'));
  assert.ok(latest.data.events.some(e=>e.type==='topic.restored'));
});
