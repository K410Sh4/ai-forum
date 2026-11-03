import { API, normalizeDraft, publishDraft } from '../../docs/chat-bridge.js';
import { toolProposal, contextPacket } from './protocol.js';
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const ATTEMPTS = 'bridgeAttempts';
const LOCK_MAX_AGE = 60 * 60 * 1000;
export function isTrustedPage(sender, runtime) {
  return sender?.id === runtime.id && typeof sender.url === 'string' &&
    sender.url.split(/[?#]/)[0] === runtime.getURL('bridge.html');
}
async function jsonRequest(path, fetchImpl, body) {
  const response = await fetchImpl(API + path, {
    method:body === undefined ? 'GET' : 'POST', credentials:'omit', redirect:'error', cache:'no-store',
    signal:AbortSignal.timeout(15000), headers:{ Accept:'application/json', ...(body === undefined ? {} : {'Content-Type':'application/json'}) },
    ...(body === undefined ? {} : { body:JSON.stringify(body) })
  });
  if (!response.ok) throw Error('API indisponível ou solicitação recusada (HTTP ' + response.status + ').');
  // Read incrementally so an unexpectedly large remote response is bounded before parsing.
  const reader = response.body.getReader();
  const decoder = new TextDecoder(); let size=0, text='';
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 1500000) { await reader.cancel(); throw Error('Resposta excede o limite de leitura.'); }
      text += decoder.decode(value, {stream:true});
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (e) { throw Error(e.message || 'Resposta inválida da API.'); }
  finally { reader.releaseLock(); }
}
export function createBridgeService({ storage, fetchImpl = globalThis.fetch, clock = Date.now, digest = async value => {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2,'0')).join('');
} }) {
  let busy = false;
  async function attempts() { return (await storage.get(ATTEMPTS))[ATTEMPTS] || []; }
  async function record(entry) {
    const list = [entry,...(await attempts()).filter(x=>x.key !== entry.key)];
    const locks = list.filter(x=>['pending','uncertain'].includes(x.status));
    if (locks.length > 20) throw Error('Há muitas tentativas sem confirmação. Confira o fórum antes de continuar.');
    const completed = list.filter(x=>!['pending','uncertain'].includes(x.status));
    await storage.set({ [ATTEMPTS]:[...locks,...completed.slice(0,20-locks.length)].sort((a,b)=>b.at-a.at) });
  }
  async function publish(data, accepted) {
    if (accepted !== true) throw Error('Autorize a publicação do texto revisado.');
    const draft = normalizeDraft(data);
    if (busy) throw Error('Outra publicação está em andamento. Aguarde seu recibo.');
    busy = true;
    let key, postStarted=false, httpStatus=null;
    try {
      key = await digest(JSON.stringify(draft));
      const previous = (await attempts()).find(x => x.key === key);
      if (previous?.status === 'published') return { ...previous.receipt, reused:true };
      if (previous && ['pending','uncertain'].includes(previous.status))
        throw Error('Esta tentativa está sem confirmação. Confira o fórum antes de repetir; não houve reenvio automático.');
      await record({key, status:'pending', at:clock()});
      let receipt;
      try {
        receipt = await publishDraft(draft, { accepted:true, fetchImpl:async (url, options) => {
          if (options?.method === 'POST') postStarted = true;
          const response = await fetchImpl(url, options);
          if (options?.method === 'POST') httpStatus = response.status;
          return response;
        } });
      } catch (error) {
        const uncertain = postStarted && (httpStatus === null || httpStatus >= 500 || httpStatus < 400);
        await record({key, status:uncertain?'uncertain':'rejected', at:clock()});
        throw error;
      }
      await record({key, status:'published', at:clock(), receipt});
      return receipt;
    } finally { busy = false; }
  }
  async function tool(data, accepted) {
    if (accepted !== true) throw Error('Autorize o envio destes argumentos à ferramenta.');
    const proposal = toolProposal(data);
    const catalog = await jsonRequest('/api/tools', fetchImpl);
    if (!catalog.tools?.some(t=>t.name===proposal.name && t.readOnly===true)) throw Error('Ferramenta indisponível no servidor.');
    const result = await jsonRequest('/api/tools/execute', fetchImpl, proposal);
    if (result.name !== proposal.name || result.readOnly !== true || result.execution !== 'server' || !Object.hasOwn(result,'result'))
      throw Error('O servidor não confirmou a operação esperada.');
    return { result:result.result, context:contextPacket({tool:proposal.name,result:result.result}) };
  }
  return {
    async handle(message) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error('Mensagem inválida.');
      switch (message.type) {
        case 'PUBLISH': return publish(message.draft, message.accepted);
        case 'TOOL': return tool(message.proposal, message.accepted);
        case 'LIST': {
          const data = await jsonRequest('/api/topics',fetchImpl);
          if (!Array.isArray(data.topics)) throw Error('Lista de tópicos inválida.');
          return data.topics.filter(t=>typeof t.id==='string' && ID.test(t.id) && typeof t.title==='string')
            .slice(0,30).map(t=>({id:t.id,title:t.title.slice(0,120)}));
        }
        case 'READ': {
          if (typeof message.topicId !== 'string' || !ID.test(message.topicId)) throw Error('ID de tópico inválido.');
          const data = await jsonRequest('/api/topics/' + message.topicId, fetchImpl);
          const topic = data.topic;
          if (!topic || topic.id !== message.topicId || typeof topic.content !== 'string') throw Error('Tópico retornado inválido.');
          const replies = Array.isArray(topic.replies) ? topic.replies : [];
          const clean = { id:topic.id, title:String(topic.title||'').slice(0,120), content:topic.content.slice(0,3000),
            authorName:String(topic.authorName||'').slice(0,120),
            replies:replies.slice(-10).map(r=>({id:String(r.id||''),authorName:String(r.authorName||'').slice(0,120),content:String(r.content||'').slice(0,3000)})),
            partial:replies.length>10, note:'Últimas 10 respostas dentro da página retornada pela API; não é um arquivo completo.' };
          return { topicId:topic.id, context:contextPacket({topic:clean}) };
        }
        case 'HISTORY': return (await attempts()).map(({status,at,receipt})=>({status,at,...(receipt?{receipt}:{})}));
        case 'CLEAR': {
          if (busy) throw Error('Aguarde o envio antes de limpar os dados.');
          // Preserve unresolved attempt fingerprints until the session ends to prevent accidental retries.
          const locks=(await attempts()).filter(x=>['pending','uncertain'].includes(x.status));
          const all=await storage.get(null);
          await storage.remove(Object.keys(all).filter(k=>k.startsWith('capture:')));
          await storage.set({[ATTEMPTS]:locks});
          return {cleared:true,unresolved:locks.length};
        }
        case 'CAPTURE': {
          if (typeof message.id !== 'string' || !ID.test(message.id)) throw Error('Captura inválida.');
          const key='capture:'+message.id;
          const capture=(await storage.get(key))[key];
          if (!capture || clock()-capture.at>LOCK_MAX_AGE) { await storage.remove(key); return null; }
          return capture;
        }
        default: throw Error('Operação não permitida.');
      }
    }
  };
}
