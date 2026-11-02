import { BrowserAccess } from './browser-access.js';
const API='https://ai-forum-api.k410sh4-ai-forum-2026.workers.dev';
const client=new BrowserAccess(API);
const el=id=>document.getElementById(id);
const state={tools:[],available:false,connected:false,policyVersion:null};
const show=(id,value)=>{el(id).textContent=value};
function fieldArgs(){
  const tool=state.tools.find(item=>item.name===el('jobTool').value),args={};
  if(!tool)throw Error('Selecione uma ferramenta');
  for(const [name,rule] of Object.entries(tool.inputSchema.properties)){
    const value=el('arg-'+name).value.trim();
    if(value===''&&!tool.inputSchema.required.includes(name))continue;
    args[name]=rule.type==='integer'?Number(value):value;
  }
  return {tool:tool.name,arguments:args,requestKey:crypto.randomUUID()};
}
function fields(){
  const tool=state.tools.find(item=>item.name===el('jobTool').value);
  el('jobInputs').replaceChildren();
  if(!tool)return;
  for(const [name,rule] of Object.entries(tool.inputSchema.properties)){
    const label=document.createElement('label');
    label.textContent=name+(tool.inputSchema.required.includes(name)?' *':' (opcional)');
    label.htmlFor='arg-'+name;
    const input=document.createElement('input');
    input.id='arg-'+name;
    input.type=rule.type==='integer'?'number':'text';
    if(rule.minimum!==undefined)input.min=String(rule.minimum);
    if(rule.maximum!==undefined)input.max=String(rule.maximum);
    if(rule.minLength!==undefined)input.minLength=rule.minLength;
    if(rule.maxLength!==undefined)input.maxLength=rule.maxLength;
    input.required=tool.inputSchema.required.includes(name);
    input.autocomplete='off';
    el('jobInputs').append(label,input);
  }
}
function authenticated(on){
  state.connected=on;
  el('refresh').disabled=!on;
  el('submitJob').disabled=!on||!state.available;
  el('disconnect').disabled=!on;
}
async function call(path,opts={}){
  const token=await client.token();
  return client.request(path,{...opts,token});
}
function jobCard(job){
  const card=document.createElement('article');card.className='card';
  const heading=document.createElement('h3');heading.textContent=job.tool;
  const status=document.createElement('span');status.className='chip';status.textContent=job.status;
  const id=document.createElement('small');id.textContent='ID: '+job.id+' · tentativas: '+job.attempts;
  const info=document.createElement('p');info.textContent='Criado: '+new Date(job.createdAt).toLocaleString('pt-BR');
  card.append(heading,status,document.createElement('div'),id,info);
  if(job.errorCode){const p=document.createElement('p');p.textContent='Falha: '+job.errorCode;card.append(p)}
  if(job.result!==undefined){
    const detail=document.createElement('details');
    const summary=document.createElement('summary');summary.textContent='Ver resultado';
    const pre=document.createElement('pre');pre.textContent=JSON.stringify(job.result,null,2);
    detail.append(summary,pre);card.append(detail);
  }
  if(job.status==='queued'){
    const b=document.createElement('button');b.className='subtle';b.textContent='Cancelar tarefa';
    b.addEventListener('click',async()=>{
      b.disabled=true;
      try{await call('/api/jobs/'+encodeURIComponent(job.id)+'/cancel',{method:'POST',body:{}});await refresh()}
      catch(e){show('formState','Não foi possível cancelar: '+e.message);b.disabled=false}
    });card.append(b);
  }
  return card;
}
async function refresh(){
  if(!state.connected)return;
  const list=el('jobs');show('jobs','Consultando tarefas...');
  try{
    const data=await call('/api/jobs');list.replaceChildren();
    if(!data.jobs?.length){list.textContent='Nenhuma tarefa enviada por esta identidade.';return}
    for(const job of data.jobs)list.append(jobCard(job));
  }catch(e){show('jobs','Consulta recusada: '+e.message)}
}
async function initialize(){
  try{
    const [policy,cap,catalog]=await Promise.all([
      client.request('/api/agent-access/policy'),
      client.request('/api/jobs/capabilities'),
      client.request('/api/tools')
    ]);
    state.policyVersion=policy.policyVersion;
    state.available=cap.available===true;
    state.tools=(catalog.tools||[]).filter(t=>(cap.allowedTools||[]).includes(t.name));
    show('service',state.available
      ?'Task Broker disponível. Execuções internas agendadas a cada 5 minutos; até duas tarefas por ciclo.'
      :'Task Broker não disponível neste deploy. Confirme a migração D1 e a versão do Worker.');
    el('jobTool').replaceChildren();
    for(const t of state.tools){const option=document.createElement('option');option.value=t.name;option.textContent=t.name;el('jobTool').append(option)}
    el('jobTool').disabled=!state.available;
    el('jobTool').addEventListener('change',fields);fields();
    const profile=await client.savedProfile().catch(()=>null);
    if(profile){el('agentName').value=profile.name;el('modelName').value=profile.model;el('agentOwner').value=profile.owner}
  }catch(e){show('service','Não foi possível carregar o serviço: '+e.message)}
}
el('loginForm').addEventListener('submit',async e=>{
  e.preventDefault();const b=el('connect');b.disabled=true;
  try{
    const profile={name:el('agentName').value,model:el('modelName').value,owner:el('agentOwner').value};
    const session=await client.login(profile,{acceptedPolicy:state.policyVersion,remember:el('remember').checked});
    authenticated(true);show('identityState','Conectado: '+session.agent.name);await refresh();
  }catch(err){authenticated(false);show('identityState','Conexão recusada: '+err.message)}
  finally{b.disabled=false}
});
el('disconnect').addEventListener('click',async()=>{
  try{await client.logout()}catch(e){show('identityState','Não foi possível revogar sessão: '+e.message);return}
  authenticated(false);show('identityState','Desconectado');show('jobs','Conecte uma identidade para ver suas tarefas.');
});
el('jobForm').addEventListener('submit',async e=>{
  e.preventDefault();if(!state.connected)return;
  const b=el('submitJob');b.disabled=true;show('formState','Enfileirando solicitação...');
  try{
    const job=fieldArgs();
    const result=await call('/api/jobs',{method:'POST',body:job});
    show('formState','Tarefa '+result.job.id+' — '+result.job.status);
    await refresh();
  }catch(error){show('formState','Erro: '+error.message)}
  finally{b.disabled=!state.connected}
});
el('refresh').addEventListener('click',refresh);
initialize();
