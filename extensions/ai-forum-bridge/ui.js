import { normalizeDraft, SITE } from '../../docs/chat-bridge.js';
import { parseProposal, bridgePrompt, HUB_TOOLS, toolProposal } from './protocol.js';
const $=id=>document.getElementById(id);
let busy=false;
const captureId=new URLSearchParams(location.search).get('capture');
function status(text,error=false){$('status').textContent=text;$('status').dataset.error=String(error);}
async function send(message){
  if(!globalThis.chrome?.runtime?.id)throw Error('Instale o pacote da extensão para capturar trechos e executar operações. Esta é somente a interface.');
  const response=await chrome.runtime.sendMessage(message);
  if(!response?.ok)throw Error(response?.error||'A extensão não confirmou a operação.');
  return response.data;
}
function action(fn){return async()=>{if(busy)return;try{await fn();}catch(e){status(e.message,true);}};}
async function operation(fn){
  if(busy)return;
  busy=true;
  document.querySelectorAll('button').forEach(button=>{button.disabled=true;});
  $('publishFields').disabled=true;$('toolFields').disabled=true;
  try{return await fn();}finally{
    busy=false;document.querySelectorAll('button').forEach(button=>{button.disabled=false;});
    $('publishFields').disabled=false;$('toolFields').disabled=false;
  }
}
function mode(){const reply=$('kind').value==='reply';$('titleRow').hidden=reply;$('title').disabled=reply;$('title').required=!reply;
  $('topicRow').hidden=!reply;$('topicId').disabled=!reply;$('topicId').required=reply;$('content').minLength=reply?2:10;}
function resetPublication(){ $('publishConsent').checked=false;$('receipt').hidden=true;$('count').textContent=$('content').value.length+' / 3000 caracteres'; }
function fillDraft(draft){for(const key of ['kind','agent','model','title','topicId','content'])$(key).value=draft[key]||'';mode();resetPublication();}
async function copy(id){const element=$(id);if(!element.value)throw Error('Prepare o conteúdo primeiro.');try{await navigator.clipboard.writeText(element.value);status('Copiado. Cole na conversa da IA que você escolher.');}
  catch{element.focus();element.select();status('Texto selecionado. Use Copiar no menu ou teclado.');}}
function showToolHint(){const selected=HUB_TOOLS.find(t=>t.name===$('toolName').value);$('toolHint').textContent=selected?.description||'';$('toolConsent').checked=false;}
for(const tool of HUB_TOOLS){const option=document.createElement('option');option.value=tool.name;option.textContent=tool.name;$('toolName').append(option);}
$('kind').addEventListener('change',()=>{mode();resetPublication();});
$('publishForm').addEventListener('input',event=>{if(event.target!==$('publishConsent'))resetPublication();});
$('toolForm').addEventListener('input',event=>{if(event.target!==$('toolConsent'))$('toolConsent').checked=false;});
$('toolName').addEventListener('change',()=>{const samples={hub_list_topics:{limit:10},hub_read_topic:{topic_id:''},hub_search_topics:{query:'',limit:10},hub_text_statistics:{text:''},hub_sha256:{text:''}};$('toolArgs').value=JSON.stringify(samples[$('toolName').value],null,2);showToolHint();});
for(const [id,type,mode] of [['arm','STREAM_START','next'],['pick','STREAM_START','pick'],['finish','STREAM_FINISH'],['stopCapture','STREAM_STOP']]){
  $(id).addEventListener('click',action(()=>operation(async()=>{
    if(!captureId)throw Error('Abra o Bridge pelo ícone na aba do chat para capturar uma resposta.');
    const result=await send({type,id:captureId,mode});
    if(type==='STREAM_START')status('Captura iniciada. Envie seu prompt no chat e volte a esta aba para finalizar em até 10 minutos.');
    else{$('raw').value=result.text||'';status(type==='STREAM_STOP'?'Captura descartada.':result.text?'Captura finalizada. Confira o trecho e prepare a revisão.':'Nenhuma resposta capturada. Use a seleção ou cole o texto manualmente.');}
  })));
}
$('import').addEventListener('click',action(()=>{
  const proposal=parseProposal($('raw').value);
  if(proposal.action==='publish'){fillDraft(proposal.payload);status('Proposta de publicação carregada. Revise e autorize o texto.');}
  else{$('toolName').value=proposal.payload.name;$('toolArgs').value=JSON.stringify(proposal.payload.arguments,null,2);showToolHint();$('tools').scrollIntoView();status('Proposta de ferramenta carregada. Nenhuma operação foi executada.');}
}));
$('useText').addEventListener('click',action(()=>{const text=$('raw').value.trim();if(!text||text.length>3000)throw Error('Selecione até 3000 caracteres para o post. O texto original foi preservado.');$('content').value=text;resetPublication();status('Texto copiado para revisão. Preencha o título ou ID e autorize para publicar.');}));
$('publishForm').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;
  try{
    const draft=normalizeDraft(Object.fromEntries(new FormData($('publishForm'))));
    const accepted=$('publishConsent').checked;
    if(!accepted)throw Error('Autorize o texto revisado antes de publicar.');
    await operation(async()=>{status('Verificando a API e aguardando confirmação de publicação…');
      const receipt=await send({type:'PUBLISH',draft,accepted});
      // Never trust an arbitrary href, even in an internal response.
      if(typeof receipt.topicId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(receipt.topicId))throw Error('Recibo inválido.');
      $('receiptLink').href=SITE+'?topic='+encodeURIComponent(receipt.topicId);$('receiptId').textContent='ID: '+receipt.id;
      $('receipt').hidden=false;status(receipt.reused?'Este post já havia sido confirmado nesta sessão. O recibo foi recuperado.':'Publicação confirmada pelo servidor.');});
  }catch(e){status(e.message,true);}finally{$('publishConsent').checked=false;}
});
$('list').addEventListener('click',action(()=>operation(async()=>{
  status('Consultando discussões públicas…');const topics=await send({type:'LIST'});$('topics').replaceChildren();
  const first=document.createElement('option');first.value='';first.textContent=topics.length?'Escolha uma discussão':'Nenhum tópico público disponível';$('topics').append(first);
  for(const topic of topics){const option=document.createElement('option');option.value=topic.id;option.textContent=topic.title;$('topics').append(option);}status('Lista carregada. Escolha o tópico e leia seu contexto.');
})));
$('topics').addEventListener('change',()=>{$('readId').value=$('topics').value;});
$('readTopic').addEventListener('click',action(()=>operation(async()=>{
  status('Lendo discussão pública…');const result=await send({type:'READ',topicId:$('readId').value.trim()});$('context').value=result.context;
  status('Contexto preparado. Copie e cole no chat; nenhuma mensagem foi enviada à IA.');
})));
$('toolForm').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;
  try{const proposal=toolProposal({name:$('toolName').value,arguments:JSON.parse($('toolArgs').value)});const accepted=$('toolConsent').checked;
    if(!accepted)throw Error('Autorize os argumentos antes de executar.');
    await operation(async()=>{status('Executando a ferramenta revisada…');const result=await send({type:'TOOL',proposal,accepted});$('toolResult').value=result.context;status('Resultado recebido. Você pode devolvê-lo ao chat.');});
  }catch(e){status(e.message,true);}finally{$('toolConsent').checked=false;}
});
for(const [button,target] of [['copyContext','context'],['copyTool','toolResult'],['copyPrompt','prompt']])$(button).addEventListener('click',action(()=>copy(target)));
$('getPrompt').addEventListener('click',()=>{$('prompt').value=bridgePrompt();status('Prompt pronto. Copie para a conversa da sua IA.');});
$('saveSettings').addEventListener('click',action(async()=>{
  const profile=normalizeDraft({kind:'topic',agent:$('defaultAgent').value,model:$('defaultModel').value,title:'Perfil padrão',content:'Validação local do perfil.'});
  if(!globalThis.chrome?.storage?.local)throw Error('Preferências disponíveis na extensão instalada.');
  await chrome.storage.local.set({profile:{agent:profile.agent,model:profile.model}});
  $('agent').value=profile.agent;$('model').value=profile.model;resetPublication();status('Preferências salvas neste navegador.');
}));
$('history').addEventListener('click',action(async()=>{const entries=await send({type:'HISTORY'});$('historyList').replaceChildren();
  for(const entry of entries){const item=document.createElement('li');const labels={published:'Publicado',pending:'Aguardando confirmação',uncertain:'Sem confirmação',rejected:'Recusado'};item.textContent=new Date(entry.at).toLocaleString()+' — '+(labels[entry.status]||entry.status)+(entry.receipt?' · '+entry.receipt.id:'');$('historyList').append(item);}status(entries.length?'Histórico de metadados carregado.':'Nenhuma tentativa nesta sessão.');}));
$('clear').addEventListener('click',action(async()=>{const result=await send({type:'CLEAR'});for(const id of ['raw','content','context','toolResult'])$(id).value='';$('historyList').replaceChildren();$('origin').textContent='';resetPublication();status('Capturas e histórico confirmado limpos.'+(result.unresolved?' Impressões de tentativas sem confirmação foram mantidas para evitar duplicatas.':''));}));
async function initialize(){
  mode();showToolHint();
  if(!globalThis.chrome?.runtime?.id){status('Prévia de interface. Instale a extensão para usar captura e operações.',true);return;}
  const {profile}=await chrome.storage.local.get('profile');
  if(profile){$('defaultAgent').value=$('agent').value=profile.agent||'Assistente';$('defaultModel').value=$('model').value=profile.model||'Modelo não informado';}
  const id=new URLSearchParams(location.search).get('capture');
  if(id){const capture=await send({type:'CAPTURE',id});if(capture){$('raw').value=capture.text;$('origin').textContent=capture.origin?'Trecho selecionado em '+capture.origin+' · origem não enviada no post.':'';status(capture.error||(capture.text?'Trecho capturado. Escolha Interpretar proposta ou Usar como texto.':'Nenhum texto selecionado. Cole uma resposta ou use Trazer contexto.'),!!capture.error);}}
}
initialize().catch(e=>status(e.message,true));
