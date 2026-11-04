import {providerFromUrl,buildPrompt,extractDraftFromText,fetchPublicContext,publish} from './protocol.js';
const KEY='afb-session';
const OWNER_KEY='afb-owner-publish-key';
const ownerCredential=async()=>{const v=(await chrome.storage.session.get(OWNER_KEY))[OWNER_KEY];return typeof v==='string'&&/^[A-Za-z0-9_-]{48,160}$/.test(v)?v:'';};
const forgetOwnerCredential=()=>chrome.storage.session.remove(OWNER_KEY);
const MAX_MS=8*60*1000; // Cinco abas podem gerar respostas em tempos diferentes.
let queue=Promise.resolve();
const serial=fn=>{const x=queue.then(fn);queue=x.catch(()=>{});return x;};
const get=async()=>(await chrome.storage.session.get(KEY))[KEY]||null;
// Any material change becomes observable by all Bridge dashboard windows.
const set=async x=>{
  if(x && typeof x==='object'){
    x.revision=(Number(x.revision)||0)+1;
    x.updatedAt=Date.now();
  }
  await chrome.storage.session.set({[KEY]:x});
};
const terminal=new Set(['validado','publicado','erro','limite-uso','falha-publicacao','publicacao-incerta','interrompido','aba-descartada']);
const isPanel=sender=>sender.id===chrome.runtime.id && (sender.url||'').startsWith(chrome.runtime.getURL('dashboard.html'));
async function tabList(){
  const tabs=await chrome.tabs.query({});
  return tabs.filter(t=>providerFromUrl(t.url)).map(t=>({id:t.id,provider:providerFromUrl(t.url),title:(t.title||'').slice(0,90),active:!!t.active,discarded:!!t.discarded,frozen:!!t.frozen,urlOrigin:new URL(t.url).origin}));
}
const LAUNCH_TARGETS=Object.freeze([
  {provider:'ChatGPT',url:'https://chatgpt.com/'},
  {provider:'Grok',url:'https://grok.com/'},
  {provider:'Gemini',url:'https://gemini.google.com/app'},
  {provider:'Copilot',url:'https://copilot.microsoft.com/'},
  {provider:'Meta AI',url:'https://meta.ai/'}
]);
// Called only by the dashboard's explicit button. Never launches chats when
// installed, when the panel opens, or on page load. Existing tabs are reused.
// By default each provider receives a separate Chrome window in the CURRENT
// browser profile. Reuse existing chats, moving a tab only when the user
// explicitly clicks the launch button. No cross-profile copies or auto-send.
async function openProviders(sender, mode='windows'){
  const current=await get();
  if(current?.running)throw Error('Interrompa a sessão antes de reorganizar as janelas.');
  if(!['windows','tabs'].includes(mode))throw Error('Modo de abertura inválido.');
  const panelWindowId=Number.isInteger(sender.tab?.windowId)?sender.tab.windowId:undefined;
  const found=await chrome.tabs.query({});
  const chosen=[],opened=[],reused=[],failures=[],moved=[];
  for(const target of LAUNCH_TARGETS){
    let tab=found.find(t=>providerFromUrl(t.url)===target.provider);
    try{
      if(mode==='windows'){
        if(tab){
          const neighbors=await chrome.tabs.query({windowId:tab.windowId});
          if(neighbors.length!==1){
            await chrome.windows.create({tabId:tab.id,focused:false,type:'normal'});
            moved.push(target.provider);
          }
          reused.push(target.provider);
        }else{
          const window=await chrome.windows.create({url:target.url,focused:false,type:'normal'});
          tab=window.tabs?.find(t=>providerFromUrl(t.url)===target.provider);
          if(!Number.isInteger(tab?.id))throw Error('O Chrome não retornou a aba da janela criada.');
          found.push(tab);opened.push(target.provider);
        }
      }else{
        if(tab)reused.push(target.provider);
        else{
          tab=await chrome.tabs.create({url:target.url,active:false,...(panelWindowId===undefined?{}:{windowId:panelWindowId})});
          if(!Number.isInteger(tab?.id))throw Error('O Chrome não retornou a aba criada.');
          found.push(tab);opened.push(target.provider);
        }
      }
      chosen.push(tab.id);
    }catch(e){failures.push({provider:target.provider,error:String(e?.message||e).slice(0,180)});}
  }
  return {mode,tabIds:chosen,opened,reused,moved,failures};
}
async function readyForContent(tabId){
  for(let i=0;i<40;i++){
    const t=await chrome.tabs.get(tabId);
    if(t.status!=='loading')return t;
    await new Promise(r=>setTimeout(r,250));
  }
  throw Error('Página ainda carregando; autentique-se e tente iniciar novamente.');
}
async function restoreTabs(s){
  if(!s)return;
  await Promise.all(Object.values(s.entries||{}).map(async e=>{
    if(e.token)try{await chrome.tabs.sendMessage(e.tabId,{type:'AFB_STOP',token:e.token});}catch{}
    if(typeof e.previousAutoDiscardable==='boolean')try{await chrome.tabs.update(e.tabId,{autoDiscardable:e.previousAutoDiscardable});}catch{}
  }));
}
async function halt(reason='interrompido'){
  const s=await get();if(!s)return null;
  s.running=false;s.endedAt=Date.now();s.endedReason=reason;
  for(const e of Object.values(s.entries))if(!terminal.has(e.status)){e.status=reason==='tempo-esgotado'?'erro':'interrompido';e.detail=reason==='tempo-esgotado'?'Limite de 8 minutos atingido.':'Interrompido pelo usuário.';}
  await set(s);await restoreTabs(s);await forgetOwnerCredential();await chrome.alarms.clear('afb-deadline');await chrome.alarms.clear('afb-owner-key-expiry');return s;
}
async function expire(){const s=await get();if(s?.running && Date.now()>=s.deadline)await halt('tempo-esgotado');}
async function start(message){
  await expire();const prior=await get();if(prior?.running)throw Error('Existe uma sessão ativa. Interrompa antes de iniciar outra.');
  if(message.consentPrompt!==true)throw Error('Autorize explicitamente o envio de prompts.');
  if(message.resumePending!==undefined && typeof message.resumePending!=='boolean')throw Error('Opção de retomada inválida.');
  if(message.autoPublish!==true && message.autoPublish!==false)throw Error('Escolha o modo de publicação.');
  if(message.ownerMode!==true && message.ownerMode!==false && message.ownerMode!==undefined)throw Error('Modo proprietário inválido.');
  const ownerKey=message.ownerMode===true?String(message.ownerKey||'').trim():'';
  if(message.ownerMode===true&&!/^[A-Za-z0-9_-]{48,160}$/.test(ownerKey))throw Error('Informe a chave exclusiva do Bridge: 48 a 160 caracteres alfanuméricos ou _ e -.');
  if(typeof message.objective!=='string'||message.objective.trim().length<12||message.objective.length>1500)throw Error('Objetivo deve ter entre 12 e 1500 caracteres.');
  const ids=message.tabIds;
  if(!Array.isArray(ids)||!ids.length||ids.length>8||new Set(ids).size!==ids.length||ids.some(x=>!Number.isInteger(x)))throw Error('Selecione de 1 a 8 abas válidas.');
  const available=await tabList();const chosen=ids.map(id=>available.find(t=>t.id===id));
  if(chosen.some(x=>!x))throw Error('Uma das abas foi fechada ou não é suportada.');
  const sessionId=crypto.randomUUID(),now=Date.now();
  const s={id:sessionId,running:true,createdAt:now,deadline:now+MAX_MS,autoPublish:message.autoPublish,objective:message.objective.trim(),
    entries:{},logs:[],endedAt:null,endedReason:null};
  for(const t of chosen){const raw=(await chrome.tabs.get(t.id));s.entries[t.id]={tabId:t.id,provider:t.provider,title:t.title,status:'preparando',detail:'Preparando captura.',token:crypto.randomUUID(),previousAutoDiscardable:raw.autoDiscardable!==false,chars:0,receipt:null,draft:null,tries:0};}
  await forgetOwnerCredential();
  if(ownerKey){await chrome.storage.session.set({[OWNER_KEY]:ownerKey});await chrome.alarms.create('afb-owner-key-expiry',{when:now+10*60*1000});}
  await set(s);await chrome.alarms.create('afb-deadline',{when:s.deadline});
  // Public forum context is untrusted. If fetching fails, models generate independent topics.
  const ctx=await fetchPublicContext();
  // Providers are initialized concurrently; each chat continues independently.
  await Promise.all(chosen.map(async t=>{
    const current=await get();if(!current?.running || current.id!==sessionId)break;
    const entry=current.entries[t.id];
    const prompt=buildPrompt({provider:t.provider,objective:current.objective,context:ctx,marker:'AFB-'+crypto.randomUUID()});
    try {
      const real=await readyForContent(t.id);
      if(real.discarded||real.frozen)throw Error('Aba descartada/congelada. Ative-a e inicie outra sessão.');
      await chrome.tabs.update(t.id,{autoDiscardable:false});
      await chrome.scripting.executeScript({target:{tabId:t.id},files:['content.js'],world:'ISOLATED'});
      const result=await chrome.tabs.sendMessage(t.id,{type:'AFB_START',sessionId,token:entry.token,prompt,ttl:MAX_MS,resumePending:message.resumePending===true});
      if(!result?.ok)throw Error(result?.error||'Injeção do prompt não confirmada.');
      await serial(async()=>{const state=await get();if(state?.id!==sessionId)return;const e=state.entries[t.id];if(e&&!terminal.has(e.status)){if(e.status==='preparando'||e.status==='aguardando'){e.status='aguardando';e.detail='Envio confirmado; aguardando a IA.';}e.tries=1;await set(state);}});
    }catch(e){
      await serial(async()=>{const state=await get();if(state?.id!==sessionId)return;const en=state.entries[t.id];en.detail=String(e.message||e).slice(0,300);en.status=/Limite de uso/i.test(en.detail)?'limite-uso':'erro';en.tries=1;await set(state);});
      try{await chrome.tabs.update(t.id,{autoDiscardable:entry.previousAutoDiscardable});}catch{}
    }
  }));
  return await get();
}
async function progress(message,sender){
  const tabId=sender.tab?.id;
  if(sender.id!==chrome.runtime.id||sender.frameId!==0||!Number.isInteger(tabId)||!providerFromUrl(sender.url))return false;
  return serial(async()=>{
    const s=await get();if(!s?.running||Date.now()>s.deadline||s.id!==message.sessionId)return false;
    const e=s.entries[tabId];if(!e||e.provider!==providerFromUrl(sender.url)||e.token!==message.token||terminal.has(e.status))return false;
    if(message.final===true){
      if(message.state!=='concluido'||typeof message.text!=='string')return false;
      try{e.draft=extractDraftFromText(message.text,e.provider+' (web)');e.status='validado';e.detail='Resposta JSON validada; publicação '+(s.autoPublish?'autorizada.':'aguardando aprovação.');}
      catch(error){e.status='erro';e.detail='Resposta concluída, mas inválida: '+String(error.message).slice(0,210);}
      e.chars=message.text.length;await set(s);
      if(e.status==='validado'&&s.autoPublish){
        e.status='publicando';e.detail='Enviando uma única vez ao fórum.';await set(s);
        // O envio não é repetido automaticamente mesmo quando há falha de confirmação.
        try{
          const receipt=await publish(e.draft,fetch,await ownerCredential());
          e.status='publicado';e.detail='HTTP 201 confirmado pelo servidor.';e.receipt=receipt;
        }catch(err){e.status=/incerta|confirmação|confirmou/i.test(String(err.message))?'publicacao-incerta':'falha-publicacao';e.detail=String(err.message).slice(0,300);}
        await set(s);
      }
    }else{
      const states={aguardando:'aguardando',gerando:'gerando',validando:'validando',erro:'erro','limite-uso':'limite-uso',interrompido:'interrompido'};
      if(!states[message.state])return false;
      e.status=states[message.state];e.detail=String(message.detail||'').slice(0,250);e.chars=Number.isInteger(message.chars)?message.chars:0;
      if(terminal.has(e.status)){e.draft=null;}
      await set(s);
    }
    if(Object.values(s.entries).every(x=>terminal.has(x.status))){s.running=false;s.endedAt=Date.now();s.endedReason='concluida';await set(s);await restoreTabs(s);await chrome.alarms.clear('afb-deadline');
      if(s.autoPublish || !Object.values(s.entries).some(x=>x.status==='validado')){await forgetOwnerCredential();await chrome.alarms.clear('afb-owner-key-expiry');}
    }
    return true;
  });
}
async function approve(tabId){
  return serial(async()=>{
    const s=await get();if(!s||s.autoPublish)throw Error('Aprovação manual não está ativa.');
    const e=s.entries[tabId];if(!e||e.status!=='validado'||!e.draft)throw Error('Nenhuma proposta validada aguardando aprovação.');
    e.status='publicando';e.detail='Publicação aprovada manualmente; uma única tentativa.';await set(s);
    try{e.receipt=await publish(e.draft,fetch,await ownerCredential());e.status='publicado';e.detail='HTTP 201 confirmado.';}
    catch(err){e.status=/incerta|confirmação|confirmou/i.test(String(err.message))?'publicacao-incerta':'falha-publicacao';e.detail=String(err.message).slice(0,250);}
    await set(s);
    if(!Object.values(s.entries).some(x=>x.status==='validado')){await forgetOwnerCredential();await chrome.alarms.clear('afb-owner-key-expiry');}
    return {status:e.status,receipt:e.receipt};
  });
}
chrome.runtime.onInstalled.addListener(()=>{chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}).catch(()=>{});});
chrome.action.onClicked.addListener(()=>chrome.tabs.create({url:chrome.runtime.getURL('dashboard.html')}));
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='afb-deadline')expire().catch(()=>{});
  if(alarm.name==='afb-owner-key-expiry')forgetOwnerCredential().catch(()=>{});});
chrome.tabs.onRemoved.addListener(id=>{serial(async()=>{const s=await get();if(!s?.running||!s.entries[id])return;const e=s.entries[id];e.status='erro';e.detail='A aba foi fechada.';await set(s);});});
chrome.tabs.onUpdated.addListener((id,changes,tab)=>{
  if(!(changes.discarded||changes.frozen||changes.status==='loading'))return;
  serial(async()=>{const s=await get();if(!s?.running||!s.entries[id])return;const e=s.entries[id];if(terminal.has(e.status))return;
    if(changes.discarded||changes.frozen){e.status='aba-descartada';e.detail='Aba descartada/congelada; nenhum reenvio automático.';await set(s);}
    // Roteamento /? -> /c/... não pode causar cancelamento por loading.
  }).catch(()=>{});
});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message?.type==='AFB_PROGRESS'){
    progress(message,sender).then(ok=>respond({ok}),()=>respond({ok:false}));return true;
  }
  if(!isPanel(sender)){respond({ok:false,error:'Mensagem de origem não autorizada.'});return false;}
  const run=(async()=>{
    switch(message?.type){
      case 'AFB_TABS':return tabList();
      case 'AFB_OPEN_PROVIDERS':return openProviders(sender,message.mode||'windows');
      case 'AFB_STATE':await expire();return get();
      case 'AFB_START_SESSION':return start(message);
      case 'AFB_STOP_SESSION':return serial(()=>halt());
      case 'AFB_APPROVE':return approve(message.tabId);
      case 'AFB_INSPECT':{
        const s=await get();if(!s?.running)return false;
        const results=await Promise.all(Object.values(s.entries).filter(e=>!terminal.has(e.status)).map(async e=>{
          try {const d=await chrome.tabs.sendMessage(e.tabId,{type:'AFB_INSPECT'});
            return {tabId:e.tabId,provider:e.provider,diagnostic:{active:!!d?.active,regions:Number(d?.regions)||0,checks:Number(d?.checks)||0,deepScans:Number(d?.deepScans)||0,deepTextNodes:Number(d?.deepTextNodes)||0,editor:!!d?.editor,visibility:d?.visible==='hidden'?'oculta':'visível'}};
          } catch {return {tabId:e.tabId,provider:e.provider,diagnostic:{active:false,regions:0,checks:0,editor:false,visibility:'desconhecida'}};}
        }));
        await serial(async()=>{const latest=await get();if(!latest?.running||latest.id!==s.id)return;
          for(const r of results){const e=latest.entries[r.tabId];if(e&&!terminal.has(e.status))e.diagnostic=r.diagnostic;}
          await set(latest);
        });
        return results;
      }
      default:throw Error('Comando desconhecido.');
    }
  })();
  run.then(data=>respond({ok:true,data}),e=>respond({ok:false,error:String(e?.message||e)}));return true;
});
