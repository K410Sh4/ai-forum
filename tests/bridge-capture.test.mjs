import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createCaptureController,CAPTURE_TTL} from '../extensions/ai-forum-bridge/stream.js';
function setup(){
 const data={'capture:abc':{text:'original',origin:'https://chatgpt.com',at:1000,sourceTabId:7}};
 const storage={async get(k){return structuredClone(k===null?data:{[k]:data[k]});},async set(v){Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}};
 let now=1000;const sent=[],injections=[];
 const tabs={async get(){return {url:'https://chatgpt.com/c/example'};},async update(){},async sendMessage(id,msg){sent.push({id,...msg});return {ok:true,text:'final'};}};
 const scripting={async executeScript(args){injections.push(args);}};
 const runtime={id:'ours'};
 const controller=createCaptureController({storage,tabs,scripting,runtime,clock:()=>now,uuid:()=> 'secret'});
 const sender={id:'ours',tab:{id:7},frameId:0,url:'https://chatgpt.com/c/example'};
 return {data,tabs,controller,sender,sent,injections,advance:()=>{now+=CAPTURE_TTL+1;}};
}
test('capture is armed only for the original supported tab, with an isolated script and fresh token',async()=>{
 const h=setup();
 assert.equal(await h.controller.receive({text:'unarmed',seq:1,token:'secret'},h.sender),false);
 await h.controller.handle({type:'STREAM_START',id:'abc',mode:'next'});
 assert.equal(h.injections[0].world,'ISOLATED');assert.equal(h.injections[0].target.tabId,7);
 assert.equal(h.sent.at(-1).type,'BRIDGE_ARM');assert.equal(h.data['capture:abc'].text,'');
 for(const sender of [{...h.sender,id:'other'},{...h.sender,frameId:1},{...h.sender,url:'https://evil.test'}, {...h.sender,tab:{id:8}}])
  assert.equal(await h.controller.receive({text:'fake',seq:1,token:'secret'},sender),false);
 assert.equal(await h.controller.receive({text:'fake',seq:1,token:'wrong'},h.sender),false);
 assert.equal(await h.controller.receive({text:'part 1',seq:1,token:'secret'},h.sender),true);
 assert.equal(await h.controller.receive({text:'stale',seq:1,token:'secret'},h.sender),false);
 assert.equal(h.data['capture:abc'].text,'part 1');
 const result=await h.controller.handle({type:'STREAM_FINISH',id:'abc'});
 assert.equal(result.text,'final');assert.equal(h.data['stream:7'],undefined);
 assert.equal(await h.controller.receive({text:'late',seq:2,token:'secret'},h.sender),false);
});
test('capture expires and cannot be revived by page traffic or a changed source origin',async()=>{
 const h=setup();await h.controller.handle({type:'STREAM_START',id:'abc',mode:'pick'});
 h.advance();assert.equal(await h.controller.receive({text:'late',seq:1,token:'secret'},h.sender),false);
 assert.equal(h.data['stream:7'],undefined);
 h.tabs.get=async()=>({url:'https://evil.test'});
 await assert.rejects(h.controller.handle({type:'STREAM_START',id:'abc',mode:'next'}));
 assert.equal(h.injections.length,1);
});
test('failed capture startup, missing source tab and clear stop capture without publishing',async()=>{
 const h=setup();
 await assert.rejects(h.controller.handle({type:'STREAM_START',id:'missing',mode:'next'}));
 await assert.rejects(h.controller.handle({type:'STREAM_START',id:'abc',mode:'exec'}));
 await h.controller.handle({type:'STREAM_START',id:'abc',mode:'next'});
 await h.controller.clear();assert.equal(h.data['stream:7'],undefined);
 h.tabs.sendMessage=async()=>{throw Error('closed');};
 await assert.rejects(h.controller.handle({type:'STREAM_START',id:'abc',mode:'next'}),/closed/);
 assert.equal(h.data['stream:7'],undefined);
});
function contentHarness(){
 const listeners=[],messages=[],timers=new Map();let tid=0,callback,reads=0,disconnected=false;
 const old={isConnected:true,innerText:'old answer',querySelector:()=>null},nodes=[old];
 const window={};window.top=window;
 const location={hostname:'chatgpt.com',href:'https://chatgpt.com/c/test'};
 const context=vm.createContext({window,location,WeakSet,Element:class{},addEventListener(){},
  document:{querySelectorAll(){reads++;return nodes;},documentElement:{}},
  MutationObserver:class{constructor(fn){callback=fn;}observe(){}disconnect(){disconnected=true;}},
  setTimeout(fn,ms){const id=++tid;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},
  chrome:{runtime:{id:'ours',getURL:()=> 'chrome-extension://ours/',onMessage:{addListener:fn=>listeners.push(fn)},sendMessage:async msg=>messages.push(msg)}}});
 const code=fs.readFileSync(new URL('../extensions/ai-forum-bridge/content.js',import.meta.url),'utf8');
 vm.runInContext(code,context);
 return {messages,nodes,location,timers,context,code,listeners,reads:()=>reads,disconnected:()=>disconnected,
  send(msg,sender={id:'ours'}){let response;listeners[0](msg,sender,x=>{response=x;});return response;},
  scan(){callback();},flush(ms){for(const [id,t] of [...timers])if(t.ms===ms){timers.delete(id);t.fn();}}};
}
test('content script remains idle until armed, excludes existing answers, streams locally and stops at deadline',()=>{
 const h=contentHarness();assert.equal(h.reads(),0);
 vm.runInContext(h.code,h.context);assert.equal(h.listeners.length,1);
 h.send({type:'BRIDGE_ARM',token:'t'},{id:'evil'});assert.equal(h.reads(),0);
 assert.equal(h.send({type:'BRIDGE_ARM',token:'t'}).ok,true);
 h.scan();h.flush(300);assert.equal(h.messages.length,0);
 h.nodes.push({isConnected:true,innerText:'new answer',querySelector:()=>null});h.scan();h.flush(300);
 assert.equal(h.messages[0].text,'new answer');assert.equal(h.messages[0].token,'t');
 h.flush(600000);assert(h.disconnected());h.scan();h.flush(300);assert.equal(h.messages.length,1);
});
test('navigation before a delayed delivery or finalization cannot capture text from another conversation',()=>{
 const h=contentHarness();h.send({type:'BRIDGE_ARM',token:'t'});
 h.nodes.push({isConnected:true,innerText:'other conversation',querySelector:()=>null});h.scan();
 h.location.href='https://chatgpt.com/c/other';h.flush(300);assert.equal(h.messages.length,0);
 assert.equal(h.send({type:'BRIDGE_FINISH',token:'t'}).text,'');
});
