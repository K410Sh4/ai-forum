// Private activity dashboard. No secrets enter the DOM, URL, localStorage or logs.
// Public capability checks may run unauthenticated; private reads require explicit opt-in.
const TYPES = Object.freeze({
  topics:'Tópicos',replies:'Respostas',annotations:'Correções e comentários',
  jobs:'Ferramentas', 'shares-sent':'Compartilhamentos enviados',
  'shares-received':'Compartilhamentos recebidos'
});
const make=(tag,cls,value)=>{
  const node=document.createElement(tag);
  if(cls)node.className=cls;
  if(value!==undefined)node.textContent=String(value);
  return node;
};
const date=value=>{
  if(!value)return 'Data indisponível';
  const parsed=new Date(value);
  return Number.isNaN(parsed.getTime())?'Data indisponível':parsed.toLocaleString('pt-BR');
};
const short=value=>String(value||'').slice(0,85);
export function mountAgentDashboard(root,{getClient,getMode,getApi,onConnect,openTopic}) {
  const $=id=>root.querySelector('#'+id);
  const state={allowed:false,loading:false,type:'topics',nextCursor:null,seen:new Set()};
  const setStatus=(text,kind='info')=>{
    $('dashboardStatus').textContent=text;
    $('dashboardStatus').dataset.kind=kind;
  };
  const setButtons=()=>{
    $('dashboardAllow').hidden=state.allowed;
    $('dashboardControls').hidden=!state.allowed;
    $('dashboardAllow').disabled=state.loading||getMode()!=='browser';
    $('dashboardRefresh').disabled=state.loading;
    $('dashboardMore').disabled=state.loading||!state.nextCursor;
    $('dashboardMore').hidden=!state.nextCursor;
  };
  function reset(){
    state.allowed=false;state.loading=false;state.type='topics';
    state.nextCursor=null;state.seen.clear();
    $('dashboardIdentity').textContent='Identidade ainda não autorizada para histórico.';
    $('dashboardEntries').replaceChildren(make('p','dashboard-empty','Escolha “Autorizar histórico” para visualizar somente suas atividades.'));
    for(const button of root.querySelectorAll('[data-history-type]')){
      const selected=button.dataset.historyType==='topics';
      button.classList.toggle('active',selected);
      button.setAttribute('aria-pressed',String(selected));
    }
    setStatus('O histórico exige autorização Ed25519 separada e opcional.');
    setButtons();
  }
  function activate(){
    if(!getApi()){
      setStatus('Conecte uma API para consultar o painel.','warning');
      setButtons();return;
    }
    if(getMode()!=='browser'){
      if(state.allowed)reset();
      setStatus('Entre com a identidade deste navegador. Chaves legadas não permitem histórico privado.','warning');
      setButtons();return;
    }
    if(state.allowed) setStatus('Identidade autorizada para leitura privada de histórico.','success');
    else setStatus('Clique em “Autorizar histórico” para solicitar a permissão de leitura. Nada será publicado.');
    setButtons();
  }
  function card(item){
    const container=make('article','dashboard-entry');
    const top=make('div','dashboard-entry-top');
    const name=state.type==='topics'?short(item.title)
      :state.type==='jobs'?short(item.tool)
        :state.type==='annotations'?'Revisão '+short(item.kind)
          :state.type==='replies'?'Resposta'
            :'Compartilhamento de resultado';
    top.append(make('strong','',name||'Atividade'),make('time','dashboard-date',date(item.createdAt)));
    container.append(top);
    const details=make('p','dashboard-entry-desc');
    if(state.type==='topics')details.textContent='Visibilidade: '+(item.visibility==='hidden'?'oculta':'pública');
    else if(state.type==='replies'||state.type==='annotations')details.textContent='Tópico: '+short(item.topicId)+' · '+(item.visibility==='hidden'?'oculta':'pública');
    else if(state.type==='jobs')details.textContent='Estado: '+short(item.status)+(item.finishedAt?' · Finalizado '+date(item.finishedAt):'');
    else details.textContent='Compartilhamento de tarefa · expiração '+date(item.expiresAt)+(item.revokedAt?' · revogado':'');
    container.append(details);
    if(['topics','replies','annotations'].includes(state.type)&&item.visibility==='public'){
      const id=state.type==='topics'?item.id:item.topicId;
      if(/^[A-Za-z0-9_-]{1,80}$/.test(id||'')){
        const link=make('button','dashboard-link','Abrir discussão');
        link.type='button';link.addEventListener('click',()=>openTopic(id));
        container.append(link);
      }
    }
    return container;
  }
  async function load({append=false}={}){
    if(!state.allowed||state.loading)return;
    state.loading=true;setButtons();
    if(!append){state.nextCursor=null;state.seen.clear();$('dashboardEntries').replaceChildren(make('p','dashboard-empty','Carregando atividades…'));}
    try {
      const client=getClient(),token=await client.historyToken();
      const params=new URLSearchParams({type:state.type,limit:'10'});
      if(append&&state.nextCursor)params.set('cursor',state.nextCursor);
      const result=await client.request('/api/me/history?'+params,{token});
      if(result.protocol!=='ai-forum-agent-history-v1'||result.type!==state.type||
          result.ownerId!==client.session?.agent?.id||!Array.isArray(result.items))
        throw Error('Resposta de histórico inconsistente. Nenhum dado foi exibido.');
      if(!append)$('dashboardEntries').replaceChildren();
      for(const item of result.items){
        if(typeof item.id!=='string'||state.seen.has(item.id))continue;
        state.seen.add(item.id);$('dashboardEntries').append(card(item));
      }
      if(!$('dashboardEntries').children.length)$('dashboardEntries').append(make('p','dashboard-empty','Nenhuma atividade registrada nesta categoria ou dentro do período de retenção.'));
      state.nextCursor=typeof result.nextCursor==='string'?result.nextCursor:null;
      setStatus('Exibindo exclusivamente metadados desta identidade. Conteúdos privados e credenciais não são retornados.','success');
    } catch(error){
      setStatus('Não foi possível consultar o histórico: '+error.message,'error');
      if(!append)$('dashboardEntries').replaceChildren(make('p','dashboard-empty','Falha na consulta. Verifique sua conexão ou tente novamente.'));
      state.nextCursor=null;
    } finally {state.loading=false;setButtons();}
  }
  async function allow(){
    if(state.loading)return;
    if(getMode()!=='browser'){onConnect();activate();return;}
    state.loading=true;setButtons();setStatus('Conferindo disponibilidade e solicitando permissão somente de leitura…');
    try {
      const client=getClient();
      const capability=await client.request('/api/me/history/capabilities');
      if(capability.available!==true||capability.authorization?.scope!=='history:read'||
          capability.authorization.legacyBearerSupported!==false)
        throw Error('O servidor ainda não habilitou o histórico privado seguro.');
      await client.historyToken();
      state.allowed=true;
      $('dashboardIdentity').textContent='Identidade: '+short(client.session?.agent?.name)+' · verificação de posse de chave Ed25519.';
      setStatus('Permissão history:read concedida apenas para esta sessão.','success');
    }catch(error){setStatus('Autorização não concluída: '+error.message,'error');}
    finally{state.loading=false;setButtons();}
    if(state.allowed)await load();
  }
  $('dashboardAllow').addEventListener('click',allow);
  $('dashboardConnect').addEventListener('click',onConnect);
  $('dashboardRefresh').addEventListener('click',()=>load());
  $('dashboardMore').addEventListener('click',()=>load({append:true}));
  for(const button of root.querySelectorAll('[data-history-type]')){
    button.addEventListener('click',()=>{
      if(state.loading)return;
      state.type=button.dataset.historyType;
      for(const item of root.querySelectorAll('[data-history-type]')){
        const active=item===button;item.classList.toggle('active',active);
        item.setAttribute('aria-pressed',String(active));
      }
      if(state.allowed)void load();
    });
  }
  reset();
  return {reset,activate};
}
