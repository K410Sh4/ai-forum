// Content script isolado: somente lê texto visível após consentimento na extensão.
// Nunca injeta código remoto, acessa cookies ou lê mensagens do usuário automaticamente.
(()=>{
  if (window.top!==window || globalThis.__aiForumCaptureInstalled) return;
  globalThis.__aiForumCaptureInstalled=true;
  const hostname=location.hostname;
  const SELECTORS={
    'chatgpt.com':'[data-message-author-role="assistant"]',
    'chat.openai.com':'[data-message-author-role="assistant"]',
    'gemini.google.com':'model-response, [data-test-id="model-response"]',
    'claude.ai':'[data-testid="assistant-message"], [data-is-streaming="true"].font-claude-message',
    'grok.com':'[data-message-role="assistant"], [data-testid="assistant-message"]',
    'copilot.microsoft.com':'[data-content="ai-message"], [data-testid="ai-message"]'
  };
  const selector=SELECTORS[hostname];
  if (!selector) return;
  let mode=null, observer=null, target=null, seq=0, baseline=null, timer=null;
  let urlAtStart='', lastText='', banner=null, highlighted=null, token='', deadline=null;
  let oldOutline='';
  let pickMove=null,pickClick=null,pickKey=null;

  function getText(node) {
    if (!node || !node.isConnected) return '';
    if (node.getClientRects && !node.getClientRects().length) return '';
    // Preferir o corpo da resposta em vez de menus, controles e avatares.
    let body=node;
    if (hostname==='chatgpt.com'||hostname==='chat.openai.com')
      body=node.querySelector('.markdown, [data-message-content], .prose')||node;
    if (hostname==='claude.ai') body=node.querySelector('.font-claude-message, .prose')||node;
    const text=(body.innerText||'').trim();
    return text.slice(0,40000);
  }
  function candidates(){return [...document.querySelectorAll(selector)].filter(x=>x.isConnected);}
  function cleanupPicker(){
    if(pickMove) document.removeEventListener('mousemove',pickMove,true);
    if(pickClick) document.removeEventListener('click',pickClick,true);
    if(pickKey) document.removeEventListener('keydown',pickKey,true);
    if(highlighted) highlighted.style.outline=oldOutline;
    highlighted=null;pickMove=pickClick=pickKey=null;
    banner?.remove();banner=null;
  }
  function stop(){
    mode=null;observer?.disconnect();observer=null;
    if(deadline)clearTimeout(deadline);deadline=null;
    if(timer) clearTimeout(timer);
    timer=null;cleanupPicker();baseline=null;target=null;lastText='';
  }
  function deliver(force=false){
    if(location.href!==urlAtStart){stop();return;}
    if(!target||!mode) return;
    const text=getText(target);
    if(!text || (!force&&text===lastText)) return;
    lastText=text;
    const current=++seq;
    chrome.runtime.sendMessage({type:'BRIDGE_CAPTURE',text,seq:current,token}).catch(()=>{});
  }
  function scan(){
    if (!mode) return;
    if (location.href!==urlAtStart){stop();return;}
    if (mode==='next'&&target&&!target.isConnected) target=null;
    if (mode==='next'&&!target){
      for(const node of candidates()){
        if(!baseline.has(node) && getText(node).length>=2){target=node;break;}
      }
    }
    if(target && !timer){
      timer=setTimeout(()=>{timer=null;deliver();},300);
    }
  }
  function watch(){
    observer=new MutationObserver(scan);
    observer.observe(document.documentElement,{subtree:true,characterData:true,childList:true});
    // A final URL check also runs before each delivery and finalization.
  }
  function showBanner(){
    banner=document.createElement('div');
    banner.textContent='AI-Forum Bridge: clique na resposta que deseja capturar. Esc cancela.';
    banner.setAttribute('role','status');
    Object.assign(banner.style,{position:'fixed',zIndex:'2147483647',left:'16px',right:'16px',top:'12px',
      maxWidth:'560px',margin:'auto',background:'#151515',color:'#fff',padding:'14px 16px',
      borderRadius:'12px',border:'1px solid #777',font:'14px system-ui',boxShadow:'0 8px 36px #0005',pointerEvents:'none'});
    document.documentElement.appendChild(banner);
  }
  function chooseElement(event){
    const hit=event.target;
    if(!(hit instanceof Element)||hit===banner||banner?.contains(hit)||hit.closest('input,textarea,select,[contenteditable="true"]')) return null;
    const candidate=hit.closest(`${selector}, article, [role="article"], .markdown, .prose, model-response`);
    if(candidate?.matches('[data-message-author-role="user"], [data-role="user"]') ||
       candidate?.closest('[data-message-author-role="user"], [data-role="user"]')) return null;
    // Never treat an empty-area click on the page/conversation wrapper as selection.
    const el=candidate||hit.closest('p,pre,blockquote,li');
    const text=getText(el);
    return text.length>=2?el:null;
  }
  function picker(){
    mode='pick';urlAtStart=location.href;seq=0;target=null;lastText='';
    showBanner();
    pickMove=e=>{
      const next=chooseElement(e);
      if(next===highlighted) return;
      if(highlighted) highlighted.style.outline=oldOutline;
      highlighted=next;
      if(highlighted){oldOutline=highlighted.style.outline;highlighted.style.outline='2px solid #14a6a6';}
    };
    pickClick=e=>{
      const selected=chooseElement(e);
      if(!selected)return;
      e.preventDefault();e.stopImmediatePropagation();
      // Só guarda o alvo escolhido. O texto pode ser revisado e editado antes do POST.
      cleanupPicker();target=selected;
      deliver(true);
      watch();
    };
    pickKey=e=>{if(e.key==='Escape')stop();};
    document.addEventListener('mousemove',pickMove,true);
    document.addEventListener('click',pickClick,true);
    document.addEventListener('keydown',pickKey,true);
  }
  addEventListener('pagehide',stop);
  chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
    if(sender.id!==chrome.runtime.id || sender.tab || (sender.url&&!sender.url.startsWith(chrome.runtime.getURL(''))))return false;
    if(!['BRIDGE_ARM','BRIDGE_PICK'].includes(msg?.type)&&msg?.token!==token)return false;
    try{
      switch(msg?.type){
        case 'BRIDGE_ARM':{
          stop();token=msg.token;deadline=setTimeout(stop,600000);mode='next';urlAtStart=location.href;seq=0;
          baseline=new WeakSet(candidates());watch();respond({ok:true});break;
        }
        case 'BRIDGE_PICK':stop();token=msg.token;deadline=setTimeout(stop,600000);picker();respond({ok:true});break;
        case 'BRIDGE_FINISH':{
          if(timer){clearTimeout(timer);timer=null;}
          const text=location.href===urlAtStart?(getText(target)||lastText):'';
          stop();respond({ok:true,text});break;
        }
        case 'BRIDGE_STOP':stop();respond({ok:true});break;
        default:respond({ok:false});
      }
    }catch(e){respond({ok:false,error:e.message});}
  });
})();
