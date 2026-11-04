import test from 'node:test';
import assert from 'node:assert/strict';
import {watchBridgeActivity} from '../dashboard-live.js';

function observable(){
 const listeners=new Set();
 return {
  addListener(fn){listeners.add(fn);},
  removeListener(fn){listeners.delete(fn);},
  emit(...args){for(const fn of listeners)fn(...args);},
  get size(){return listeners.size;}
 };
}
function testEnv(){
 const storage=observable(),created=observable(),removed=observable(),updated=observable(),
   focus=observable(),visibility=observable();
 const previousWindow=globalThis.window, previousDocument=globalThis.document;
 globalThis.window={addEventListener:(e,fn)=>{if(e==='focus')focus.addListener(fn);},
   removeEventListener:(e,fn)=>{if(e==='focus')focus.removeListener(fn);}};
 globalThis.document={visibilityState:'visible',addEventListener:(e,fn)=>{if(e==='visibilitychange')visibility.addListener(fn);},
   removeEventListener:(e,fn)=>{if(e==='visibilitychange')visibility.removeListener(fn);}};
 return {
  chromeApi:{storage:{onChanged:storage},tabs:{onCreated:created,onRemoved:removed,onUpdated:updated}},
  storage,created,removed,updated,focus,visibility,
  restore(){globalThis.window=previousWindow;globalThis.document=previousDocument;}
 };
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,12));
test('Bridge dashboard observes session changes as soon as they reach chrome.storage.session',async t=>{
 const e=testEnv();t.after(()=>e.restore());
 const states=[],tabChanges=[],reconnect=[];
 const stop=watchBridgeActivity({chromeApi:e.chromeApi,onSession:s=>states.push(s),onTabs:()=>tabChanges.push(1),onReconnect:()=>reconnect.push(1),debounceMs:5});
 t.after(stop);
 e.storage.emit({'afb-session':{newValue:{id:'session-a',revision:1,entries:{}}}},'session');
 e.storage.emit({'afb-session':{newValue:{id:'session-a',revision:2,entries:{11:{status:'gerando'}}}}},'session');
 await settle();
 assert.equal(states.at(-1).revision,2);
 assert.equal(states.length,1);
 e.storage.emit({'afb-session':{newValue:{id:'noise'}}},'local');
 await settle();
 assert.equal(states.length,1);
 e.storage.emit({'afb-session':{newValue:null}},'session');
 await settle();
 assert.equal(states.at(-1),null);
});
test('tab lifecycle is debounced and focus rechecks state',async t=>{
 const e=testEnv();t.after(()=>e.restore());
 let tabs=0,refresh=0;
 const stop=watchBridgeActivity({chromeApi:e.chromeApi,onSession:()=>{},onTabs:()=>tabs++,onReconnect:()=>refresh++,debounceMs:6});
 e.created.emit({id:1});e.removed.emit(2);e.updated.emit(3,{status:'loading'});
 e.updated.emit(4,{title:'irrelevant'});
 await settle();
 assert.equal(tabs,1);
 e.focus.emit();
 await settle();
 assert.equal(refresh,1);
 assert.equal(tabs,2);
 stop();
 assert.equal(e.storage.size,0);
 assert.equal(e.created.size,0);
 assert.equal(e.updated.size,0);
 assert.equal(e.focus.size,0);
 e.created.emit({id:1});e.storage.emit({'afb-session':{newValue:{revision:99}}},'session');
 await settle();
 assert.equal(tabs,2);
});
