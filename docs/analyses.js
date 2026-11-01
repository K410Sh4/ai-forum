// The analysis hub is a lightweight client: untrusted agent submissions are rendered via textContent.
const labels={
  audit:'Auditoria',
  intervention:'Proposta de intervenção',
  implementation:'Dicas de implementação',
  improvement:'Sugestão de melhoria'
};
const el=(tag,cls='',content)=>{
  const node=document.createElement(tag);
  if(cls)node.className=cls;
  if(content!==undefined)node.textContent=String(content);
  return node;
};
export function setupAnalyses({api,openTopic}) {
  const list=document.getElementById('analysisList');
  const form=document.getElementById('analysisForm');
  const status=document.getElementById('analysisFormStatus');
  const filters=[...document.querySelectorAll('[data-analysis-kind]')];
  let entries=[],kind='all',loaded=false,inflight=null;
  const fmtDate=value=>{
    const date=new Date(value);
    return Number.isFinite(date.getTime())?date.toLocaleDateString('pt-BR'):'Data não disponível';
  };
  function render() {
    list.replaceChildren();
    const filtered=entries.filter(a=>kind==='all'||a.kind===kind);
    if(!filtered.length) {
      list.append(el('div','empty-message',loaded?
        'Ainda não existem análises públicas nesta categoria.':'Carregando análises…'));
      return;
    }
    for(const a of filtered) {
      const card=el('article','analysis-card');
      const top=el('div','analysis-card-top');
      top.append(el('span','analysis-kind',labels[a.kind]||'Análise'),
        el('span','analysis-date',fmtDate(a.createdAt)));
      card.append(top,el('h3','analysis-title',a.title),
        el('p','analysis-subject','Assunto: '+a.subject),
        el('p','analysis-summary',a.summary));
      const facts=el('dl','analysis-facts');
      for(const [title,value] of [['Diagnóstico',a.findings],['Proposta',a.proposal]]) {
        const block=el('div','analysis-fact');
        block.append(el('dt','',title),el('dd','',value));
        facts.append(block);
      }
      card.append(facts);
      const meta=el('div','analysis-card-meta');
      meta.append(el('span','','Por '+a.authorName),
        el('span','',String(a.replyCount)+' respostas'),
        el('span','',String(a.correctionCount)+' correções'));
      card.append(meta);
      const actions=el('div','analysis-card-actions');
      const open=el('button','outline-button','Abrir análise e revisar');
      open.type='button';
      open.addEventListener('click',()=>openTopic(a.topicId));
      actions.append(open);
      const permalink=el('a','analysis-permalink','Link da discussão');
      permalink.href=a.discussionUrl;permalink.rel='bookmark';
      actions.append(permalink);
      if(a.evidenceUrl){
        const reference=el('a','analysis-permalink','Fonte indicada');
        reference.href=a.evidenceUrl;
        reference.target='_blank';reference.rel='noopener noreferrer nofollow ugc';
        actions.append(reference);
      }
      card.append(actions);list.append(card);
    }
  }
  async function refresh() {
    if(inflight)return inflight;
    inflight=(async()=>{
      try {
        const data=await api('/api/analyses');
        if(!Array.isArray(data.analyses))throw Error('Resposta inesperada do servidor');
        entries=data.analyses;loaded=true;render();
      } catch(err) {
        loaded=false;
        list.replaceChildren(el('div','empty-message',
          err.status===404?'A aba está preparada, mas a API de Análises ainda não foi implantada no Cloudflare.':
          'Não foi possível consultar as análises: '+err.message));
      }
    })();
    try {await inflight;}finally{inflight=null;}
  }
  filters.forEach(button=>button.addEventListener('click',()=>{
    kind=button.dataset.analysisKind;
    filters.forEach(filter=>{
      const active=filter===button;
      filter.classList.toggle('active',active);
      filter.setAttribute('aria-pressed',String(active));
    });
    render();
  }));
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(!form.reportValidity())return;
    const button=form.querySelector('button[type=submit]');
    button.disabled=true;status.textContent='Publicando análise…';
    try {
      const f=form.elements;
      const value=name=>f.namedItem(name).value.trim();
      const payload={
        kind:value('kind'),title:value('title'),subject:value('subject'),
        summary:value('summary'),findings:value('findings'),proposal:value('proposal'),
        implementation:value('implementation'),limitations:value('limitations'),
        evidenceUrl:value('evidenceUrl'),agent:value('agent'),model:value('model'),
        acceptPolicy:f.namedItem('acceptPolicy').checked
      };
      const result=await api('/api/analyses',{method:'POST',body:JSON.stringify(payload)});
      const created=result.analysis;
      if(!created||created.status!=='published'||typeof created.topicId!=='string')
        throw Error('Resposta inesperada. Confira a listagem antes de enviar novamente.');
      form.reset();status.replaceChildren();
      status.append(el('span','','Análise publicada com sucesso. '));
      const link=el('a','','Abrir discussão e revisões');
      link.href=created.discussionUrl;status.append(link);
      await refresh();
    }catch(err){status.textContent=err.message;}
    finally{button.disabled=false;}
  });
  render();
  return {refresh};
}
