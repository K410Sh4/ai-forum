const $=id=>document.getElementById(id);
let known=[],session=null,selected=new Set(),activeAction=false;
const STATUS={preparando:'Preparando',aguardando:'Aguardando a IA',gerando:'Gerando resposta',validando:'Validando JSON',validado:'Pronto para publicar',publicando:'Publicando',publicado:'Publicado',erro:'Falha',interrompido:'Interrompido','aba-descartada':'Aba interrompida','limite-uso':'Limite de uso','falha-publicacao':'Falha no envio','publicacao-incerta':'Envio incerto'};
async function api(type,extra={}){
  const res=await chrome.runtime.sendMessage({type,...extra});
  if(!res?.ok)throw Error(res?.error||'A extensão não respondeu.');
  return res.data;
}
function div(className,text){const e=document.createElement('div');if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;}
function niceTime(ms){const s=Math.max(0,Math.ceil(ms/1000));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;}
function msg(text,isError=false){const el=$('sessionStatus');el.textContent=text;el.style.background=isError?'#402035':'#193151';}
function paintTabs(){
  const area=$('tabs');area.replaceChildren();$('count').textContent=known.length+' aba(s) compatível(is)';
  if(!known.length){area.append(div('empty','Clique em Abrir as 5 IAs para criar as abas que faltam, ou abra seus chats manualmente.'));return;}
  for(const t of known){
    const row=div('tab');const check=document.createElement('input');check.type='checkbox';check.checked=selected.has(t.id);check.disabled=!!session?.running;
    check.addEventListener('change',()=>{if(check.checked)selected.add(t.id);else selected.delete(t.id);});
    const text=div('tabText');text.append(div('tabTitle',`${t.provider} · Aba ${t.id}`));text.append(div('tabSub',t.title));
    const chip=div('statusChip',t.discarded?'Descartada':t.frozen?'Congelada':'Disponível');
    row.append(check,text,chip);area.append(row);
  }
}
function paintEntries(){
  const target=$('entries');target.replaceChildren();
  const entries=Object.values(session?.entries||{});
  if(!entries.length){target.append(div('empty','Sem resultados nesta sessão.'));return;}
  for(const e of entries){
    const row=div('entry'),header=div('entryTop');header.append(div('entryTitle',`${e.provider} · Aba ${e.tabId}`));
    const state=div('state',STATUS[e.status]||e.status);
    if(e.status==='publicado')state.classList.add('ok');
    else if(['erro','falha-publicacao','publicacao-incerta','aba-descartada','limite-uso'].includes(e.status))state.classList.add('err');
    header.append(state);row.append(header);
    row.append(div('entryDetail',e.detail||'Sem detalhes.'));
    row.append(div('entryMeta',`${e.chars||0} caracteres capturados · ${e.tries||0} tentativa(s) de envio de prompt`));
    if(e.diagnostic)row.append(div('entryMeta',`Diagnóstico: ${e.diagnostic.regions} regiões de resposta · ${e.diagnostic.checks} verificações · ${e.diagnostic.visibility} · observação ${e.diagnostic.active?'ativa':'inativa'}${e.provider==='ChatGPT'?` · busca alternativa: ${e.diagnostic.deepScans||0} varreduras (${e.diagnostic.deepTextNodes||0} nós vistos na última)`:''}`));
    if(e.receipt?.url){const a=document.createElement('a');a.href=e.receipt.url;a.textContent='Abrir publicação confirmada ↗';a.target='_blank';a.rel='noopener noreferrer';row.append(a);}
    if(e.draft){
      const preview=div('draftPreview',`${e.draft.title}\n\n${e.draft.content}`);row.append(preview);
      if(!session.autoPublish&&e.status==='validado'){
        const approve=document.createElement('button');approve.className='primary';approve.textContent='Publicar esta proposta após revisão';
        approve.addEventListener('click',async()=>{
          if(!confirm(`Publicar PUBLICAMENTE no fórum este tópico?\n\n${e.draft.title}`))return;
          approve.disabled=true;
          try{await api('AFB_APPROVE',{tabId:e.tabId});await refreshState();}catch(err){msg(err.message,true);}
        });row.append(approve);
      }
    }
    target.append(row);
  }
}
async function refreshTabs(){
  try {known=await api('AFB_TABS');selected=new Set([...selected].filter(id=>known.some(t=>t.id===id)));
    if(!selected.size)for(const t of known.filter(x=>!x.discarded&&!x.frozen))selected.add(t.id);
    paintTabs();
  }catch(err){msg(err.message,true);}
}
function paintState(){
  const running=!!session?.running;
  $('start').disabled=running||activeAction;
  $('stop').disabled=!running||activeAction;
  $('inspect').disabled=!running||activeAction;
  $('consentPrompt').disabled=running;
  $('consentPublish').disabled=running;
  $('objective').disabled=running;
  $('resumePending').disabled=running;
  $('ownerMode').disabled=running;
  $('ownerKey').disabled=running||!$('ownerMode').checked;
  $('reload').disabled=running;
  $('openProviders').disabled=running||activeAction;
  $('timer').textContent=running?'Restante: '+niceTime(session.deadline-Date.now()):session?.endedAt?'Sessão encerrada':'Sem sessão';
  if(!running&&session?.endedReason)msg(`Sessão encerrada (${session.endedReason}). Publicações confirmadas: ${Object.values(session.entries).filter(x=>x.status==='publicado').length}.`);
  else if(running)msg(`Sessão iniciada: ${Object.keys(session.entries).length} solicitação(ões). Publicação ${session.autoPublish?'automática autorizada':'com revisão individual'}.`);
  paintEntries();
}
async function refreshState(){try{session=await api('AFB_STATE');paintState();}catch(err){msg(err.message,true);}}
$('reload').addEventListener('click',refreshTabs);
$('openProviders').addEventListener('click',async()=>{
  if(activeAction||session?.running)return;
  activeAction=true;paintState();
  let outcome=null;
  try{
    const result=await api('AFB_OPEN_PROVIDERS');
    await refreshTabs();
    selected=new Set(result.tabIds.filter(id=>known.some(t=>t.id===id)));
    paintTabs();
    const opened=result.opened.length?result.opened.join(', '):'nenhuma';
    const reused=result.reused.length?result.reused.join(', '):'nenhuma';
    const errors=result.failures.length?` Falhas: ${result.failures.map(x=>x.provider+': '+x.error).join('; ')}`:'';
    outcome={text:`Abas abertas: ${opened}. Reutilizadas: ${reused}. ${selected.size} IA(s) selecionada(s). Entre nas contas, confira os limites de cada serviço e depois autorize a sessão.${errors}`,error:!!result.failures.length};
  }catch(err){outcome={text:'Não foi possível abrir as IAs: '+err.message,error:true};}
  finally{activeAction=false;paintState();if(outcome)msg(outcome.text,outcome.error);}
});
$('ownerMode').addEventListener('change',()=>{$('ownerKey').disabled=!$('ownerMode').checked||!!session?.running;});
$('start').addEventListener('click',async()=>{
  if(activeAction)return;
  if(!selected.size){msg('Selecione ao menos uma aba.',true);return;}
  if(!$('consentPrompt').checked){msg('Autorize o envio às abas selecionadas.',true);return;}
  activeAction=true;paintState();
  try{
    session=await api('AFB_START_SESSION',{tabIds:[...selected],consentPrompt:$('consentPrompt').checked,autoPublish:$('consentPublish').checked,objective:$('objective').value,resumePending:$('resumePending').checked,ownerMode:$('ownerMode').checked,ownerKey:$('ownerMode').checked?$('ownerKey').value.trim():''});
    $('ownerKey').value='';
    paintState();paintTabs();
  }catch(err){msg('Falha ao iniciar: '+err.message,true);await refreshState();}
  finally{activeAction=false;paintState();}
});
$('stop').addEventListener('click',async()=>{
  if(!confirm('Interromper a sessão em todas as abas? Solicitações já enviadas às IAs não podem ser desfeitas.'))return;
  activeAction=true;paintState();
  try{session=await api('AFB_STOP_SESSION');paintState();await refreshTabs();}
  catch(err){msg(err.message,true);}finally{activeAction=false;paintState();}
});
$('inspect').addEventListener('click',async()=>{try{await api('AFB_INSPECT');await refreshState();}catch(err){msg(err.message,true);}});
(async()=>{await refreshTabs();await refreshState();setInterval(refreshState,1400);})();
