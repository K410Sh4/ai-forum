/* Adaptadores somente para as páginas autorizadas. Sem leitura de cookies ou APIs privadas. */
(()=>{
  if(window!==window.top || globalThis.__AFB_REBUILT_221__)return;
  globalThis.__AFB_REBUILT_221__=true;
  const HOST=location.hostname;
  const PROVIDER=HOST==='grok.com'?'Grok':HOST==='gemini.google.com'?'Gemini':HOST==='chatgpt.com'||HOST==='chat.openai.com'?'ChatGPT':null;
  if(!PROVIDER)return;
  const CONFIG={
    ChatGPT:{assistant:'[data-message-author-role="assistant"], [data-role="assistant"], [data-message-author="assistant"], .agent-turn',
      user:'[data-message-author-role="user"], [data-role="user"]',
      editor:'#prompt-textarea, textarea[name="prompt-textarea"], textarea#mobile-composer-prompt, [data-testid="composer-input"], form [contenteditable="true"], textarea',
      send:'button#composer-submit-button, button.composer-submit-btn, button[data-testid="send-button"], button[data-testid*="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="Enviar mensagem"],button[aria-label="Enviar"]',
      stop:'[data-testid="stop-button"],button[aria-label*="Stop streaming"],button[aria-label*="Stop generating"],button[aria-label*="Parar geração"]'},
    Grok:{assistant:'[data-message-role="assistant"], [data-testid="assistant-message"], [data-role="assistant"], [data-message-author-role="assistant"], article[data-role="assistant"]',
      user:'[data-message-role="user"], [data-role="user"], [data-message-author-role="user"]',
      editor:'[data-testid="chat-input"], [data-testid="grokInput"], div[contenteditable="true"][aria-label="Ask Grok anything"], form div.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"], [contenteditable="true"],textarea',
      send:'button[data-testid="grokSendButton"],form button[type="submit"],button[aria-label="Submit"],button[aria-label="Send"],button[aria-label="Send message"],button[data-testid="send-button"],button[title="Send"],button[aria-label="Enviar"]',
      stop:'button[aria-label*="Stop"],button[aria-label*="stop"],button[title*="Stop"]'},
    Gemini:{assistant:'model-response,[data-test-id="model-response"], [data-testid="model-response"]',
      user:'user-query,[data-test-id="user-query"]',
      editor:'.ql-editor[contenteditable="true"],rich-textarea [contenteditable="true"], [contenteditable="true"][role="textbox"], textarea',
      send:'button[aria-label*="Send message"],button[aria-label*="Enviar mensagem"],button[data-test-id="send-button"],button.send-button,button[aria-label*="Submit"]',
      stop:'button[aria-label*="Stop"],button[aria-label*="Parar"],button[aria-label*="Cancel response"]'}
  }[PROVIDER];
  let job=null, observer=null,tick=null, scanTimer=null,lastStatus='', listenersAdded=false;
  const visible=el=>el&&el.isConnected&&(!el.getClientRects||el.getClientRects().length>0)&&getComputedStyle(el).visibility!=='hidden';
  const norm=s=>String(s||'').replace(/\u200b/g,'').trim();
  const inner=el=>norm(el?.innerText||el?.textContent||'');
  const all=(selector)=>{try{return [...document.querySelectorAll(selector)];}catch{return [];}};
  function getAssistants(){
    let nodes=all(CONFIG.assistant).slice(-18).filter(visible);
    // Fallback restrito: somente containers explicitamente rotulados como mensagem da IA.
    if(!nodes.length && PROVIDER==='ChatGPT')nodes=all('main article').filter(x=>/assistant|agent-turn/i.test((x.getAttribute('data-testid')||'')+' '+(x.className||'')));
    if(!nodes.length && PROVIDER==='Grok')nodes=all('[data-testid*="message"], [data-message-role]').filter(x=>/assistant|grok/i.test((x.getAttribute('data-testid')||'')+' '+x.getAttribute('data-message-role')));
    const unique=nodes.filter((n,i)=>!nodes.some((m,j)=>i!==j&&m.contains(n)));
    return unique.map((n,i)=>{
      let body=n;
      if(PROVIDER==='ChatGPT')body=n.querySelector('.markdown, .prose, [data-message-content], [class*="markdown"]')||n;
      if(PROVIDER==='Grok')body=n.querySelector('.prose, .markdown, [class*="markdown"], [data-testid="message-content"]')||n;
      if(PROVIDER==='Gemini')body=n.querySelector('.markdown, .model-response-text, .response-container')||n;
      const text=inner(body).slice(0,40000);
      return {n,text,index:i};
    }).filter(x=>x.text.length>0);
  }
  const hasStop=()=>all(CONFIG.stop).some(visible);
  function hasBusy(){
    if(hasStop())return true;
    const special=PROVIDER==='Gemini'?'model-response[aria-busy="true"], [data-test-id="loading-indicator"]':
      PROVIDER==='Grok'?'[data-testid="loading-spinner"], [aria-label="Generating"], [data-state="streaming"]':
      '[data-is-streaming="true"], [aria-label="Generating response"]';
    return all(special).some(visible);
  }
  function report(state,detail='',text='',final=false){
    if(!job)return;
    const fingerprint=[state,detail,text.length,final].join('|');
    if(!final && fingerprint===lastStatus)return;
    lastStatus=fingerprint;
    chrome.runtime.sendMessage({type:'AFB_PROGRESS',sessionId:job.sessionId,token:job.token,state,detail:String(detail).slice(0,300),text:final?text.slice(0,40000):'',chars:text.length,final}).catch(()=>{});
  }
  function dispose(){if(observer){observer.disconnect();observer=null;}if(tick){clearInterval(tick);tick=null;}if(scanTimer){clearTimeout(scanTimer);scanTimer=null;}}
  function stop(silent=true){if(job&&!silent)report('interrompido','Execução cancelada.');dispose();job=null;lastStatus='';}
  function composer(){return all(CONFIG.editor).filter(e=>visible(e)&&!e.closest('[aria-hidden="true"], [inert]')&&e.getAttribute('contenteditable')!=='false').at(-1)||null;}
  function setComposer(el,text){
    el.focus();
    if(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement){
      if(norm(el.value))throw Error('Editor já contém texto. Limpe-o antes de iniciar.');
      const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
      setter.call(el,text);el.dispatchEvent(new InputEvent('input',{bubbles:true,data:text,inputType:'insertText'}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    }else{
      if(inner(el))throw Error('Editor já contém texto. Limpe-o antes de iniciar.');
      let inserted=false;
      try{inserted=document.execCommand('insertText',false,text);}catch{}
      if(!inserted || !inner(el)){
        el.textContent=text;
        el.dispatchEvent(new InputEvent('input',{bubbles:true,data:text,inputType:'insertText'}));
      }
    }
    if(!norm(el.value||inner(el)))throw Error('O provedor rejeitou o texto do editor.');
  }
  // Nenhum clique aleatório em botões de voz, anexos, pesquisa, ferramentas ou cancelar.
  // A seleção prioriza identificadores da própria interface e depois sinais visuais inequívocos.
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const disallowed=/\b(stop|cancel|voice|speak|speech|microphone|mic|record|dictat|upload|attach|attachment|file|more|tools|search|parar|cancelar|voz|áudio|audio|gravar|microfone|anex|arquivo|ferramentas|pesquisa|plus|add)\b/i;
  const sendNames=/(?:^|[\s_-])(send|submit|enviar|enviar mensagem|enviar prompt|arrow.up|arrow_upward|up.arrow)(?:$|[\s_-])/i;
  function buttonMeta(el){
    return [el.id,el.className,el.getAttribute('aria-label'),el.getAttribute('title'),
      el.getAttribute('data-testid'),el.getAttribute('data-test-id'),el.getAttribute('data-state'),
      el.getAttribute('data-tooltip-content'),el.getAttribute('type'),
      el.querySelector('mat-icon')?.textContent,el.querySelector('svg')?.getAttribute('data-lucide'),
      el.querySelector('svg')?.getAttribute('class'),el.querySelector('use')?.getAttribute('href')]
      .map(x=>typeof x==='string'?x:'').join(' ');
  }
  function buttonEnabled(el){
    return visible(el)&&el.getAttribute('aria-disabled')!=='true'&&!el.disabled&&
      getComputedStyle(el).pointerEvents!=='none'&&!el.closest('[inert]');
  }
  function composerRoot(el){
    // Nunca escolher [data-testid*=composer] sem verificar: pode ser o botão de anexos.
    return el.closest('form') || el.closest('[data-testid="composer"], .chat-input-container, .input-area, .input-container, .input-box, .chat-input, .composer') || el.parentElement?.parentElement || el.parentElement;
  }
  function arrowIcon(btn){
    const icon=btn.querySelector('mat-icon, [data-icon], [data-lucide], svg, use');
    if(!icon)return false;
    const tags=[icon.textContent||'',icon.getAttribute('data-icon')||'',icon.getAttribute('data-lucide')||'',
      icon.getAttribute('class')||'',icon.getAttribute('href')||'',icon.getAttribute('aria-label')||''].join(' ');
    if(/arrow.up|arrow_upward|arrow-up|send|submit|up.arrow/i.test(tags))return true;
    const svg=btn.querySelector('svg');
    if(!svg)return false;
    // Lucide ArrowUp: m5 12 7-7 7 7 + M12 19V5
    const d=[...svg.querySelectorAll('path,polyline,line')].map(n=>n.getAttribute('d')||
      [n.getAttribute('x1'),n.getAttribute('y1'),n.getAttribute('x2'),n.getAttribute('y2')].join(',')||n.getAttribute('points')||'').join(' ');
    return /M\s*12\s*19\s*V\s*5|m\s*5\s*12\s*7\s*-7|12,19,12,5/i.test(d);
  }
  function submitCandidates(el){
    const root=composerRoot(el);
    const scoped=[...(root?.querySelectorAll('button, [role="button"]')||[])];
    const exact=all(CONFIG.send).filter(x=>x.matches('button,[role="button"]'));
    const candidates=[...new Set([...exact,...scoped])].filter(visible);
    const r=el.getBoundingClientRect();
    return candidates.map(btn=>{
      const meta=buttonMeta(btn),label=[btn.getAttribute('aria-label'),btn.getAttribute('title'),btn.textContent].join(' ');
      const match=exact.includes(btn),inRoot=!!root?.contains(btn),isSubmit=btn.matches('button[type="submit"]') && inRoot;
      if(!match&&!inRoot)return null;
      if(disallowed.test(label)||/\b(stop|cancel|mic|microphone|dictat|voice|audio|upload|attach|more|tools|search|plus)\b/i.test(meta))return null;
      let score=0;
      if(/composer-submit-button|send-button|sendbutton|grokSendButton/i.test(meta))score+=130;
      if(/\b(send|submit|enviar|enviar mensagem|enviar prompt)\b/i.test(label))score+=110;
      if(isSubmit)score+=100;
      if(arrowIcon(btn))score+=100;
      if(/send|submit|enviar|arrow.up|arrow_upward|up.arrow/i.test(meta))score+=65;
      if(match)score+=30;
      // Botão sem nome: só considerar o ícone/ação destacada no canto direito do editor.
      const b=btn.getBoundingClientRect();
      const rightSide=b.left>=r.left+Math.min(180,r.width*.5) && b.left>=r.left+r.width*.65;
      const nearEditor=Math.abs(b.bottom-r.bottom)<150 && b.left<r.right+150 && b.right>r.left;
      let prominent=false;
      if(rightSide&&nearEditor&&!!btn.querySelector('svg,mat-icon')){
        const css=getComputedStyle(btn).backgroundColor||'';
        const color=css.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
        if(color){const red=+color[1],green=+color[2],blue=+color[3];prominent=blue>110&&blue>red*1.15&&blue>green*1.05;}
      }
      if(prominent)score+=85;
      if(score<80)return null;
      return {btn,score,enabled:buttonEnabled(btn),evidence:match?'seletor':isSubmit?'submit':arrowIcon(btn)?'ícone':'aparência'};
    }).filter(Boolean).sort((a,b)=>b.score-a.score);
  }
  async function sendComposer(el){
    // Componentes React, ProseMirror e Quill podem habilitar o botão alguns instantes depois da inserção.
    let options=[];
    for(let i=0;i<24;i++){
      if(!job)throw Error('Captura interrompida antes do envio.');
      options=submitCandidates(el);
      const enabled=options.filter(x=>x.enabled);
      if(enabled.length){
        const top=enabled[0];
        if(enabled[1] && top.score===enabled[1].score)
          throw Error('Dois botões Enviar igualmente prováveis. Nada foi enviado para evitar clique incorreto.');
        if(!norm(el.value||inner(el)))throw Error('Campo vazio antes do envio.');
        top.btn.click();
        // Evitar falsos positivos: clicar não é confirmação de envio.
        return top.evidence;
      }
      await delay(160);
    }
    throw Error(`Botão Enviar não encontrado/habilitado (${options.length} candidato(s)). O prompt ficou no editor; não foi reenviado.`);
  }
  async function verifySend(el,previousUserCount){
    for(let i=0;i<30;i++){
      if(!job)return false;
      const nowUser=all(CONFIG.user).length;
      const cleared=!norm(el.value||inner(el));
      // Confirmação por editor limpo, nova mensagem do usuário ou resposta nova.
      if(cleared || nowUser>previousUserCount || selectNewResponse())return true;
      await delay(150);
    }
    return false;
  }
  function selectNewResponse(){
    if(!job)return null;
    const candidates=getAssistants();
    if(!candidates.length)return null;
    // Não reutilizar mensagens antigas do mesmo chat. Diferentes nós podem ser reciclados pelo framework.
    const changed=candidates.filter(x=>x.text && x.text!==job.baselineByIndex[x.index] && !job.baselineTexts.has(x.text));
    if(!changed.length)return null;
    return changed.at(-1);
  }
  function inspect(){
    if(!job)return;
    if(Date.now()>job.deadline){report('erro','Tempo máximo da sessão excedido.');stop();return;}
    if(location.origin!==job.origin){report('erro','A aba mudou para outra origem.');stop();return;}
    if(document.visibilityState==='hidden'){
      // Não parar: DOM e rede podem continuar. A captura se retoma quando o navegador executar o content script.
    }
    if(!job.wasSent)return;
    const candidate=selectNewResponse();
    if(!candidate){if(Date.now()-job.sentAt>20000)report('aguardando','Nenhuma nova mensagem da IA identificada.');return;}
    const text=candidate.text,now=Date.now();
    if(text!==job.text){job.text=text;job.lastChange=now;job.seenBusy=job.seenBusy||hasBusy();job.jsonComplete=false;report('gerando','Resposta em andamento.',text);}
    if(text.length<12)return;
    const busy=hasBusy();if(busy)job.seenBusy=true;
    // Validação preliminar local, sem enviar texto parcial para o background.
    const complete=/(?:^|\n)\s*\{[\s\S]*"protocol"\s*:\s*"ai-forum-bridge-v1"/.test(text) && text.includes('"payload"') && text.includes('"content"');
    if(complete && !job.jsonComplete){job.jsonComplete=true;report('validando','Possível JSON detectado; verificando conclusão.',text);}
    if(!complete)return;
    // Dois sinais: estabilidade e ausência do controle ativo de geração. Espera conservadora em sites sem controle explícito.
    const stillFor=now-job.lastChange;
    const required=job.seenBusy?2500:6000;
    if(stillFor>=required && !busy){
      report('concluido','JSON estabilizado e sem indicador de geração.',text,true);
      stop();
    }
  }
  async function start(message){
    stop();
    if(!message?.token || !message.sessionId || typeof message.prompt!=='string'||message.prompt.length>12000)throw Error('Solicitação inválida.');
    const prior=getAssistants();
    const baselineByIndex=prior.map(x=>x.text);
    const baselineTexts=new Set(prior.map(x=>x.text));
    const el=composer();if(!el)throw Error('Campo de mensagem não reconhecido no provedor.');
    const state={token:message.token,sessionId:message.sessionId,origin:location.origin,
      baselineByIndex,baselineTexts,sentAt:0,lastChange:Date.now(),text:'',seenBusy:false,jsonComplete:false,
      deadline:Date.now()+Math.min(240000,Math.max(15000,message.ttl||240000)),wasSent:false};
    job=state;
    const userCountBefore=all(CONFIG.user).length;
    if(message.resumePending===true){
      const pending=norm(el.value||inner(el));
      if(!pending.startsWith('TAREFA PÚBLICA AUTORIZADA PELO USUÁRIO') ||
          !pending.includes('ai-forum-bridge-v1') || pending.length<400)
        throw Error('Não existe um prompt pendente do AI Forum reconhecível nesta aba. Nada foi enviado.');
    } else setComposer(el,message.prompt);
    const matched=await sendComposer(el);
    state.sentAt=Date.now();state.wasSent=true;
    report('aguardando','Envio acionado ('+matched+'); verificando a confirmação da interface.');
    if(!await verifySend(el,userCountBefore))
      throw Error('Clique realizado, mas o site não confirmou envio. Verifique a aba antes de tentar novamente.');
    report('aguardando','Envio confirmado pela interface; aguardando a IA.');
    observer=new MutationObserver(()=>{if(job&&!scanTimer)scanTimer=setTimeout(()=>{scanTimer=null;inspect();},320);});
    observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['aria-busy','data-is-streaming']});
    tick=setInterval(inspect,1300);inspect();
    if(!listenersAdded){listenersAdded=true;document.addEventListener('visibilitychange',()=>{if(job)inspect();});}
    return {ok:true,provider:PROVIDER};
  }
  chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
    if(sender?.id!==chrome.runtime.id || !['AFB_START','AFB_STOP','AFB_INSPECT'].includes(msg?.type))return false;
    if(msg.type==='AFB_START')start(msg).then(reply,e=>{const detail=String(e?.message||e);if(job)report('erro',detail);stop();reply({ok:false,error:detail});});
    else if(msg.type==='AFB_STOP'){if(job?.token===msg.token)stop(false);reply({ok:true});}
    else {inspect();reply({ok:true,active:!!job,provider:PROVIDER,chars:job?.text?.length||0});}
    return msg.type==='AFB_START';
  });
  addEventListener('pagehide',()=>{if(job)report('erro','Navegação ou descarte da aba durante a sessão.');stop();});
})();
