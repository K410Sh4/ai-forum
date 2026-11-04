import {watchBridgeActivity} from './dashboard-live.js';
import {providerInfo,phaseFor,summarizeSession,sanitizedPreview,ISSUE_STATES,TERMINAL_STATES} from './dashboard-model.js';

const $=id=>document.getElementById(id);
const state={known:[],session:null,selected:new Set(),selectionInitialized:false,activeAction:false,lastSync:0,activity:[],sessionId:null};
const entryViews=new Map();
const rowViews=new Map();
const labelForStatus=e=>phaseFor(e).label;
const MAX_EVENTS=10;

async function api(type,extra={}){
  const response=await chrome.runtime.sendMessage({type,...extra});
  if(!response?.ok)throw Error(response?.error||'O Bridge não respondeu.');
  return response.data;
}
const el=(tag,className='',content)=>{
  const node=document.createElement(tag);
  if(className)node.className=className;
  if(content!==undefined)node.textContent=String(content);
  return node;
};
const prettyNumber=n=>Number(n||0).toLocaleString('pt-BR');
const niceTime=ms=>{
  const seconds=Math.max(0,Math.ceil(ms/1000));
  return Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0');
};
function msg(message,isError=false){
  const target=$('sessionStatus');
  target.textContent=message;
  target.dataset.severity=isError?'error':'info';
}
function live(healthy=true){
  const node=$('liveIndicator');
  node.dataset.health=healthy?'ok':'err';
  node.textContent=healthy?'Painel sincronizado ao vivo':'Conexão com o Bridge indisponível';
}
function event(message,tone='info'){
  state.activity.unshift({message:String(message).slice(0,170),tone,at:Date.now()});
  state.activity.length=Math.min(state.activity.length,MAX_EVENTS);
  paintActivity();
}
function paintActivity(){
  const list=$('activityFeed');list.replaceChildren();
  if(!state.activity.length){
    list.append(el('li','timeline-empty','Aguardando eventos desta janela.'));
    return;
  }
  for(const item of state.activity){
    const li=el('li','timeline-item');
    li.dataset.tone=item.tone;
    const time=el('time','',new Date(item.at).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}));
    time.dateTime=new Date(item.at).toISOString();
    li.append(time,el('p','',item.message));list.append(li);
  }
}
function recordTransitions(previous,next){
  if(!next)return;
  if(previous?.id!==next.id){
    state.activity=[];
    state.sessionId=next.id;
    event('Sessão identificada: '+Object.keys(next.entries||{}).length+' IA(s).');
    return;
  }
  for(const entry of Object.values(next.entries||{})){
    const previousEntry=previous?.entries?.[entry.tabId];
    if(!previousEntry||previousEntry.status===entry.status)continue;
    const phase=phaseFor(entry);
    const tone=entry.status==='publicado'?'success':ISSUE_STATES.has(entry.status)?'error':'info';
    event(entry.provider+': '+phase.phase+'.',tone);
  }
}
function tabStatus(t){
  const entry=state.session?.entries?.[t.id];
  return phaseFor(entry,t);
}
function makeProviderRow(t){
  const entry=state.session?.entries?.[t.id]||null;
  const provider=providerInfo(t.provider),phase=tabStatus(t);
  const row=el('article','provider-row');
  row.dataset.tabId=String(t.id);
  row.style.setProperty('--provider-color',provider.tone);
  row.style.setProperty('--provider-bg',provider.background);
  const identity=el('div','provider-identity');
  const selection=el('input','provider-selection');
  selection.type='checkbox';
  selection.checked=state.selected.has(t.id);
  selection.disabled=!!state.session?.running;
  selection.setAttribute('aria-label','Selecionar '+t.provider+' na aba '+t.id);
  selection.addEventListener('change',()=>{
    state.selectionInitialized=true;
    if(selection.checked)state.selected.add(t.id);
    else state.selected.delete(t.id);
    paintMetrics();
    $('start').disabled=!!state.session?.running||state.activeAction||!state.selected.size;
  });
  const logo=el('span','provider-logo',provider.glyph);
  logo.setAttribute('aria-hidden','true');
  const nameGroup=el('div','provider-name-group');
  nameGroup.append(el('div','provider-name',t.provider),el('div','provider-sub','Aba '+t.id+' · '+(t.discarded?'descartada':t.frozen?'congelada':'no Chrome')));
  identity.append(selection,logo,nameGroup);

  const phaseCol=el('div','provider-phase');
  const phaseHeader=el('div','phase-head');
  const badge=el('span','phase-badge',phase.label);
  badge.dataset.tone=phase.tone;
  phaseHeader.append(badge);
  const track=el('div','phase-track');
  const mode=entry?.status==='publicado'?'complete':
    ISSUE_STATES.has(entry?.status)||entry?.status==='interrompido'?'error':
    entry&& !TERMINAL_STATES.has(entry.status)?'active':'idle';
  track.dataset.mode=mode;
  const bar=el('span');track.append(bar);
  phaseCol.append(phaseHeader,el('p','phase-detail',entry?.detail||phase.phase),track);

  const captureCol=el('div','provider-capture');
  captureCol.append(el('strong','',entry?prettyNumber(entry.chars)+' caracteres':'—'));
  captureCol.append(el('small','',entry?.receipt?.id?'Recibo confirmado':entry?.status==='limite-uso'?'Quota do provedor':'Sem medição de quota'));

  const buttons=el('div','provider-actions');
  const open=el('button','button button-quiet','↗ Abrir');
  open.type='button';open.title='Ativar a janela do '+t.provider;
  open.addEventListener('click',()=>focusProvider(t.id));
  buttons.append(open);
  if(entry){
    const view=el('button','button button-quiet','Detalhes');
    view.type='button';
    view.addEventListener('click',()=>{
      const item=document.querySelector('[data-entry-id="'+t.id+'"]');
      (item||$('results')).scrollIntoView({behavior:'smooth',block:'start'});
    });
    buttons.append(view);
  }
  row.append(identity,phaseCol,captureCol,buttons);
  return row;
}
function paintTabs(){
  const target=$('tabs');
  const items=state.known;
  $('count').textContent=items.length+' conversa(s)';
  if(!items.length){
    rowViews.clear();
    target.replaceChildren(el('div','empty','Nenhum provedor encontrado. Clique em “Abrir as 5 IAs” para criar as janelas.'));
    return;
  }
  if(target.firstElementChild?.classList.contains('empty'))target.replaceChildren();
  const present=new Set();
  for(const tab of items){
    const key=String(tab.id);present.add(key);
    const entry=state.session?.entries?.[tab.id];
    const signature=JSON.stringify({tab,entry,selected:state.selected.has(tab.id),running:state.session?.running});
    const previous=rowViews.get(key);
    if(previous?.signature===signature&&previous.node.isConnected)continue;
    const current=makeProviderRow(tab);
    if(previous?.node.isConnected)previous.node.replaceWith(current);
    else target.append(current);
    rowViews.set(key,{signature,node:current});
  }
  for(const [key,record] of rowViews)if(!present.has(key)){record.node.remove();rowViews.delete(key);}
}
function makeEntryCard(entry){
  const card=el('article','entry');card.dataset.entryId=String(entry.tabId);
  const top=el('div','entryTop');
  const title=el('div','entryTitle',entry.provider+' · Aba '+entry.tabId);
  const status=el('span','state',labelForStatus(entry));
  if(entry.status==='publicado')status.classList.add('ok');
  if(ISSUE_STATES.has(entry.status))status.classList.add('err');
  top.append(title,status);card.append(top);
  card.append(el('div','entryDetail',entry.detail||'Sem detalhes de resposta.'));
  card.append(el('div','entryMeta',prettyNumber(entry.chars)+' caracteres capturados · '+(entry.tries||0)+' tentativa(s) de prompt'));
  if(entry.diagnostic){
    card.append(el('div','entryMeta','Detecção: '+(entry.diagnostic.regions||0)+' região(ões), '+(entry.diagnostic.checks||0)+' checagem(ns), observação '+(entry.diagnostic.active?'ativa':'inativa')));
  }
  if(entry.receipt?.url){
    try{
      const href=new URL(entry.receipt.url);
      if(href.protocol==='https:'&&href.hostname==='k410sh4.github.io'&&href.pathname.startsWith('/ai-forum/')){
        const link=el('a','','Abrir publicação confirmada ↗');
        link.href=href.href;link.target='_blank';link.rel='noopener noreferrer';
        card.append(link);
      }
    }catch{/* An invalid receipt link must never become a navigation. */}
  }
  if(entry.draft){
    card.append(el('div','draftPreview',entry.draft.title+'\n\n'+entry.draft.content));
    if(!state.session.autoPublish && entry.status==='validado'){
      const approve=el('button','button button-primary','Aprovar e publicar esta proposta');
      approve.type='button';
      approve.addEventListener('click',async()=>{
        if(!confirm('Publicar PUBLICAMENTE no AI Forum este tópico?\n\n'+entry.draft.title))return;
        approve.disabled=true;
        try{await api('AFB_APPROVE',{tabId:entry.tabId});await refreshState();}
        catch(error){msg(error.message,true);}
        finally{approve.disabled=false;}
      });
      card.append(approve);
    }
  }
  return card;
}
function paintEntries(){
  const target=$('entries');
  const entries=Object.values(state.session?.entries||{});
  $('resultCount').textContent=entries.length+' resultado(s)';
  if(!entries.length){
    entryViews.clear();
    target.replaceChildren(el('div','empty','Nenhuma resposta capturada nesta sessão.'));
    return;
  }
  if(target.firstElementChild?.classList.contains('empty'))target.replaceChildren();
  const keys=new Set();
  for(const entry of entries){
    const key=String(entry.tabId);
    keys.add(key);
    const signature=JSON.stringify({entry,autoPublish:state.session.autoPublish});
    const old=entryViews.get(key);
    if(old?.signature===signature&&old.node.isConnected)continue;
    const newNode=makeEntryCard(entry);
    if(old?.node.isConnected)old.node.replaceWith(newNode);
    else target.append(newNode);
    entryViews.set(key,{signature,node:newNode});
  }
  for(const [key,old] of entryViews)if(!keys.has(key)){old.node.remove();entryViews.delete(key);}
}
function paintMetrics(){
  const counts=summarizeSession(state.session);
  const total=counts.total || state.selected.size;
  $('metricPublished').replaceChildren(document.createTextNode(counts.published+' '));
  $('metricPublished').append(el('small','','/ '+counts.total));
  $('metricSelected').textContent=String(total);
  $('metricValidated').textContent=String(counts.validated);
  $('metricIssues').textContent=String(counts.issues);
  $('metricPending').textContent=String(counts.pending);
  $('progressBar').style.width=counts.percent+'%';
  $('jsonPreview').textContent=state.session?JSON.stringify(sanitizedPreview(state.session),null,2):'Nenhuma sessão iniciada.';
}
function updateTimer(){
  const s=state.session;
  $('timer').textContent=s?.running?'Restante: '+niceTime(s.deadline-Date.now()):
    s?.endedAt?'Sessão encerrada':'Sem sessão';
}
function paintState(){
  const running=!!state.session?.running,disabled=state.activeAction;
  $('start').disabled=running||disabled||!state.selected.size;
  $('stop').disabled=!running||disabled;
  $('inspect').disabled=!running||disabled;
  $('consentPrompt').disabled=running;
  $('consentPublish').disabled=running;
  $('objective').disabled=running;
  $('replacePending').disabled=running;
  $('ownerMode').disabled=running;
  $('ownerKey').disabled=running||!$('ownerMode').checked;
  $('reload').disabled=disabled;
  $('openProviders').disabled=running||disabled;
  $('separateWindows').disabled=running||disabled;
  updateTimer();
  if(!running&&state.session?.endedReason)
    msg('Sessão encerrada ('+state.session.endedReason+'). Publicações confirmadas: '+summarizeSession(state.session).published+'.');
  else if(running)
    msg('Sessão ativa com '+Object.keys(state.session.entries||{}).length+' IA(s) · '+(state.session.autoPublish?'publicação automática autorizada':'revisão individual de publicações')+'.');
  paintTabs();paintEntries();paintMetrics();
}
function applySession(next){
  const prev=state.session;
  if(state.lastSync&&prev?.id===next?.id&&(Number(next?.revision)||0)<=(Number(prev?.revision)||0)){
    state.lastSync=Date.now();live();return;
  }
  recordTransitions(prev,next);
  // Consent applies only to the specific session in which it was granted.
  // When resuming an active session, mirror its actual authorization as read-only.
  if(next?.running&&(!prev?.running||prev?.id!==next.id)){
    $('consentPrompt').checked=true;
    $('consentPublish').checked=next.autoPublish===true;
    if(typeof next.objective==='string')$('objective').value=next.objective;
  }
  if(prev?.running&&!next?.running){
    $('consentPrompt').checked=false;
    $('consentPublish').checked=false;
    $('replacePending').checked=true;
    $('ownerMode').checked=false;
    $('ownerKey').value='';
  }
  state.session=next;state.lastSync=Date.now();live();
  paintState();
}
async function refreshState(){
  try{applySession(await api('AFB_STATE'));}
  catch(error){live(false);msg('Falha ao sincronizar: '+error.message,true);}
}
async function refreshTabs(){
  try{
    const tabs=await api('AFB_TABS');
    state.known=tabs;
    state.selected=new Set([...state.selected].filter(id=>tabs.some(t=>t.id===id)));
    if(!state.selectionInitialized){
      for(const tab of tabs.filter(t=>!t.discarded&&!t.frozen))state.selected.add(tab.id);
      state.selectionInitialized=true;
    }
    paintTabs();paintMetrics();
    $('start').disabled=!!state.session?.running||state.activeAction||!state.selected.size;
  }catch(error){msg('Não foi possível atualizar abas: '+error.message,true);}
}
async function focusProvider(id){
  try{
    const tab=await chrome.tabs.get(id);
    if(Number.isInteger(tab.windowId))await chrome.windows.update(tab.windowId,{focused:true});
    await chrome.tabs.update(id,{active:true});
  }catch(error){msg('Não foi possível ativar a janela: '+String(error?.message||error),true);}
}
$('reload').addEventListener('click',refreshTabs);
$('openProviders').addEventListener('click',async()=>{
  if(state.activeAction||state.session?.running)return;
  state.activeAction=true;paintState();
  let outcome;
  try{
    const result=await api('AFB_OPEN_PROVIDERS',{mode:$('separateWindows').checked?'windows':'tabs'});
    await refreshTabs();
    state.selected=new Set(result.tabIds.filter(id=>state.known.some(tab=>tab.id===id)));
    state.selectionInitialized=true;
    const opened=result.opened.length?result.opened.join(', '):'nenhuma';
    const reused=result.reused.length?result.reused.join(', '):'nenhuma';
    const failures=result.failures.length?' Falhas: '+result.failures.map(x=>x.provider+': '+x.error).join('; '):'';
    outcome={message:'Criadas: '+opened+'. Reutilizadas: '+reused+'. '+state.selected.size+' IA(s) selecionada(s). Faça login onde necessário e autorize os prompts.'+failures,error:!!result.failures.length};
    event('Organização de janelas solicitada para '+state.selected.size+' IA(s).');
  }catch(error){outcome={message:'Falha ao abrir as IAs: '+error.message,error:true};}
  finally{state.activeAction=false;paintState();if(outcome)msg(outcome.message,outcome.error);}
});
$('ownerMode').addEventListener('change',()=>{$('ownerKey').disabled=!$('ownerMode').checked||!!state.session?.running;});
$('start').addEventListener('click',async()=>{
  if(state.activeAction)return;
  if(!state.selected.size){msg('Selecione ao menos uma conversa.',true);return;}
  if(!$('consentPrompt').checked){msg('Autorize expressamente o envio dos prompts.',true);$('consentPrompt').focus();return;}
  state.activeAction=true;paintState();
  try{
    const started=await api('AFB_START_SESSION',{
      tabIds:[...state.selected],consentPrompt:$('consentPrompt').checked,
      autoPublish:$('consentPublish').checked,objective:$('objective').value,
      replacePending:$('replacePending').checked,ownerMode:$('ownerMode').checked,
      ownerKey:$('ownerMode').checked?$('ownerKey').value.trim():''
    });
    $('ownerKey').value='';
    applySession(started);
    event('Automação iniciada após consentimento do usuário.');
    $('operations').scrollIntoView({block:'start',behavior:'smooth'});
  }catch(error){msg('Falha ao iniciar: '+error.message,true);await refreshState();}
  finally{state.activeAction=false;paintState();}
});
$('stop').addEventListener('click',async()=>{
  if(!confirm('Interromper a sessão? Prompts já enviados às IAs não podem ser desfeitos.'))return;
  state.activeAction=true;paintState();
  try{applySession(await api('AFB_STOP_SESSION'));event('Sessão interrompida pelo usuário.','warning');await refreshTabs();}
  catch(error){msg(error.message,true);}
  finally{state.activeAction=false;paintState();}
});
$('inspect').addEventListener('click',async()=>{
  try{await api('AFB_INSPECT');await refreshState();event('Diagnóstico de respostas solicitado.');}
  catch(error){msg(error.message,true);}
});
paintActivity();
const disconnect=watchBridgeActivity({
  chromeApi:chrome,
  onSession:applySession,
  onTabs:()=>{refreshTabs().catch(()=>{});},
  onReconnect:()=>{refreshState().catch(()=>{});}
});
window.addEventListener('pagehide',disconnect,{once:true});
(async()=>{await refreshTabs();await refreshState();})();
setInterval(updateTimer,1000);
setInterval(()=>{if(document.visibilityState==='visible'&&Date.now()-state.lastSync>10000)refreshState();},12000);
