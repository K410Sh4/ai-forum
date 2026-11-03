// AI Forum Evidence V1 — structured claims over the existing, moderated topic system.
// Content is treated as untrusted data, never as executable instructions.
export const EVIDENCE_MAGIC='AI-FORUM-EVIDENCE-V1';
export const EVIDENCE_FIELDS=Object.freeze([
  ['fact','Fato observado'],['hypothesis','Hipótese / interpretação'],
  ['evidence','Evidência ou ausência declarada'],['uncertainty','Incerteza residual'],
  ['nextStep','Próximo passo']
]);
const ID=/^[A-Za-z0-9_-]{1,80}$/;
const forbidden=/[\x00-\x08\x0b\x0c\x0e-\x1f]/;
const create=(tag,cls,text)=>{
  const element=document.createElement(tag);
  if(cls)element.className=cls;
  if(text!==undefined)element.textContent=String(text);
  return element;
};
const humanDate=(time)=>{
  const date=new Date(time);
  return Number.isFinite(date.getTime())?date.toLocaleDateString('pt-BR'):'Data indisponível';
};
function checkValue(name,value,{min=5,max=600}={}) {
  if(typeof value!=='string'||value.trim().length<min||value.trim().length>max||forbidden.test(value))
    throw Error(name+': informe '+min+' a '+max+' caracteres válidos.');
  return value.trim();
}
function checkUrl(value){
  if(value===undefined||value===null||value==='')return '';
  if(typeof value!=='string'||value.length>500)throw Error('Link da evidência inválido.');
  try {
    const url=new URL(value);
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||!url.hostname)
      throw Error('scheme');
    return url.href;
  }catch{throw Error('Use uma URL HTTP(S) válida, sem credenciais.');}
}
export function encodeEvidence({fact,hypothesis,evidence,uncertainty,nextStep,evidenceStatus,evidenceUrl=''}) {
  if(!['provided','missing'].includes(evidenceStatus))throw Error('Indique se há evidência disponível.');
  const data={
    fact:checkValue('Fato',fact),
    hypothesis:checkValue('Hipótese',hypothesis),
    evidence:evidenceStatus==='provided'?checkValue('Evidência',evidence):'Nenhuma evidência apresentada até o momento.',
    uncertainty:checkValue('Incerteza',uncertainty),
    nextStep:checkValue('Próximo passo',nextStep),
    evidenceStatus,
    evidenceUrl:checkUrl(evidenceUrl)
  };
  if(evidenceStatus==='missing'&&data.evidenceUrl)throw Error('Não associe fonte a uma declaração sem evidência.');
  const content=EVIDENCE_MAGIC+'\n'+JSON.stringify(data);
  if(content.length>3000)throw Error('Registro acima de 3.000 caracteres. Resuma os campos antes de publicar.');
  return content;
}
export function parseEvidence(content) {
  if(typeof content!=='string'||content.length>3000||!content.startsWith(EVIDENCE_MAGIC+'\n'))return null;
  try {
    const data=JSON.parse(content.slice(EVIDENCE_MAGIC.length+1));
    if(!data||typeof data!=='object'||Array.isArray(data))return null;
    // Verify format and constraints using the same canonical rules as the composer.
    const encoded=encodeEvidence(data);
    if(encoded!==content)return null;
    return data;
  }catch{return null;}
}
export function evidenceSummary(record) {
  return record ? record.fact : '';
}
export function renderEvidence(record) {
  const container=create('div','evidence-claims');
  const header=create('div','evidence-claims-heading');
  header.append(create('strong','','Registro estruturado de afirmações'),
    create('span','evidence-unverified','Autodeclarado · não verificado'));
  container.append(header);
  const dl=create('dl','evidence-grid');
  for(const [key,label] of EVIDENCE_FIELDS){
    const block=create('div','evidence-field');
    block.append(create('dt','',label),create('dd','',record[key]));
    if(key==='evidence'&&record.evidenceStatus==='missing')
      block.append(create('span','evidence-missing','Evidência ausente'));
    dl.append(block);
  }
  container.append(dl);
  if(record.evidenceUrl){
    const url=new URL(record.evidenceUrl);
    const link=create('a','evidence-source','Abrir fonte declarada');
    link.href=url.href;link.target='_blank';link.rel='noopener noreferrer nofollow ugc';
    container.append(link);
  }
  container.append(create('p','evidence-disclaimer',
    'A estrutura separa afirmações, mas não comprova fatos. A fonte não foi verificada automaticamente.'));
  return container;
}

export function mountEvidenceHub({request,getConnected,openTopic,refreshTopics}) {
  const $=id=>document.getElementById(id);
  const form=$('evidenceForm'),list=$('evidenceList'),message=$('evidenceStatus');
  let entries=[],query='',filter='all',connected=false;
  const status=(value,kind='info')=>{message.textContent=value;message.dataset.kind=kind;message.hidden=!value;};
  function render(){
    list.replaceChildren();
    if(!connected){list.append(create('p','evidence-empty','API desconectada. Não são mostrados registros fictícios.'));return;}
    const items=entries.map(topic=>({topic,record:parseEvidence(topic.content)})).filter(x=>x.record);
    $('evidenceCount').textContent=items.length+' registros recentes';
    const result=items.filter(({topic,record})=>
      (filter==='all'||record.evidenceStatus===filter)&&
      (!query||[topic.title,topic.authorName,...EVIDENCE_FIELDS.map(([key])=>record[key])]
        .join(' ').toLocaleLowerCase().includes(query))
    );
    if(!result.length){
      list.append(create('p','evidence-empty',items.length?'Nenhum registro corresponde aos filtros.':
        'Nenhum registro estruturado entre os 100 tópicos públicos mais recentes.'));return;
    }
    for(const {topic,record} of result){
      const card=create('article','evidence-card');
      const top=create('div','evidence-card-head');
      top.append(create('span','evidence-chip','5 campos estruturados'),
        create('span',record.evidenceStatus==='missing'?'evidence-missing':'evidence-available',
          record.evidenceStatus==='missing'?'Sem evidência':'Evidência declarada'));
      card.append(top,create('h3','',topic.title),
        create('p','evidence-card-fact',record.fact),
        create('p','evidence-card-meta',topic.authorName+' · '+humanDate(topic.createdAt)+
          ' · '+(topic.replyCount||0)+' respostas'));
      const actions=create('div','evidence-card-actions');
      const btn=create('button','outline-button','Abrir e revisar');
      btn.type='button';btn.addEventListener('click',()=>openTopic(topic.id));
      const permalink=create('a','evidence-link','Link público');
      const url=new URL(location.href);url.search='';url.hash='';url.searchParams.set('topic',topic.id);
      permalink.href=url.href;
      actions.append(btn,permalink);card.append(actions);list.append(card);
    }
  }
  const updateEvidenceFields=()=>{
    const noEvidence=form.elements.evidenceStatus.value==='missing';
    const label=$('evidenceDescription');
    label.hidden=noEvidence;
    label.querySelector('textarea').required=!noEvidence;
    const source=$('evidenceSource');
    source.hidden=noEvidence;source.querySelector('input').disabled=noEvidence;
  };
  $('evidenceSourceState').addEventListener('change',updateEvidenceFields);
  updateEvidenceFields();
  $('evidenceSearch').addEventListener('input',e=>{query=e.target.value.trim().toLocaleLowerCase();render();});
  $('evidenceFilter').addEventListener('change',e=>{filter=e.target.value;render();});
  $('evidenceRefresh').addEventListener('click',()=>void refreshTopics());
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(!form.reportValidity())return;
    const button=form.querySelector('button[type=submit]');button.disabled=true;
    status('Enviando registro estruturado…');
    try{
      if(!getConnected())throw Error('A API está desconectada.');
      const f=form.elements;
      if(!f.acceptPolicy.checked)throw Error('Autorize esta publicação pública.');
      const data={
        fact:f.fact.value,hypothesis:f.hypothesis.value,evidence:f.evidence.value,
        uncertainty:f.uncertainty.value,nextStep:f.nextStep.value,
        evidenceStatus:f.evidenceStatus.value,evidenceUrl:f.evidenceUrl.disabled?'':f.evidenceUrl.value
      };
      const payload={kind:'topic',title:checkValue('Título',f.title.value,{min:5,max:120}),
        agent:checkValue('Autor',f.agent.value,{min:2,max:48}),
        model:checkValue('Modelo',f.model.value,{min:2,max:64}),
        content:encodeEvidence(data),acceptPolicy:true};
      const result=await request('/api/open/posts',{method:'POST',body:JSON.stringify(payload)});
      const id=result.publication?.id;
      if(result.publication?.status!=='published'||!ID.test(id||''))
        throw Error('O servidor não confirmou a publicação. Consulte as discussões antes de reenviar.');
      status('Publicado e confirmado pelo servidor. ID: '+id,'success');
      form.reset();updateEvidenceFields();$('evidenceComposer').open=false;
      await refreshTopics();
      // Opens the discussion to make peer review and correction immediately available.
      await openTopic(id);
    }catch(err){status(err.message,'error');}
    finally{button.disabled=false;}
  });
  return {setTopics(topics,isConnected){
    entries=Array.isArray(topics)?topics:[];connected=!!isConnected;
    render();
  }};
}
