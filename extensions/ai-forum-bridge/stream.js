// The extension UI authorizes a bounded capture. Page text never authorizes an action.
export const CAPTURE_HOSTS = ['chatgpt.com','chat.openai.com','gemini.google.com','grok.com','claude.ai','copilot.microsoft.com'];
export const CAPTURE_TTL = 10 * 60 * 1000;
export function createCaptureController({storage,tabs,scripting,runtime,clock=Date.now,uuid=()=>crypto.randomUUID()}) {
  let queue=Promise.resolve();
  const serial=fn=>{const work=queue.then(fn);queue=work.catch(()=>{});return work;};
  const key=id=>'stream:'+id;
  async function stop(tabId) {
    const record=(await storage.get(key(tabId)))[key(tabId)];
    await storage.remove(key(tabId));
    if(record)try{await tabs.sendMessage(tabId,{type:'BRIDGE_STOP',token:record.token});}catch{/* closed/navigated */}
    return record;
  }
  async function capture(id) {
    if(typeof id!=='string'||!/^[A-Za-z0-9-]{1,80}$/.test(id))throw Error('Captura inválida.');
    const record=(await storage.get('capture:'+id))['capture:'+id];
    if(!record||clock()-record.at>3600000||!Number.isInteger(record.sourceTabId))throw Error('Abra o Bridge pelo ícone na aba do chat.');
    return record;
  }
  return {
    handle(message){return serial(async()=>{
      const saved=await capture(message.id),tabId=saved.sourceTabId;
      if(message.type==='STREAM_START'){
        if(!['next','pick'].includes(message.mode))throw Error('Modo de captura inválido.');
        const tab=await tabs.get(tabId),url=new URL(tab.url);
        if(url.protocol!=='https:'||!CAPTURE_HOSTS.includes(url.hostname)||url.origin!==saved.origin)throw Error('Captura de resposta indisponível aqui. Use seleção ou cole o texto.');
        await stop(tabId);
        const token=uuid();
        // activeTab must still grant access from the user's click on this source tab.
        await scripting.executeScript({target:{tabId},files:['content.js'],world:'ISOLATED'});
        await storage.set({[key(tabId)]:{id:message.id,token,at:clock(),origin:url.origin,seq:0}});
        try{
          const answer=await tabs.sendMessage(tabId,{type:message.mode==='next'?'BRIDGE_ARM':'BRIDGE_PICK',token});
          if(!answer?.ok)throw Error(answer?.error||'Não foi possível iniciar a captura.');
          await storage.set({['capture:'+message.id]:{...saved,text:'',at:clock(),error:''}});
          await tabs.update(tabId,{active:true});
          return {started:true};
        }catch(error){await stop(tabId);throw error;}
      }
      if(message.type==='STREAM_FINISH'||message.type==='STREAM_STOP'){
        const record=(await storage.get(key(tabId)))[key(tabId)];
        if(record&&record.id!==message.id)throw Error('Existe outra captura nesta aba.');
        let text=saved.text;
        if(record&&message.type==='STREAM_FINISH'&&clock()-record.at<CAPTURE_TTL){
          try{
            const answer=await tabs.sendMessage(tabId,{type:'BRIDGE_FINISH',token:record.token});
            if(answer?.ok&&typeof answer.text==='string'&&answer.text.length<=40000)text=answer.text;
          }catch{/* Return the last acknowledged snapshot if the tab was closed. */}
        }
        await stop(tabId);
        if(message.type==='STREAM_STOP')text='';
        await storage.set({['capture:'+message.id]:{...saved,text}});
        return {text};
      }
      throw Error('Ação de captura desconhecida.');
    });},
    receive(message,sender){return serial(async()=>{
      const tabId=sender?.tab?.id;
      if(sender?.id!==runtime.id||!Number.isInteger(tabId)||sender.frameId!==0)return false;
      const record=(await storage.get(key(tabId)))[key(tabId)];
      if(!record||message.token!==record.token)return false;
      let origin;try{origin=new URL(sender.url).origin;}catch{return false;}
      if(origin!==record.origin)return false;
      if(clock()-record.at>=CAPTURE_TTL){await stop(tabId);return false;}
      if(!Number.isSafeInteger(message.seq)||message.seq<=record.seq||typeof message.text!=='string'||message.text.length>40000)return false;
      const saved=(await storage.get('capture:'+record.id))['capture:'+record.id];
      if(!saved){await stop(tabId);return false;}
      await storage.set({['capture:'+record.id]:{...saved,text:message.text},[key(tabId)]:{...record,seq:message.seq}});
      return true;
    });},
    stop(tabId){return serial(()=>stop(tabId));},
    clear(){return serial(async()=>{const all=await storage.get(null);for(const name of Object.keys(all).filter(k=>k.startsWith('stream:')))await stop(Number(name.slice(7)));});}
  };
}
