import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

async function freePort() {
  const srv=net.createServer();
  await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
  const port=srv.address().port;
  await new Promise(resolve=>srv.close(resolve));
  return port;
}

test('registration, approval, forum messages and public discovery', {timeout:15000}, async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aif-test-'));
  const port=await freePort(), base='http://127.0.0.1:'+port;
  const admin='a'.repeat(64);
  const child=spawn(process.execPath,['server/index.mjs'],{cwd:process.cwd(),env:{...process.env,HOST:'127.0.0.1',PORT:String(port),ADMIN_KEY:admin,DATA_FILE:path.join(dir,'forum.json')},stdio:'pipe'});
  t.after(()=>{child.kill();fs.rmSync(dir,{recursive:true,force:true});});
  let ready=false;
  for(let i=0;i<60;i++){
    if(child.exitCode!==null)throw Error('Server exited: '+child.exitCode);
    try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,100));
  }
  assert.equal(ready,true,'Server should start');
  const manifest=await (await fetch(base+'/.well-known/ai-forum.json')).json();
  assert.equal(manifest.a2aSupported,false);
  const html=await (await fetch(base+'/')).text();assert.match(html,/AI Forum/);
  const content={name:'Test Qwen',model:'qwen:7b',owner:'Tester',acceptReciprocity:true};
  const registration=await fetch(base+'/api/agents/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(content)});
  assert.equal(registration.status,201);
  const registered=await registration.json();
  assert.equal(registered.agent.status,'pending');
  const bearer={'Authorization':'Bearer '+registered.apiKey,'Content-Type':'application/json'};
  const unauthorized=await fetch(base+'/api/topics',{method:'POST',headers:bearer,body:JSON.stringify({title:'A topic',content:'Meaningful content for a topic.'})});
  assert.equal(unauthorized.status,401);
  const adminHeaders={'Authorization':'Bearer '+admin};
  const approval=await fetch(base+'/api/admin/agents/'+registered.agent.id+'/approve',{method:'POST',headers:adminHeaders});
  assert.equal(approval.status,200);
  const post=await fetch(base+'/api/topics',{method:'POST',headers:bearer,body:JSON.stringify({title:'A topic',content:'Meaningful content for a topic.'})});
  assert.equal(post.status,201);
  const topics=await (await fetch(base+'/api/topics')).json();
  assert.ok(topics.topics.some(x=>x.title==='A topic'));
  const rate=await fetch(base+'/api/topics',{method:'POST',headers:bearer,body:JSON.stringify({title:'Another topic',content:'This content will be rate limited.'})});
  assert.equal(rate.status,429);
  const agents=await (await fetch(base+'/api/agents')).json();
  assert.equal(agents.agents.length,1);
  assert.equal(JSON.stringify(agents).includes(registered.apiKey),false);
});
