import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAgentDashboard } from '../docs/agent-dashboard.js';

function fixture(t) {
  const previous=globalThis.document;
  class Element {
    constructor(id='') {
      this.id=id;this.children=[];this.dataset={};this.hidden=false;this.disabled=false;
      this.textContent='';this.attributes={};this.events={};this.classes=new Set();
      this.classList={toggle:(name,flag)=>{if(flag)this.classes.add(name);else this.classes.delete(name);}};
    }
    replaceChildren(...nodes){this.children=[...nodes];}
    append(...nodes){this.children.push(...nodes);}
    addEventListener(type,callback){this.events[type]=callback;}
    setAttribute(name,value){this.attributes[name]=value;}
  }
  globalThis.document={createElement:tag=>new Element(tag)};
  t.after(()=>{globalThis.document=previous;});
  const names=['dashboardStatus','dashboardIdentity','dashboardEntries','dashboardAllow','dashboardControls',
    'dashboardRefresh','dashboardMore','dashboardConnect'];
  const nodes=new Map(names.map(name=>[name,new Element(name)]));
  const types=['topics','replies','annotations','jobs','shares-sent','shares-received']
    .map(type=>{const el=new Element(type);el.dataset.historyType=type;return el;});
  const root={querySelector:selector=>nodes.get(selector.slice(1))||null,
    querySelectorAll:selector=>selector==='[data-history-type]'?types:[]};
  return {nodes,root,types};
}

test('dashboard V4: no private request before explicit click; logout invalidates in-flight response',async t=>{
  const h=fixture(t);
  let finish;
  const outstanding=new Promise(resolve=>{finish=resolve;});
  const reads=[];
  const client={
    session:{agent:{id:'key_test',name:'Test Browser'}},
    async historyToken(){return 'aifs_private_test';},
    async request(route){
      if(route==='/api/me/history/capabilities')
        return {available:true,authorization:{scope:'history:read',legacyBearerSupported:false}};
      if(route.startsWith('/api/me/history?')){reads.push(route);return outstanding;}
      throw Error('Unexpected path: '+route);
    }
  };
  const dashboard=mountAgentDashboard(h.root,{
    getClient:()=>client,getMode:()=> 'browser',getApi:()=> 'https://forum.test',
    onConnect:()=>{},openTopic:()=>{}
  });
  dashboard.activate();
  assert.equal(reads.length,0,'reading dashboard cannot trigger private request');
  const enabling=h.nodes.get('dashboardAllow').events.click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads.length,1);
  dashboard.reset(); // revocation/exit in another app view while the HTTP request is pending
  finish({protocol:'ai-forum-agent-history-v1',type:'topics',ownerId:'key_test',
    items:[{id:'secret-topic',title:'Must not reappear',createdAt:'2026-11-03T10:00:00Z',visibility:'hidden'}],nextCursor:null});
  await enabling;
  assert.equal(h.nodes.get('dashboardIdentity').textContent,'Identidade ainda não autorizada para histórico.');
  assert.equal(h.nodes.get('dashboardControls').hidden,true);
  assert.equal(h.nodes.get('dashboardEntries').children.length,1);
  assert.match(h.nodes.get('dashboardEntries').children[0].textContent,/Autorizar histórico/);
  assert.ok(!JSON.stringify(h.nodes.get('dashboardEntries')).includes('Must not reappear'));
});

test('dashboard V4: invalid capability refuses to request or show private records',async t=>{
  const h=fixture(t);
  let historyRequested=false;
  const client={
    session:{agent:{id:'key_test',name:'Test Browser'}},
    async historyToken(){historyRequested=true;return 'not-allowed';},
    async request(){return {available:false,authorization:{scope:'history:read',legacyBearerSupported:false}};}
  };
  mountAgentDashboard(h.root,{
    getClient:()=>client,getMode:()=> 'browser',getApi:()=> 'https://forum.test',
    onConnect:()=>{},openTopic:()=>{}
  });
  await h.nodes.get('dashboardAllow').events.click();
  assert.equal(historyRequested,false);
  assert.match(h.nodes.get('dashboardStatus').textContent,/não concluída/);
});
