/* AI-Forum Bridge v2.4.0 — adaptadores por provedor, isolados e ativados por sessão autorizada.
 * Não lê cookies, outras abas, conversas antigas completas nem APIs privadas. */
(()=>{
  if(window!==window.top || globalThis.__AFB_REBUILT_240__)return;
  globalThis.__AFB_REBUILT_224__=true;
  const HOST=location.hostname;
  const PROVIDER=HOST==='grok.com'?'Grok':HOST==='gemini.google.com'?'Gemini':HOST==='chatgpt.com'||HOST==='chat.openai.com'?'ChatGPT':['copilot.microsoft.com','www.copilot.microsoft.com'].includes(HOST)?'Copilot':['meta.ai','www.meta.ai'].includes(HOST)?'Meta AI':null;
  if(!PROVIDER)return;
  const CONFIG={
    ChatGPT:{assistant:'[data-message-author-role="assistant"], [data-role="assistant"], [data-message-author="assistant"], .agent-turn, [data-testid="assistant-message"]',
      fallback:'main .markdown,main .prose,main [data-testid*="conversation-turn"] .markdown',
      user:'[data-message-author-role="user"], [data-role="user"]',
      editor:'#prompt-textarea, textarea[name="prompt-textarea"], textarea#mobile-composer-prompt, [data-testid="composer-input"], form [contenteditable="true"], textarea',
      send:'button#composer-submit-button, button.composer-submit-btn, button[data-testid="send-button"], button[data-testid*="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="Enviar mensagem"],button[aria-label="Enviar"]',
      stop:'[data-testid="stop-button"],button[aria-label*="Stop streaming"],button[aria-label*="Stop generating"],button[aria-label*="Parar geração"]'},
    Grok:{assistant:'[data-message-role="assistant"], [data-testid="assistant-message"], [data-role="assistant"], [data-message-author-role="assistant"], article[data-role="assistant"]',
      fallback:'main .prose,main .markdown,main [data-testid*="message-content"]',
      user:'[data-message-role="user"], [data-role="user"], [data-message-author-role="user"]',
      editor:'[data-testid="chat-input"], [data-testid="grokInput"], div[contenteditable="true"][aria-label="Ask Grok anything"], form div.ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"], [contenteditable="true"],textarea',
      send:'button[data-testid="grokSendButton"],form button[type="submit"],button[aria-label="Submit"],button[aria-label="Send"],button[aria-label="Send message"],button[data-testid="send-button"],button[title="Send"],button[aria-label="Enviar"]',
      stop:'button[aria-label*="Stop"],button[aria-label*="stop"],button[title*="Stop"]'},
    Gemini:{assistant:'model-response,[data-test-id="model-response"], [data-testid="model-response"]',
      fallback:'model-response .response-container,model-response .markdown',
      user:'user-query,[data-test-id="user-query"]',
      editor:'.ql-editor[contenteditable="true"],rich-textarea [contenteditable="true"], [contenteditable="true"][role="textbox"], textarea',
      send:'button[aria-label*="Send message"],button[aria-label*="Enviar mensagem"],button[data-test-id="send-button"],button.send-button,button[aria-label*="Submit"]',
      stop:'button[aria-label*="Stop"],button[aria-label*="Parar"],button[aria-label*="Cancel response"]'},
    // Experimental DOM adapters: only the specific user-authorized chat page;
    // no private API, no message resend, no click without an unambiguous send button.
    Copilot:{assistant:'[data-message-author-role="assistant"],[data-role="assistant"],[data-testid="assistant-message"],[data-testid="copilot-response"],cib-message[source="bot"],cib-message[role="assistant"]',
      fallback:'main .markdown,main .prose,main [data-testid="message-content"],main [class*="assistant-message"]',
      user:'[data-message-author-role="user"],[data-role="user"],cib-message[source="user"],[data-testid="user-message"]',
      editor:'textarea[placeholder],textarea,[data-testid="chat-input"],[data-testid="composer-input"],[contenteditable="true"][role="textbox"],[contenteditable="true"]',
      send:'button[aria-label="Send"],button[aria-label="Send message"],button[aria-label="Enviar"],button[aria-label="Enviar mensagem"],button[data-testid="send-button"],form button[type="submit"]',
      stop:'button[aria-label*="Stop generating"],button[aria-label*="Stop responding"],button[aria-label*="Parar"]'},
    'Meta AI':{assistant:'[data-message-author-role="assistant"],[data-message-role="assistant"],[data-role="assistant"],[data-testid="assistant-message"],[data-testid="ai-message"]',
      fallback:'main .markdown,main .prose,main [data-testid="message-content"],main [class*="assistant-message"]',
      user:'[data-message-author-role="user"],[data-message-role="user"],[data-role="user"],[data-testid="user-message"]',
      editor:'[data-testid="composer-input"],[data-testid="chat-input"],textarea,[contenteditable="true"][role="textbox"],[contenteditable="true"]',
      send:'button[aria-label="Send"],button[aria-label="Send message"],button[aria-label="Enviar"],button[aria-label="Enviar mensagem"],button[data-testid="send-button"],form button[type="submit"]',
      stop:'button[aria-label*="Stop"],button[aria-label*="Parar"]'}
  }[PROVIDER];
  const norm=s=>String(s||'').replace(/[\u200b\u200c\u200d\ufeff]/g,'').trim();
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  const all=selector=>{try{return [...document.querySelectorAll(selector)];}catch{return [];}};
  const visible=el=>!!(el&&el.isConnected&&(!el.getClientRects||el.getClientRects().length>0)&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none');
  const inner=el=>norm(el?.innerText||el?.textContent||'');
  let job=null,observer=null,tick=null,scanTimer=null,lastStatus='',lastEventAt=0,listenersAdded=false;
  let deepCache=[],lastDeepScanAt=0,deepScans=0,deepTextNodes=0;
  // Busca complementar de JSON completo para ChatGPT/Copilot/Meta AI; DOMs podem não expor atributos
  // nem classes tradicionais para a resposta. Não varre abas, cookies ou rede.
  function deepResponseCandidates(){
    if(!['ChatGPT','Copilot','Meta AI'].includes(PROVIDER))return [];
    if(Date.now()-lastDeepScanAt<950)return deepCache.filter(x=>x.n.isConnected&&visible(x.n));
    lastDeepScanAt=Date.now();deepScans++;
    const roots=all('main,[role="main"]');
    const root=roots.find(visible)||document.body;
    if(!root)return [];
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    const found=[],seen=new Set();let scanned=0;
    while(walker.nextNode()&&scanned++<9000){
      const leaf=walker.currentNode;
      if(!/ai-forum-bridge-v1/.test(leaf.nodeValue||''))continue;
      const initial=leaf.parentElement;
      if(!initial||!visible(initial)||initial.closest('nav,aside,footer,form,[contenteditable="true"],[role="textbox"],[data-message-author-role="user"],[data-role="user"],[data-message-role="user"],[aria-hidden="true"],[inert]'))continue;
      let node=initial,best=null;
      for(let depth=0;node&&depth<9;node=node.parentElement,depth++){
        if(node===root||node===document.body||node.matches('main,[role="main"]'))break;
        if(!visible(node))continue;
        const text=inner(node);
        if(text.length>15000)break;
        if(!/ai-forum-bridge-v1/.test(text))continue;
        // The prompt itself contains a sample JSON. Neither that sample nor
        // any containing user-message wrapper can become a publication.
        if(/TAREFA PÚBLICA AUTORIZADA PELO USUÁRIO|<CONTEXTO_PUBLICO_NAO_CONFIAVEL>|Marcador de correlação/.test(text))break;
        if(job?.prompt?.includes(text))continue;
        // Only accept a standalone JSON object (not a JSON example embedded
        // inside a larger user prompt, conversation thread or sidebar).
        const obj=standaloneBridgeJSON(text);
        if(obj && !job?.promptExamples?.has(JSON.stringify(obj))){best={n:node,text};break;}
      }
      if(best&&!seen.has(best.n)){seen.add(best.n);found.push(best);}
      if(found.length>=12)break;
    }
    deepTextNodes=scanned;
    deepCache=found.slice(-12);
    return deepCache;
  }

  // Lê apenas o conteúdo efetivamente editado, nunca a camada de placeholder/sugestões.
  function editorValue(el){
    if(!el)return '';
    if(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement)return norm(el.value);
    const copy=el.cloneNode(true);
    for(const d of copy.querySelectorAll('button,[role="button"],[aria-hidden="true"],[contenteditable="false"],.placeholder,[class*="placeholder"],[data-placeholder]:not([contenteditable="true"]),[data-testid*="placeholder"]'))d.remove();
    const value=norm(copy.textContent);
    const hint=norm(el.getAttribute('data-placeholder')||el.getAttribute('placeholder')||el.getAttribute('aria-placeholder'));
    return value&&value!==hint?value:'';
  }
  function composer(){
    const entries=all(CONFIG.editor).filter(e=>visible(e)&&!e.closest('[aria-hidden="true"],[inert]')&&e.getAttribute('contenteditable')!=='false')
      .filter(e=>e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement||e.isContentEditable||e.getAttribute('contenteditable')==='true')
      .filter(e=>!e.querySelector('[contenteditable="true"]'));
    const ranked=entries.map((el,i)=>{
      let score=0;
      if(el.matches('#prompt-textarea,.ql-editor,textarea,[data-testid="chat-input"],.ProseMirror'))score+=100;
      if(el.matches('[role="textbox"]'))score+=30;
      if(el.closest('form,rich-textarea,[data-testid="composer"],.chat-input-container'))score+=15;
      if(el.closest(CONFIG.assistant)||el.closest(CONFIG.user))score-=250;
      return {el,score,i};
    }).sort((a,b)=>b.score-a.score||b.i-a.i);
    // For experimental providers, fail closed when editor identity is ambiguous.
    if(PROVIDER==='Copilot'||PROVIDER==='Meta AI'){
      const eligible=ranked.filter(x=>x.score>=25&&x.el.closest('main,[role="main"],form,[data-testid="composer"],.chat-input-container'));
      if(eligible.length>1 && eligible[0].score===eligible[1].score)return null;
      return eligible[0]?.el||null;
    }
    return ranked[0]?.el||null;
  }
  function textBody(n){
    if(PROVIDER==='ChatGPT')return n.querySelector('.markdown,[data-message-content],.prose')||n;
    if(PROVIDER==='Grok')return n.querySelector('.prose,.markdown,[data-testid="message-content"]')||n;
    if(PROVIDER==='Copilot'||PROVIDER==='Meta AI')return n.querySelector('.prose,.markdown,[data-testid="message-content"]')||n;
    return n.querySelector('.markdown,.model-response-text,.response-container')||n;
  }
  function candidates(){
    const primary=all(CONFIG.assistant).filter(visible);
    const fallback=all(CONFIG.fallback).filter(visible);
    let nodes=[...new Set([...primary,...fallback])].filter(n=>{
      if(n.closest('[data-message-author-role="user"],[data-message-role="user"],[data-role="user"],user-query,[data-test-id="user-query"]'))return false;
      if(n.closest('[contenteditable="true"],textarea,form'))return false;
      if(n.closest('[aria-hidden="true"],[inert]'))return false;
      return true;
    });
    // Não remover um contêiner pai só porque ele tem blocos markdown filhos:
    // no ChatGPT a resposta JSON pode estar dividida em vários subelementos.
    const result=nodes.map(n=>{
      const bodyText=inner(textBody(n));
      const wholeText=inner(n);
      const text=hasCompleteBridgeJSON(wholeText)&&wholeText.length>bodyText.length?wholeText:bodyText;
      return {n,text:text.slice(0,40000)};
    }).filter(x=>x.text.length>0);
    // O caminho complementar só é habilitado no ChatGPT e procura JSON novo
    // em uma subárvore específica, nunca em mensagens de usuário ou no editor.
    const deep=deepResponseCandidates();
    const dedup=[...result];
    for(const item of deep)if(!dedup.some(x=>x.n===item.n||x.n.contains(item.n)&&x.text.includes(item.text)))dedup.push(item);
    return dedup.slice(-32);
  }
  const busy=()=>{
    if(all(CONFIG.stop).some(visible))return true;
    const other=PROVIDER==='Gemini'?'model-response[aria-busy="true"],[data-test-id="loading-indicator"]':
      PROVIDER==='Grok'?'[data-testid="loading-spinner"],[aria-label="Generating"],[data-state="streaming"]':
      '[data-is-streaming="true"],[aria-label="Generating response"]';
    return all(other).some(visible);
  };
  function report(state,detail='',text='',final=false){
    if(!job)return;
    const signature=[state,detail,text.length,final].join('|');
    if(!final&&signature===lastStatus)return;
    lastStatus=signature;
    chrome.runtime.sendMessage({type:'AFB_PROGRESS',sessionId:job.sessionId,token:job.token,state,detail:String(detail).slice(0,300),text:final?text.slice(0,40000):'',chars:text.length,final}).catch(()=>{});
  }
  function dispose(){observer?.disconnect();observer=null;clearInterval(tick);tick=null;clearTimeout(scanTimer);scanTimer=null;}
  function stop(silent=true){if(job&&!silent)report('interrompido','Execução cancelada.');dispose();job=null;lastStatus='';}
  function setComposer(el,text){
    el.focus();
    if(editorValue(el))throw Error('Editor já contém texto. Limpe-o antes de iniciar.');
    if(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement){
      const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(el,text);
      el.dispatchEvent(new InputEvent('input',{bubbles:true,data:text,inputType:'insertText'}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
    }else{
      let inserted=false;
      try{inserted=document.execCommand('insertText',false,text);}catch{}
      if(!inserted||!editorValue(el)){
        el.textContent=text;
        el.dispatchEvent(new InputEvent('input',{bubbles:true,data:text,inputType:'insertText'}));
      }
    }
    if(!editorValue(el))throw Error('O provedor não aceitou texto no editor.');
  }
  const disallowed=/\b(stop|cancel|voice|speak|speech|microphone|mic|record|dictat|upload|attach|attachment|file|more|tools|search|parar|cancelar|voz|áudio|audio|gravar|microfone|anex|arquivo|ferramentas|pesquisa|plus|add)\b/i;
  function buttonMeta(el){return [el.id,el.className,el.getAttribute('aria-label'),el.getAttribute('title'),el.getAttribute('data-testid'),el.getAttribute('data-test-id'),el.getAttribute('type'),el.querySelector('mat-icon')?.textContent,el.querySelector('svg')?.getAttribute('data-lucide'),el.querySelector('svg')?.getAttribute('class'),el.querySelector('use')?.getAttribute('href')].map(x=>typeof x==='string'?x:'').join(' ');}
  const buttonEnabled=el=>visible(el)&&el.getAttribute('aria-disabled')!=='true'&&!el.disabled&&getComputedStyle(el).pointerEvents!=='none'&&!el.closest('[inert]');
  function composerRoot(el){return el.closest('form')||el.closest('[data-testid="composer"],.chat-input-container,.input-area,.input-container,.input-box,.chat-input,.composer')||el.parentElement?.parentElement||el.parentElement;}
  function arrowIcon(btn){
    const icon=btn.querySelector('mat-icon,[data-icon],[data-lucide],svg,use');if(!icon)return false;
    const labels=[icon.textContent||'',icon.getAttribute('data-icon')||'',icon.getAttribute('data-lucide')||'',icon.getAttribute('class')||'',icon.getAttribute('href')||''].join(' ');
    if(/arrow.up|arrow_upward|arrow-up|send|submit|up.arrow/i.test(labels))return true;
    const svg=btn.querySelector('svg');if(!svg)return false;
    const d=[...svg.querySelectorAll('path,polyline,line')].map(n=>n.getAttribute('d')||[n.getAttribute('x1'),n.getAttribute('y1'),n.getAttribute('x2'),n.getAttribute('y2')].join(',')||n.getAttribute('points')||'').join(' ');
    return /M\s*12\s*19\s*V\s*5|m\s*5\s*12\s*7\s*-7|12,19,12,5/i.test(d);
  }
  function submitCandidates(el){
    const root=composerRoot(el),exact=all(CONFIG.send).filter(x=>x.matches('button,[role="button"]'));
    const candidates=[...new Set([...exact,...(root?.querySelectorAll('button,[role="button"]')||[])])].filter(visible);
    const r=el.getBoundingClientRect();
    return candidates.map(btn=>{
      const meta=buttonMeta(btn),label=[btn.getAttribute('aria-label'),btn.getAttribute('title'),btn.textContent].join(' '),match=exact.includes(btn),inRoot=!!root?.contains(btn),isSubmit=btn.matches('button[type="submit"]')&&inRoot;
      if(!match&&!inRoot)return null;
      if((PROVIDER==='Copilot'||PROVIDER==='Meta AI')&&!inRoot)return null;
      if(disallowed.test(label)||/\b(stop|cancel|mic|microphone|dictat|voice|audio|upload|attach|more|tools|search|plus)\b/i.test(meta))return null;
      let score=0;
      if(/composer-submit-button|send-button|sendbutton|grokSendButton/i.test(meta))score+=130;
      if(/\b(send|submit|enviar|enviar mensagem|enviar prompt)\b/i.test(label))score+=110;
      if(isSubmit)score+=100;if(arrowIcon(btn))score+=100;
      if(/send|submit|enviar|arrow.up|arrow_upward|up.arrow/i.test(meta))score+=65;
      if(match)score+=30;
      const b=btn.getBoundingClientRect(),rightSide=b.left>=r.left+Math.min(180,r.width*.5)&&b.left>=r.left+r.width*.65;
      const nearEditor=Math.abs(b.bottom-r.bottom)<150&&b.left<r.right+150&&b.right>r.left;
      if(rightSide&&nearEditor&&btn.querySelector('svg,mat-icon')){
        const rgb=(getComputedStyle(btn).backgroundColor||'').match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
        if(rgb&&+rgb[3]>110&&+rgb[3]>+rgb[1]*1.15&&+rgb[3]>+rgb[2]*1.05)score+=85;
      }
      if(score<80)return null;
      return {btn,score,enabled:buttonEnabled(btn),evidence:match?'seletor':isSubmit?'submit':arrowIcon(btn)?'ícone':'aparência'};
    }).filter(Boolean).sort((a,b)=>b.score-a.score);
  }
  function visibleLimitNotice(){
    const nodes=all('[role="alert"],[role="dialog"],[aria-live="assertive"],[data-testid*="rate-limit"],[data-testid*="usage-limit"]');
    const pattern=/(?:message|usage|rate|request|daily|weekly|chat) limit|(?:reached|exceeded|hit) (?:your |the )?limit|too many requests|try again (?:later|tomorrow)|limite (?:de mensagens|de uso|diário|atingido)|cota (?:esgotada|atingida)/i;
    return nodes.some(n=>visible(n)&&pattern.test(inner(n).slice(0,900)));
  }
  async function sendComposer(el){
    let options=[];
    for(let i=0;i<24;i++){
      if(!job)throw Error('Captura interrompida antes do envio.');
      options=submitCandidates(el);const enabled=options.filter(x=>x.enabled);
      if(enabled.length){
        const top=enabled[0];
        if(enabled[1]&&top.score===enabled[1].score)throw Error('Dois botões Enviar igualmente prováveis. Nenhum clique realizado.');
        if(!editorValue(el))throw Error('Campo vazio antes do envio.');
        top.btn.click();return top.evidence;
      }
      await delay(160);
    }
    if(visibleLimitNotice())throw Error('Limite de uso informado pela interface do provedor. Nenhum reenvio automático.');
    throw Error(`Botão Enviar não identificado/habilitado (${options.length} candidatos). Nenhum reenvio automático.`);
  }
  function newResponse(){
    if(!job)return null;
    const fresh=candidates().map(({n,text})=>{
      const prior=job.baseline.get(n);
      if(prior===text||job.baselineTexts.has(text))return null;
      if(typeof prior==='string' && prior && text.startsWith(prior))text=norm(text.slice(prior.length));
      if(!text||job.prompt===text||job.prompt.includes(text)||text.includes(job.marker||'__never__'))return null;
      if(/TAREFA PÚBLICA AUTORIZADA PELO USUÁRIO|<CONTEXTO_PUBLICO_NAO_CONFIAVEL>/.test(text))return null;
      return {n,text};
    }).filter(Boolean);
    // Priorizar o objeto Bridge completo no lugar do último fragmento HTML.
    // O último fragmento pode ser somente um exemplo ou um parágrafo da resposta.
    const rated=fresh.map((item,index)=>{
      const parsed=standaloneBridgeJSON(item.text);
      if(parsed&&job.promptExamples.has(JSON.stringify(parsed)))return null;
      const full=hasCompleteBridgeJSON(item.text);
      const score=(parsed?100000:full?50000:item.text.includes('ai-forum-bridge-v1')?10000:0)+
        Math.min(item.text.length,40000);
      return {...item,score,index};
    }).filter(Boolean).sort((a,b)=>b.score-a.score||b.index-a.index);
    return rated[0]||null;
  }
  async function verifySend(el,oldUsers){
    for(let i=0;i<30;i++){
      if(!job)return false;
      if(!editorValue(el)||all(CONFIG.user).length>oldUsers||newResponse())return true;
      await delay(150);
    }
    return false;
  }
  // An entire JSON proposal is safer than searching for a JSON fragment
  // anywhere in the conversation. Ignore markdown code fences only.
  function standaloneBridgeJSON(text){
    let cleaned=norm(text);
    cleaned=cleaned.replace(/^<escape>/i,'').replace(/<\/escape>$/i,'').trim();
    cleaned=cleaned.replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
    if(!cleaned.startsWith('{')||!cleaned.endsWith('}')||cleaned.length>15000)return null;
    try {
      const parsed=JSON.parse(cleaned);
      if(parsed?.protocol==='ai-forum-bridge-v1'&&parsed?.action==='publish'&&
         parsed?.payload?.kind==='topic'&&typeof parsed.payload.content==='string')return parsed;
    }catch{}
    return null;
  }
  function jsonExamplesInPrompt(text){
    const sample=new Set();
    for(let i=0;i<text.length;i++){
      if(text[i]!=='{')continue;
      let depth=0,quote=false,escaped=false;
      for(let j=i;j<text.length;j++){
        const c=text[j];
        if(quote){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quote=false;}
        else if(c==='"')quote=true;
        else if(c==='{')depth++;
        else if(c==='}'&&--depth===0){const obj=standaloneBridgeJSON(text.slice(i,j+1));if(obj)sample.add(JSON.stringify(obj));break;}
      }
    }
    return sample;
  }
  // Usa parse real da sintaxe, não apenas presença de chaves/strings: JSON incompleto nunca é final.
  function hasCompleteBridgeJSON(text){
    if(!text.includes('ai-forum-bridge-v1')||!text.includes('"payload"'))return false;
    const s=text.trim();
    for(let start=0;start<s.length;start++){
      if(s[start]!=='{')continue;
      let depth=0,quote=false,escaped=false;
      for(let i=start;i<s.length;i++){
        const c=s[i];
        if(quote){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quote=false;}
        else if(c==='"')quote=true;
        else if(c==='{')depth++;
        else if(c==='}'&&--depth===0){
          try{const x=JSON.parse(s.slice(start,i+1));if(x.protocol==='ai-forum-bridge-v1'&&x.action==='publish'&&x.payload?.kind==='topic'&&typeof x.payload?.content==='string')return true;}catch{}
          break;
        }
      }
    }
    return false;
  }
  function inspect(){
    if(!job||!job.wasSent)return;
    if(Date.now()>job.deadline){report('erro','Tempo máximo da sessão excedido.');stop();return;}
    if(location.origin!==job.origin){report('erro','A aba mudou para outra origem.');stop();return;}
    job.scans++;
    const response=newResponse();
    if(!response){
      if(Date.now()-job.sentAt>9000&&Date.now()-job.lastDiagnostic>6500){
        job.lastDiagnostic=Date.now();report('aguardando',`Nenhuma resposta nova encontrada (${candidates().length} regiões; busca JSON: ${deepScans} verificações, ${document.visibilityState==='hidden'?'aba oculta':'aba visível'}).`);
      }
      return;
    }
    const now=Date.now(),text=response.text;
    if(text!==job.text){job.text=text;job.lastChange=now;report('gerando',`Texto capturado (${PROVIDER}); aguardando conclusão.`,text);}
    const syntacticallyComplete=hasCompleteBridgeJSON(text);
    if(!syntacticallyComplete)return;
    if(!job.jsonComplete){job.jsonComplete=true;report('validando','JSON completo detectado; verificando final da geração.',text);}
    const generating=busy();if(generating)job.seenBusy=true;
    const quietFor=now-job.lastChange;
    const quietThreshold=job.seenBusy?2500:4000;
    if(quietFor>=quietThreshold&&!generating){
      report('concluido','JSON completo, texto estável e nenhuma geração ativa.',text,true);
      stop();
    }
  }
  async function start(message){
    stop();
    if(!message?.token||!message.sessionId||typeof message.prompt!=='string'||message.prompt.length>12000)throw Error('Solicitação inválida.');
    deepCache=[];lastDeepScanAt=0;deepScans=0;deepTextNodes=0;
    const initial=candidates(),baseline=new Map(initial.map(x=>[x.n,x.text]));
    const baselineTexts=new Set(initial.map(x=>x.text));
    const el=composer();if(!el)throw Error('Editor de mensagem não reconhecido neste provedor.');
    job={token:message.token,sessionId:message.sessionId,origin:location.origin,
      prompt:message.prompt,promptExamples:jsonExamplesInPrompt(message.prompt),marker:message.prompt.match(/AFB-[a-f0-9-]{20,}/i)?.[0]||null,
      baseline,baselineTexts,sentAt:0,lastChange:Date.now(),text:'',seenBusy:false,jsonComplete:false,
      deadline:Date.now()+Math.min(480000,Math.max(15000,message.ttl||480000)),wasSent:false,scans:0,lastDiagnostic:0};
    const userBefore=all(CONFIG.user).length;
    if(visibleLimitNotice())throw Error('Limite de uso informado pela interface do provedor. Nenhum reenvio automático.');
    if(message.resumePending===true){
      const pending=editorValue(el);
      if(!pending.startsWith('TAREFA PÚBLICA AUTORIZADA PELO USUÁRIO')||!pending.includes('ai-forum-bridge-v1')||pending.length<400)
        throw Error('Não existe um prompt pendente do AI Forum nesse editor. Nada foi enviado.');
    }else setComposer(el,message.prompt);
    const method=await sendComposer(el);
    job.sentAt=Date.now();job.wasSent=true;
    report('aguardando','Botão Enviar acionado ('+method+'); verificando estado do editor.');
    if(!await verifySend(el,userBefore))throw Error('Clique realizado, mas o provedor não confirmou o envio. Não repetir automaticamente.');
    report('aguardando','Envio confirmado pela interface; observando resposta da IA.');
    observer=new MutationObserver(()=>{
      if(job&&!scanTimer)scanTimer=setTimeout(()=>{scanTimer=null;inspect();},250);
    });
    observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['aria-busy','data-is-streaming','data-state']});
    tick=setInterval(inspect,1000);inspect();
    if(!listenersAdded){listenersAdded=true;document.addEventListener('visibilitychange',()=>{if(job)inspect();});}
    return {ok:true,provider:PROVIDER};
  }
  chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
    if(sender?.id!==chrome.runtime.id||!['AFB_START','AFB_STOP','AFB_INSPECT'].includes(msg?.type))return false;
    if(msg.type==='AFB_START')start(msg).then(reply,e=>{const detail=String(e?.message||e);if(job)report(/Limite de uso/i.test(detail)?'limite-uso':'erro',detail);stop();reply({ok:false,error:detail});});
    else if(msg.type==='AFB_STOP'){if(job?.token===msg.token)stop(false);reply({ok:true});}
    else {inspect();reply({ok:true,active:!!job,provider:PROVIDER,chars:job?.text?.length||0,regions:candidates().length,checks:job?.scans||0,deepScans,deepTextNodes,editor:!!composer(),visible:document.visibilityState});}
    return msg.type==='AFB_START';
  });
  addEventListener('pagehide',()=>{if(job)report('erro','Navegação ou descarte da aba durante a sessão.');stop();});
})();
