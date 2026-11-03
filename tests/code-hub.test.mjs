import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';
import { formatCodePost,parseCodePost,formatPatch,parsePatch } from '../docs/code-hub.js';
import { readRoute } from '../docs/navigation.js';

const BASE='https://ai-forum.test';
const read=(file)=>fs.readFileSync(new URL('../'+file,import.meta.url),'utf8');
function harness(t){
  const sqlite=new DatabaseSync(':memory:');
  for(const file of fs.readdirSync(new URL('../cloudflare/migrations/',import.meta.url)).sort())
    sqlite.exec(fs.readFileSync(new URL('../cloudflare/migrations/'+file,import.meta.url),'utf8'));
  t.after(()=>sqlite.close());
  const DB={prepare(sql){return{bind(...args){const query=sqlite.prepare(sql);return{
    async first(){return query.get(...args)||null;},
    async all(){return{results:query.all(...args)};},
    async run(){return{meta:{changes:Number(query.run(...args).changes)}};}
  };}};},async batch(statements){
    sqlite.exec('BEGIN');
    try{const out=[];for(const stmt of statements)out.push(await stmt.run());sqlite.exec('COMMIT');return out;}
    catch(error){sqlite.exec('ROLLBACK');throw error;}
  }};
  const env={DB,ADMIN_KEY:'d'.repeat(64)};
  return async(route,options={})=>{
    const request=new Request(BASE+route,{method:options.method||'GET',
      headers:{'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.78'},
      ...(options.body?{body:JSON.stringify(options.body)}:{})});
    const response=await worker.fetch(request,env);
    return {status:response.status,data:await response.json()};
  };
}
test('code protocol preserves code exactly, including dangerous-looking HTML as inert text',()=>{
  const sample='const input = "<img src=x onerror=alert(1)>";\nconsole.log(input);';
  const content=formatCodePost({language:'javascript',filename:'main.js',summary:'Exemplo demonstrativo seguro.',code:sample});
  assert.equal(parseCodePost(content)?.code,sample);
  assert.equal(parseCodePost(content)?.language,'javascript');
  assert.equal(parseCodePost(content)?.version,'1');
  assert.equal(parseCodePost('not a code post'),null);
  assert.equal(parseCodePost(content.replace('language: javascript','language: evil')),null);
  assert.throws(()=>formatCodePost({language:'unknown',filename:'main.js',summary:'Exemplo demonstrativo seguro.',code:sample}),/linguagem/);
  assert.throws(()=>formatCodePost({language:'javascript',filename:'../secrets',summary:'Exemplo demonstrativo seguro.',code:sample}),/arquivo/);
  assert.throws(()=>formatCodePost({language:'javascript',filename:'main.js',summary:'Exemplo demonstrativo seguro.',code:'x'.repeat(3100)}),/grande/);
});
test('patch proposals are parseable without replacing original source',()=>{
  const content=formatPatch({version:'1.1',summary:'Corrige casos de borda com validação.',diff:'- return a+b\n+ return Number(a)+Number(b)'});
  assert.deepEqual(parsePatch(content),{version:'1.1',summary:'Corrige casos de borda com validação.',diff:'- return a+b\n+ return Number(a)+Number(b)'});
  assert.equal(parsePatch('comment'),null);
  assert.throws(()=>formatPatch({version:'../../x',summary:'Corrige casos de borda com validação.',diff:'- old\n+ new code'}),/versão/);
});
test('existing open REST routes persist Code Lab topics and patch replies with public IDs',async t=>{
  const req=harness(t);
  const content=formatCodePost({language:'luau',filename:'module.lua',summary:'Função simples com casos documentados.',code:'local function add(a,b)\n  return a+b\nend'});
  const payload={kind:'topic',agent:'Code Lab Tester',model:'Test harness',title:'Somar números em Luau',content,acceptPolicy:true};
  const published=await req('/api/open/posts',{method:'POST',body:payload});
  assert.equal(published.status,201,JSON.stringify(published.data));
  assert.equal(published.data.publication.status,'published');
  const id=published.data.publication.id;
  assert.match(id,/^open-[\w-]+$/);
  const listing=await req('/api/topics');
  const found=listing.data.topics.find(x=>x.id===id);
  assert.equal(parseCodePost(found.content)?.filename,'module.lua');
  const patch=formatPatch({version:'1.1',summary:'Adiciona validação dos dois argumentos.',diff:'- return a+b\n+ return tonumber(a)+tonumber(b)'});
  const reply=await req('/api/open/posts',{method:'POST',body:{kind:'reply',topicId:id,agent:'Reviewer',model:'Test harness',content:patch,acceptPolicy:true}});
  assert.equal(reply.status,201,JSON.stringify(reply.data));
  const thread=await req('/api/topics/'+id);
  assert.equal(thread.status,200);
  assert.equal(parseCodePost(thread.data.topic.content)?.code,'local function add(a,b)\n  return a+b\nend');
  assert.equal(parsePatch(thread.data.topic.replies[0].content)?.version,'1.1');
  assert.equal((await req('/api/open/posts',{method:'POST',body:{...payload,acceptPolicy:false}})).status,400);
});
test('Code Lab navigation is linked and no remote execution UI is advertised',()=>{
  assert.deepEqual(readRoute('https://k410sh4.github.io/ai-forum/?view=code'),{view:'code',topic:null});
  const page=read('docs/index.html');
  assert.match(page,/data-view="code"/);
  assert.match(page,/id="codeCreateForm"/);
  assert.match(page,/id="codePatchForm"/);
  assert.match(page,/id="codeStatus"/);
  assert.match(page,/id="codeDetail"/);
  const client=read('docs/code-hub.js');
  assert.doesNotMatch(client,/\b(?:eval|new Function)\s*\(/);
  assert.doesNotMatch(client,/\.innerHTML\s*=/);
  assert.match(read('docs/CODE_HUB.md'),/Worker Cloudflare não é alterado/);
});
