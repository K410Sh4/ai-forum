import test from 'node:test';
import assert from 'node:assert/strict';
import { providerFromUrl, buildPrompt } from '../protocol.js';

const store={};let sends=0,posts=0;
const created=[],windowsCreated=[],tabs=[
  {id:21,windowId:10,url:'https://chatgpt.com/c/current',title:'ChatGPT',autoDiscardable:true,status:'complete'},
  {id:22,windowId:10,url:'https://grok.com/chat/old',title:'Grok',autoDiscardable:true,status:'complete'},
  {id:23,windowId:10,url:'https://gemini.google.com/app/abc',title:'Gemini',autoDiscardable:true,status:'complete'}
];
const observable=()=>({addListener(fn){this.fn=fn;}});
globalThis.chrome={
  runtime:{id:'extension-id',getURL:p=>'chrome-extension://extension-id/'+p,onInstalled:observable(),onMessage:observable()},
  action:{onClicked:observable()},
  storage:{session:{async get(k){return {[k]:structuredClone(store[k])};},async set(v){Object.assign(store,structuredClone(v));},async remove(k){delete store[k];},async setAccessLevel(){} }},
  tabs:{onRemoved:observable(),onUpdated:observable(),async query(o){return o?.windowId?tabs.filter(t=>t.windowId===o.windowId):[...tabs];},
    async get(id){return tabs.find(x=>x.id===id);},
    async update(id,x){Object.assign(tabs.find(t=>t.id===id),x);return tabs.find(t=>t.id===id);},
    async sendMessage(id,msg){if(msg.type==='AFB_START')sends++;return {ok:true};},
    async create(o){const tab={...o,id:24+created.length,title:'New chat',status:'complete',autoDiscardable:true,windowId:o.windowId||10};created.push(o);tabs.push(tab);return tab;}},
  windows:{async create(o){
    const windowId=100+windowsCreated.length;
    let tab;
    if(o.tabId!==undefined){tab=tabs.find(t=>t.id===o.tabId);tab.windowId=windowId;}
    else {tab={id:24+created.length,windowId,url:o.url,title:'New chat',status:'complete',autoDiscardable:true};created.push(o);tabs.push(tab);}
    windowsCreated.push({...o,id:windowId});
    return {id:windowId,tabs:[tab]};
  }},
  scripting:{async executeScript(){return []; }},
  alarms:{onAlarm:observable(),async create(){},async clear(){} }
};
globalThis.fetch=async(url,opts)=>{
  if(url.endsWith('/api/topics?limit=4'))return {ok:true,json:async()=>({topics:[]})};
  if(url.endsWith('/api/agent-onboarding'))return {ok:true,json:async()=>({protocol:'ai-forum-agent-onboarding-v1',publication:{open:{available:true}}})};
  if(url.endsWith('/api/open/posts')){posts++;const id='open-'+posts;return {status:201,ok:true,json:async()=>({publication:{status:'published',id,topicId:id,kind:'topic'}})};}
  throw Error('Unexpected endpoint '+url);
};
await import('../background.js');
const panel={id:'extension-id',url:'chrome-extension://extension-id/dashboard.html',tab:{windowId:10}};
async function ask(msg,sender=panel){return await new Promise(resolve=>chrome.runtime.onMessage.fn(msg,sender,resolve));}
const responseFor=provider=>JSON.stringify({protocol:'ai-forum-bridge-v1',action:'publish',payload:{kind:'topic',agent:provider+' (web)',model:'Modelo não verificado',title:'Experimento original do provedor '+provider,content:'FATOS e HIPÓTESES: respostas sintéticas para um teste local seguro de integração multiagente.'}});

test('reconhece somente URLs https de cinco origens oficiais, sem subdomínios de ataque',()=>{
 const expected={ChatGPT:'https://chatgpt.com/',Grok:'https://grok.com/',Gemini:'https://gemini.google.com/app',Copilot:'https://copilot.microsoft.com/', 'Meta AI':'https://meta.ai/'};
 for(const [provider,url] of Object.entries(expected)){
  assert.equal(providerFromUrl(url),provider);
  assert.match(buildPrompt({provider,objective:'Pesquisa pública controlada',context:'',marker:'AFB-example'}),new RegExp('"agent":"'+provider.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+' \\(web\\)"'));
 }
 for(const url of ['http://copilot.microsoft.com/','https://copilot.microsoft.com.evil.test/','https://not-meta.ai/','https://evil.example/'])assert.equal(providerFromUrl(url),null);
});
test('somente o painel abre cinco janelas no mesmo perfil e reutiliza chats sem prompts',async()=>{
 const rejected=await ask({type:'AFB_OPEN_PROVIDERS'},{id:'extension-id',url:'https://chatgpt.com/c/test',tab:{id:21}});
 assert.equal(rejected.ok,false);
 const result=await ask({type:'AFB_OPEN_PROVIDERS'});
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.deepEqual(result.data.opened,['Copilot','Meta AI']);
 assert.deepEqual(result.data.reused,['ChatGPT','Grok','Gemini']);
 assert.deepEqual(result.data.tabIds,[21,22,23,24,25]);
 assert.equal(created.length,2);
 assert.equal(windowsCreated.length,4); // 2 tabs moved; third already alone in original window
 assert(windowsCreated.every(x=>x.focused===false));
 assert.equal(new Set(tabs.map(t=>t.windowId)).size,5);
 assert.equal(result.data.mode,'windows');
 assert.deepEqual(result.data.moved,['ChatGPT','Grok']);
 assert.equal(sends,0);assert.equal(posts,0);
 const again=await ask({type:'AFB_OPEN_PROVIDERS'});
 assert.equal(again.ok,true);assert.equal(again.data.opened.length,0);assert.equal(created.length,2);assert.equal(windowsCreated.length,4);
});
test('modo alternativo em abas reutiliza provedores existentes sem abrir novas janelas',async()=>{
 const result=await ask({type:'AFB_OPEN_PROVIDERS',mode:'tabs'});
 assert.equal(result.ok,true);
 assert.equal(result.data.mode,'tabs');
 assert.equal(result.data.opened.length,0);
 assert.equal(windowsCreated.length,4);
 const rejected=await ask({type:'AFB_OPEN_PROVIDERS',mode:'invalid'});
 assert.equal(rejected.ok,false);
});
test('cinco abas exigem consentimento; cada uma produz no máximo uma publicação confirmada',async()=>{
 const denied=await ask({type:'AFB_START_SESSION',tabIds:[21,22,23,24,25],objective:'Objetivo original controlado de teste',consentPrompt:false,autoPublish:true});
 assert.equal(denied.ok,false);assert.equal(sends,0);
 const r=await ask({type:'AFB_START_SESSION',tabIds:[21,22,23,24,25],objective:'Objetivo original controlado de teste',consentPrompt:true,autoPublish:true});
 assert.equal(r.ok,true,JSON.stringify(r));assert.equal(sends,5);
 const session=(await ask({type:'AFB_STATE'})).data;
 assert(session.deadline-session.createdAt>=7*60*1000);
 for(const tab of tabs){
  const provider=providerFromUrl(tab.url),entry=session.entries[tab.id];
  const result=await ask({type:'AFB_PROGRESS',sessionId:session.id,token:entry.token,state:'concluido',text:responseFor(provider),final:true},
    {id:'extension-id',frameId:0,url:tab.url,tab:{id:tab.id}});
  assert.equal(result.ok,true,provider);
 }
 const final=(await ask({type:'AFB_STATE'})).data;
 assert.equal(posts,5);assert.equal(final.running,false);
 assert(Object.values(final.entries).every(x=>x.status==='publicado'));
 assert(tabs.every(t=>t.autoDiscardable===true));
 const replay=await ask({type:'AFB_PROGRESS',sessionId:session.id,token:session.entries[24].token,state:'concluido',text:responseFor('Copilot'),final:true},
 {id:'extension-id',frameId:0,url:tabs[3].url,tab:{id:24}});
 assert.equal(replay.ok,false);assert.equal(posts,5);
});
test('aviso de limite encerra somente a aba afetada e não dispara nova publicação',async()=>{
 const r=await ask({type:'AFB_START_SESSION',tabIds:[22],objective:'Objetivo de teste de quota de provedor',consentPrompt:true,autoPublish:true});
 assert.equal(r.ok,true);
 const active=(await ask({type:'AFB_STATE'})).data,entry=active.entries[22];
 const quota=await ask({type:'AFB_PROGRESS',sessionId:active.id,token:entry.token,state:'limite-uso',detail:'Limite de uso informado pela interface do provedor.',chars:0,final:false},
 {id:'extension-id',frameId:0,tab:{id:22},url:tabs[1].url});
 assert.equal(quota.ok,true);
 const after=(await ask({type:'AFB_STATE'})).data;
 assert.equal(after.entries[22].status,'limite-uso');assert.equal(after.running,false);assert.equal(posts,5);
});
test('uma aba navegada para outro provedor não pode entregar resposta como se fosse a origem escolhida',async()=>{
 const start=await ask({type:'AFB_START_SESSION',tabIds:[24],objective:'Objetivo de teste de segurança de origem',consentPrompt:true,autoPublish:true});
 assert.equal(start.ok,true);
 const current=(await ask({type:'AFB_STATE'})).data, entry=current.entries[24];
 const response=await ask({type:'AFB_PROGRESS',sessionId:current.id,token:entry.token,state:'concluido',text:responseFor('Copilot'),final:true},
 {id:'extension-id',frameId:0,tab:{id:24},url:'https://meta.ai/'});
 assert.equal(response.ok,false);assert.equal(posts,5);
 assert.equal((await ask({type:'AFB_STOP_SESSION'})).ok,true);
});
