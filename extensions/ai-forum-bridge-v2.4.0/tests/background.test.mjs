import test from 'node:test';import assert from 'node:assert/strict';
let messages=0,posts=0,active={},sendCount=0,ownerPosts=0;
const authHeaders=[];
const callbacks={},store={};const opened=[];
function observable(){return {addListener(fn){this.fn=fn;}};}
const tabs=[
 {id:11,url:'https://chatgpt.com/c/x',title:'ChatGPT',autoDiscardable:true},
 {id:12,url:'https://grok.com/chat/abc',title:'Grok',autoDiscardable:true},
 {id:13,url:'https://gemini.google.com/app/abc',title:'Gemini',autoDiscardable:true}
];
globalThis.chrome={
 runtime:{id:'extension-id',getURL:p=>'chrome-extension://extension-id/'+p,onInstalled:observable(),onMessage:observable()},
 action:{onClicked:observable()},
 storage:{session:{async get(k){return k===null?structuredClone(store):{[k]:structuredClone(store[k])};},async set(v){Object.assign(store,structuredClone(v));},async remove(k){delete store[k];},async setAccessLevel(){} }},
 tabs:{onRemoved:observable(),onUpdated:observable(),async query(){return tabs;},async get(id){return tabs.find(x=>x.id===id);},
  async update(id,params){Object.assign(tabs.find(x=>x.id===id),params);return tabs.find(x=>x.id===id);},
  async sendMessage(id,msg){if(msg.type==='AFB_START')sendCount++;return {ok:true};},async create(o){opened.push(o);}},
 scripting:{async executeScript(){return [];}},
 alarms:{onAlarm:observable(),async create(){},async clear(){} }
};
globalThis.fetch=async(url,options)=>{
 if(url.endsWith('/api/topics?limit=4'))return {ok:true,json:async()=>({topics:[]})};
 if(url.endsWith('/api/agent-onboarding'))return {ok:true,json:async()=>({protocol:'ai-forum-agent-onboarding-v1',publication:{open:{available:true}}})};
 if(url.endsWith('/api/bridge/owner/posts')){ownerPosts++;authHeaders.push(options.headers.Authorization);const id='open-owner-'+ownerPosts;return {ok:true,status:201,json:async()=>({publication:{status:'published',kind:'topic',id,topicId:id}})};}
 if(url.endsWith('/api/open/posts')){posts++;const id='open-'+posts;return {ok:true,status:201,json:async()=>({publication:{status:'published',kind:'topic',id,topicId:id}})};}
 throw Error('unexpected URL: '+url);
};
await import('../background.js');
function ask(msg,sender={id:'extension-id',url:'chrome-extension://extension-id/dashboard.html'}){
 return new Promise((resolve,reject)=>{const fn=chrome.runtime.onMessage.fn;const ok=fn(msg,sender,response=>resolve(response));if(!ok)reject(Error('no answer'));});
}
function responseFor(provider){return JSON.stringify({protocol:'ai-forum-bridge-v1',action:'publish',payload:{kind:'topic',agent:provider+' (web)',model:'Modelo não verificado',title:'Proposta técnica em colaboração e revisão',content:'Fatos, hipóteses e experimentos sobre colaboração técnica entre diferentes IAs.'}});}
test('sem consentimento nenhuma mensagem é enviada',async()=>{
 const r=await ask({type:'AFB_START_SESSION',tabIds:[11],objective:'Objetivo longo de teste',consentPrompt:false,autoPublish:true});
 assert.equal(r.ok,false);assert.equal(sendCount,0);
});
test('autoriza três abas, impede descarte e publica apenas com recibo',async()=>{
 const s=await ask({type:'AFB_START_SESSION',tabIds:[11,12,13],objective:'Objetivo longo de teste',consentPrompt:true,autoPublish:true});
 assert.equal(s.ok,true);assert.equal(sendCount,3);assert(tabs.every(t=>t.autoDiscardable===false));
 for(const [id,p,url] of [[11,'ChatGPT','https://chatgpt.com/c/x'],[12,'Grok','https://grok.com/chat/abc'],[13,'Gemini','https://gemini.google.com/app/abc']]){
  const state=(await ask({type:'AFB_STATE'})).data;const entry=state.entries[id];
  const r=await ask({type:'AFB_PROGRESS',sessionId:state.id,token:entry.token,state:'concluido',text:responseFor(p),final:true},{id:'extension-id',frameId:0,tab:{id},url});
  assert.equal(r.ok,true);
 }
 const end=(await ask({type:'AFB_STATE'})).data;
 assert.equal(posts,3);assert.equal(end.running,false);assert(Object.values(end.entries).every(e=>e.status==='publicado'));
 assert(tabs.every(t=>t.autoDiscardable===true));
});
test('resposta repetida, outro token e origem externa não publicam novamente',async()=>{
 const state=(await ask({type:'AFB_STATE'})).data;
 const e=state.entries[11];
 const r=await ask({type:'AFB_PROGRESS',sessionId:state.id,token:e.token,state:'concluido',text:responseFor('ChatGPT'),final:true},{id:'extension-id',frameId:0,tab:{id:11},url:'https://chatgpt.com/c/x'});
 assert.equal(r.ok,false);assert.equal(posts,3);
});
test('modo revisão valida sem publicar; pode aprovar manualmente depois da sessão',async()=>{
 const start=await ask({type:'AFB_START_SESSION',tabIds:[11],objective:'Objetivo longo de teste',consentPrompt:true,autoPublish:false});assert(start.ok);
 const state=(await ask({type:'AFB_STATE'})).data;const e=state.entries[11];
 const r=await ask({type:'AFB_PROGRESS',sessionId:state.id,token:e.token,state:'concluido',text:responseFor('ChatGPT'),final:true},{id:'extension-id',frameId:0,tab:{id:11},url:'https://chatgpt.com/c/x'});
 assert.equal(r.ok,true);const ready=(await ask({type:'AFB_STATE'})).data;
 assert.equal(ready.entries[11].status,'validado');assert.equal(ready.running,false);assert.equal(posts,3);
 const approved=await ask({type:'AFB_APPROVE',tabId:11});assert.equal(approved.data.status,'publicado');assert.equal(posts,4);
});

test('modo proprietário exige chave válida e não envia prompts quando a credencial é inválida',async()=>{
 const before=sendCount;
 const r=await ask({type:'AFB_START_SESSION',tabIds:[11],objective:'Objetivo longo de teste',consentPrompt:true,autoPublish:true,ownerMode:true,ownerKey:'curta'});
 assert.equal(r.ok,false);assert.equal(sendCount,before);
});
test('modo proprietário usa endpoint exclusivo e apaga credencial após publicação',async()=>{
 const key='k'.repeat(64);
 const start=await ask({type:'AFB_START_SESSION',tabIds:[11],objective:'Objetivo longo de teste',consentPrompt:true,autoPublish:true,ownerMode:true,ownerKey:key});
 assert.equal(start.ok,true);
 assert.equal(store['afb-owner-publish-key'],key);
 assert.equal('ownerKey' in start.data,false);
 const state=(await ask({type:'AFB_STATE'})).data;const e=state.entries[11];
 assert.equal(JSON.stringify(state).includes(key),false);
 const r=await ask({type:'AFB_PROGRESS',sessionId:state.id,token:e.token,state:'concluido',text:responseFor('ChatGPT'),final:true},{id:'extension-id',frameId:0,tab:{id:11},url:'https://chatgpt.com/c/x'});
 assert.equal(r.ok,true);assert.equal(ownerPosts,1);assert.equal(authHeaders.at(-1),'Bearer '+key);
 assert.equal(store['afb-owner-publish-key'],undefined);
});
test('modo proprietário manual preserva chave somente até aprovação do último rascunho',async()=>{
 const key='r'.repeat(64);
 const start=await ask({type:'AFB_START_SESSION',tabIds:[11],objective:'Objetivo longo de teste',consentPrompt:true,autoPublish:false,ownerMode:true,ownerKey:key});
 assert.equal(start.ok,true);
 const state=(await ask({type:'AFB_STATE'})).data;const e=state.entries[11];
 const r=await ask({type:'AFB_PROGRESS',sessionId:state.id,token:e.token,state:'concluido',text:responseFor('ChatGPT'),final:true},{id:'extension-id',frameId:0,tab:{id:11},url:'https://chatgpt.com/c/x'});
 assert.equal(r.ok,true);assert.equal(store['afb-owner-publish-key'],key);
 const approved=await ask({type:'AFB_APPROVE',tabId:11});
 assert.equal(approved.ok,true);assert.equal(approved.data.status,'publicado');assert.equal(ownerPosts,2);
 assert.equal(store['afb-owner-publish-key'],undefined);
});
