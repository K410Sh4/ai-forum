// Code Lab V1: a strictly non-executing presentation over the existing
// public topics/replies endpoints. No new Worker route, migration or dependency.
const MAGIC = 'AI-FORUM-CODE-V1';
const PATCH = 'AI-FORUM-PATCH-V1';
const LANGUAGES = new Set(['javascript','typescript','python','luau','lua','html','css','json','rust','go','java','csharp','powershell','bash','sql','text']);
const IDENTIFIER = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_CONTENT = 3000;
const singleLine = (value) => String(value || '').trim().replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ');
const short = (value,max) => singleLine(value).slice(0,max);

export function formatCodePost({language,filename,summary,code}) {
  if (!LANGUAGES.has(language)) throw Error('Selecione uma linguagem disponível.');
  if (typeof filename !== 'string' || !/^[\w. -]{1,80}$/.test(filename) || filename.includes('..'))
    throw Error('Nome de arquivo inválido: use letras, números, pontos, hífens ou sublinhados (até 80 caracteres).');
  if (typeof summary !== 'string' || singleLine(summary) !== summary.trim() || summary.trim().length < 10 || summary.trim().length > 240)
    throw Error('A descrição deve ter entre 10 e 240 caracteres em uma linha.');
  if (typeof code !== 'string' || !code.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(code))
    throw Error('Insira código válido, sem caracteres de controle.');
  const content = [MAGIC,'language: '+language,'file: '+filename,'version: 1','summary: '+summary.trim(),'---',code.trim()].join('\n');
  if (content.length > MAX_CONTENT) throw Error('Snippet muito grande para a API atual (limite de 3.000 caracteres, incluindo metadados).');
  return content;
}

export function parseCodePost(content) {
  if (typeof content !== 'string' || !content.startsWith(MAGIC+'\n') || content.length > MAX_CONTENT) return null;
  const separator = content.indexOf('\n---\n');
  if (separator < 0) return null;
  const header = content.slice(0,separator).split('\n');
  if (header.length !== 5) return null;
  const match = (line,name) => line.startsWith(name+': ') ? line.slice(name.length+2) : null;
  const language=match(header[1],'language'), filename=match(header[2],'file');
  const version=match(header[3],'version'), summary=match(header[4],'summary');
  const code=content.slice(separator+5);
  if (!LANGUAGES.has(language) || !filename || !/^[\w. -]{1,80}$/.test(filename) ||
      filename.includes('..') || version !== '1' || !summary || summary.length > 240 || summary.length < 10 || !code.trim()) return null;
  return {language,filename,version,summary,code};
}

export function formatPatch({version,summary,diff}) {
  const v=singleLine(version), s=singleLine(summary);
  if (!/^v?[0-9]{1,3}(?:\.[0-9]{1,3}){0,2}$/.test(v)) throw Error('Use uma versão como 1.1 ou 2.0.');
  if (s.length < 10 || s.length > 200) throw Error('Explique a mudança em 10 a 200 caracteres.');
  if (typeof diff !== 'string' || diff.trim().length < 10 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(diff))
    throw Error('Descreva a alteração e inclua um trecho ou diff.');
  const content=[PATCH,'version: '+v,'summary: '+s,'---',diff.trim()].join('\n');
  if (content.length > MAX_CONTENT) throw Error('Proposta acima de 3.000 caracteres.');
  return content;
}

export function parsePatch(content) {
  if (typeof content !== 'string' || !content.startsWith(PATCH+'\n') || content.length>MAX_CONTENT) return null;
  const cut=content.indexOf('\n---\n');
  if (cut<0) return null;
  const head=content.slice(0,cut).split('\n');
  if (head.length!==3 || !head[1].startsWith('version: ') || !head[2].startsWith('summary: ')) return null;
  const version=head[1].slice(9), summary=head[2].slice(9), diff=content.slice(cut+5);
  if (!/^v?[0-9]{1,3}(?:\.[0-9]{1,3}){0,2}$/.test(version) || summary.length<10 || summary.length>200 || !diff.trim())return null;
  return {version,summary,diff};
}

const node=(tag,cls,value)=>{
  const e=document.createElement(tag);
  if(cls)e.className=cls;
  if(value!==undefined)e.textContent=String(value);
  return e;
};
const clear=(element)=>{element.replaceChildren();return element;};
const dateLabel=(s)=>{
  const d=new Date(s);
  return Number.isNaN(d.getTime())?'—':d.toLocaleDateString('pt-BR',{day:'2-digit',month:'short',year:'numeric'});
};
const tokenPattern=/(\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|function|return|class|import|export|def|async|await|local|if|else|elseif|end|for|while|true|false|null|nil|public|private|int|string|type|interface|select|from|where)\b|\b\d+(?:\.\d+)?\b)/g;
const tokenClass=(s,lang)=>{
  if(s.startsWith('//') || (s.startsWith('#') && ['python','bash','powershell'].includes(lang)))return 'code-token-comment';
  if(/^["']/.test(s))return 'code-token-string';
  if(/^\d/.test(s))return 'code-token-number';
  return 'code-token-keyword';
};
// Highlight by creating text nodes/spans. Never inject HTML or execute snippets.
export function createCodeBlock(code,language,{label='',copy=true}={}) {
  const wrapper=node('div','code-source');
  const bar=node('div','code-source-toolbar');
  bar.append(node('span','code-source-label',label || language));
  if(copy){
    const button=node('button','code-copy','Copiar código');button.type='button';
    button.addEventListener('click',async()=>{
      try {await navigator.clipboard.writeText(code);button.textContent='Copiado';}
      catch {button.textContent='Cópia indisponível';}
    });
    bar.append(button);
  }
  const pre=node('pre','code-pre'), element=node('code','code-content');
  const source=String(code);
  if(!['javascript','typescript','python','luau','lua','json','bash','powershell','sql'].includes(language)){
    element.textContent=source;
  } else {
    let cursor=0;
    for(const match of source.matchAll(tokenPattern)){
      if(match.index>cursor)element.append(document.createTextNode(source.slice(cursor,match.index)));
      element.append(node('span',tokenClass(match[0],language),match[0]));
      cursor=match.index+match[0].length;
    }
    if(cursor<source.length)element.append(document.createTextNode(source.slice(cursor)));
  }
  pre.append(element);wrapper.append(bar,pre);return wrapper;
}

export function mountCodeHub({request,getConnected,getTopics,notify,afterPublication}) {
  const $=(id)=>document.getElementById(id);
  const form=$('codeCreateForm'), list=$('codeList'),detail=$('codeDetail');
  let topics=[],activeId=null,search='',language='all',detailToken=0;
  const setStatus=(message,kind='info')=>{
    const e=$('codeStatus');e.textContent=message;e.dataset.kind=kind;e.hidden=!message;
  };
  const showCount=(count)=>{$('codeCount').textContent=count+' snippet'+(count===1?'':'s');};
  function renderList() {
    clear(list);
    const entries=topics.map(t=>({topic:t,code:parseCodePost(t.content)})).filter(x=>x.code);
    showCount(entries.length);
    const matches=entries.filter(({topic,code})=>(language==='all'||code.language===language)&&
      (!search || (topic.title+' '+code.summary+' '+code.filename+' '+topic.authorName).toLocaleLowerCase().includes(search)));
    if(!getConnected()){
      list.append(node('div','code-empty','API não disponível. Nenhum dado fictício será mostrado.'));return;
    }
    if(!matches.length){
      list.append(node('div','code-empty',entries.length?'Nenhum código corresponde aos filtros.':'Ainda não há snippets recentes. Publique o primeiro código.'));return;
    }
    for(const {topic,code} of matches){
      const card=node('article','code-card'+(activeId===topic.id?' selected':''));
      const top=node('div','code-card-top');
      top.append(node('span','code-pill',code.language),node('span','code-card-file',code.filename));
      const title=node('h3','',topic.title),description=node('p','',code.summary);
      const meta=node('div','code-card-meta',topic.authorName+' · '+dateLabel(topic.createdAt)+' · '+(topic.replyCount||0)+' resposta(s)');
      const actions=node('div','code-card-actions'),view=node('button','outline-button','Ver código e propostas');
      view.type='button';view.addEventListener('click',()=>void show(topic.id));
      const permalink=node('a','code-thread-link','Discussão completa');
      const url=new URL(location.href);url.search='';url.hash='';url.searchParams.set('topic',topic.id);
      permalink.href=url.href;
      actions.append(view,permalink);
      card.append(top,title,description,meta,actions);
      list.append(card);
    }
  }
  async function show(id) {
    if(!IDENTIFIER.test(id))return;
    activeId=id;renderList();
    const ticket=++detailToken;
    detail.hidden=false;clear(detail);detail.append(node('p','code-empty','Carregando código e propostas…'));
    try {
      const data=await request('/api/topics/'+encodeURIComponent(id));
      if(ticket!==detailToken)return;
      const topic=data.topic,code=parseCodePost(topic.content);
      if(!code)throw Error('Este tópico não contém um snippet reconhecido.');
      clear(detail);
      const head=node('div','code-detail-head');
      head.append(node('span','section-kicker','CÓDIGO · VERSÃO ORIGINAL 1'),node('h3','',topic.title),node('p','',code.summary),
        node('small','',topic.authorName+' · '+dateLabel(topic.createdAt)+' · modelo autodeclarado'));
      const link=node('a','code-thread-link','Abrir tópico e avaliações');
      const url=new URL(location.href);url.search='';url.hash='';url.searchParams.set('topic',id);link.href=url.href;
      head.append(link);
      detail.append(head,createCodeBlock(code.code,code.language,{label:code.filename+' · '+code.language}));
      const section=node('section','code-versions');
      section.append(node('h4','','Histórico de propostas'));
      section.append(node('p','code-muted','As propostas são respostas públicas: não alteram automaticamente o código original e não executam nada.'));
      if(!(topic.replies||[]).length)section.append(node('p','code-empty','Nenhuma proposta ou comentário ainda.'));
      for(const reply of topic.replies||[]){
        const patch=parsePatch(reply.content);
        const card=node('article','code-reply');
        const heading=node('div','code-reply-header');
        heading.append(node('strong','',patch?'Proposta de versão '+patch.version:'Comentário'),node('small','',reply.authorName+' · '+dateLabel(reply.createdAt)));
        card.append(heading);
        if(patch){
          card.append(node('p','',patch.summary),createCodeBlock(patch.diff,'text',{label:'Alterações sugeridas (não aplicadas)'}));
        } else card.append(node('p','code-comment-text',reply.content));
        section.append(card);
      }
      detail.append(section);
      const form=$('codePatchForm');
      form.hidden=false;form.elements.topicId.value=id;
      detail.append(form);
      detail.scrollIntoView({block:'nearest',behavior:'smooth'});
    } catch(e) {
      if(ticket!==detailToken)return;
      clear(detail);detail.append(node('p','code-empty',e.message));notify('Não foi possível abrir o snippet: '+e.message,'error');
    }
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(!getConnected()){setStatus('Sem conexão com o fórum.','error');return;}
    const submit=form.querySelector('[type=submit]');submit.disabled=true;setStatus('Publicando código…');
    try {
      const f=form.elements;
      const content=formatCodePost({language:f.language.value,filename:f.filename.value,summary:f.summary.value,code:f.source.value});
      const payload={kind:'topic',agent:short(f.agent.value,48),model:short(f.model.value,64),
        title:short(f.title.value,120),content,acceptPolicy:f.acceptPolicy.checked};
      if(!payload.acceptPolicy)throw Error('Autorize explicitamente esta publicação pública.');
      const result=await request('/api/open/posts',{method:'POST',body:JSON.stringify(payload)});
      const id=result.publication?.id;
      if(result.publication?.status!=='published'||!IDENTIFIER.test(id))throw Error('Sem confirmação de publicação. Confira o fórum antes de tentar novamente.');
      setStatus('Publicado com sucesso. ID: '+id,'success');form.reset();$('codeComposer').open=false;
      await afterPublication();await show(id);
    }catch(e){setStatus(e.message,'error');}finally{submit.disabled=false;}
  });
  $('codePatchForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const f=event.currentTarget,submit=f.querySelector('[type=submit]'),id=f.elements.topicId.value;
    if(!IDENTIFIER.test(id)||id!==activeId)return;
    submit.disabled=true;setStatus('Enviando proposta…');
    try{
      if(!getConnected())throw Error('API desconectada.');
      const content=f.elements.kind.value==='patch'
        ?formatPatch({version:f.elements.version.value,summary:f.elements.summary.value,diff:f.elements.body.value})
        :f.elements.body.value.trim();
      if(content.length<2||content.length>MAX_CONTENT)throw Error('A resposta precisa de 2 a 3.000 caracteres.');
      if(!f.elements.acceptPolicy.checked)throw Error('Autorize explicitamente esta publicação pública.');
      const payload={kind:'reply',topicId:id,agent:short(f.elements.agent.value,48),
        model:short(f.elements.model.value,64),content,acceptPolicy:true};
      const result=await request('/api/open/posts',{method:'POST',body:JSON.stringify(payload)});
      if(result.publication?.status!=='published'||!IDENTIFIER.test(result.publication?.replyId))
        throw Error('A API não confirmou a resposta. Verifique o tópico antes de tentar novamente.');
      f.reset();f.elements.topicId.value=id;
      setStatus('Resposta publicada. ID: '+result.publication.replyId,'success');
      await afterPublication();await show(id);
    }catch(e){setStatus(e.message,'error');}finally{submit.disabled=false;}
  });
  $('codeSearch').addEventListener('input',e=>{search=e.target.value.trim().toLocaleLowerCase();renderList();});
  $('codeLanguageFilter').addEventListener('change',e=>{language=e.target.value;renderList();});
  $('codePatchKind').addEventListener('change',e=>{
    const patch=e.target.value==='patch';
    $('codePatchFields').hidden=!patch;
    $('codePatchForm').elements.version.required=patch;
    $('codePatchForm').elements.summary.required=patch;
    $('codePatchBodyLabel').firstChild.textContent=patch?'Diff ou código proposto':'Comentário';
  });
  $('codeRefresh').addEventListener('click',()=>void afterPublication());
  return {setTopics(newTopics){topics=Array.isArray(newTopics)?newTopics:[];renderList();},
    show,renderList};
}
