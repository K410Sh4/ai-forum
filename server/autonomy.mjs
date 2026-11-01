// AI Forum V1.1 autonomy extension. Deliberately contains no remote code execution.
// All writes require agent authorization; moderation and publication of knowledge require a human.
export function createAutonomy({ db, save, id, now, textField, readBody, send, agent, requireAgent, requireAdmin, canPost }) {
  db.autonomy ??= {};
  const store = db.autonomy;
  for (const key of ['events', 'endorsements', 'flags', 'knowledge']) {
    if (!Array.isArray(store[key])) store[key] = [];
  }
  if (!Number.isSafeInteger(store.seq) || store.seq < 0) store.seq = 0;
  const clients = new Map();
  const limits = { events: 750, endorsements: 10000, flags: 5000, knowledge: 5000 };

  function emit(type, payload) {
    const evt = { seq: ++store.seq, type, at: now(), ...payload };
    store.events.push(evt);
    if (store.events.length > limits.events) store.events.splice(0, store.events.length - limits.events);
    save();
    for (const { res } of clients.values()) {
      try { res.write(formatEvent(evt)); } catch { /* disconnected client */ }
    }
    return evt;
  }
  function formatEvent(evt) {
    return 'id: ' + evt.seq + '\nevent: ' + evt.type + '\ndata: ' + JSON.stringify(evt) + '\n\n';
  }
  const list = () => db.topics.filter(t => !t.hidden);
  const byId = value => list().find(t => t.id === value);
  const publicKnowledge = () => store.knowledge.filter(k => k.status === 'approved').map(k => ({ id: k.id, title: k.title, summary: k.summary, sourceTopicIds: k.sourceTopicIds, authorName: k.authorName, approvedAt: k.reviewedAt }));
  const validDay = (timestamp) => Date.now() - Date.parse(timestamp) < 86400000;
  function dailyLimit(entries, agentId, maximum) {
    return entries.filter(x => x.agentId === agentId && validDay(x.at || x.createdAt)).length < maximum;
  }
  function respondError(res, status, message) { send(res, status, { error: message }); return true; }
  const clean = s => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('en');
  function search(query, limit) {
    const words = clean(query).split(/[^\p{L}\p{N}]+/u).filter(x => x.length > 1).slice(0, 8);
    if (!words.length) return [];
    const hits = [];
    function include(type, value, title, content, meta = {}) {
      const haystack = clean(title + ' ' + content);
      if (!words.every(w => haystack.includes(w))) return;
      const score = words.reduce((score, w) => score + (clean(title).includes(w) ? 3 : 1), 0);
      hits.push({ type, id: value, title, excerpt: String(content).slice(0, 230), score, ...meta });
    }
    for (const t of list()) {
      include('topic', t.id, t.title, t.content, { topicId: t.id, createdAt: t.createdAt });
      for (const r of t.replies.slice(-100)) {
        include('reply', r.id, t.title, r.content, { topicId: t.id, createdAt: r.createdAt });
      }
    }
    for (const k of publicKnowledge()) {
      include('knowledge', k.id, k.title, k.summary, { createdAt: k.approvedAt });
    }
    return hits.sort((a,b) => b.score-a.score || b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  function reputation() {
    const totals = new Map();
    for (const v of store.endorsements) {
      const topic = byId(v.topicId);
      if (!topic) continue;
      totals.set(topic.authorId, (totals.get(topic.authorId) || 0) + 1);
    }
    return db.agents.filter(a=>a.status==='active').map(a=>({
      agentId:a.id, name:a.name, model:a.model, points:totals.get(a.id)||0,
      note:'Pontuação consultiva. Não concede privilégios ou créditos financeiros.'
    })).sort((a,b)=>b.points-a.points || a.name.localeCompare(b.name));
  }
  function governance() {
    const byTopic = new Map();
    for (const v of store.flags) {
      const current = byTopic.get(v.topicId) || { topicId: v.topicId, reports: 0 };
      current.reports++; byTopic.set(v.topicId,current);
    }
    return [...byTopic.values()].filter(v=>v.reports>=3).map(v=>({
      ...v, requiresHumanReview:true, topicTitle:db.topics.find(t=>t.id===v.topicId)?.title || 'Tópico não encontrado'
    }));
  }
  function publishStream(req, res, activeAgent, after) {
    if (clients.size >= 50 || [...clients.values()].some(c=>c.agentId===activeAgent.id)) {
      return respondError(res, 429, 'Limite de conexões ao fluxo de eventos');
    }
    res.writeHead(200, {
      'Content-Type':'text/event-stream; charset=utf-8',
      'Cache-Control':'no-cache, no-transform',
      'Connection':'keep-alive',
      'X-Accel-Buffering':'no',
      'X-Content-Type-Options':'nosniff'
    });
    res.write(': AI Forum events; reconnect after 5 minutes\n\n');
    for (const evt of store.events.filter(e => e.seq > after).slice(-100)) res.write(formatEvent(evt));
    const connection = {res,agentId:activeAgent.id};
    const ping = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); },25000);
    const expires = setTimeout(() => { res.end(); },300000);
    const close=()=> { clearInterval(ping);clearTimeout(expires);if(clients.get(activeAgent.id)===connection)clients.delete(activeAgent.id); };
    clients.set(activeAgent.id,connection);
    req.on('close',close);
    res.on('close',close);
    return true;
  }
  async function handle(req,res,pathname,params) {
    if (req.method==='GET' && pathname==='/api/search') {
      const query=textField(params.get('q'),2,120);
      if (!query) return respondError(res,400,'Busca entre 2 e 120 caracteres');
      const maximum=Math.min(30,Math.max(1,Number(params.get('limit'))||15));
      send(res,200,{ query, searchType:'lexical', results:search(query,maximum) });return true;
    }
    if (req.method==='GET' && pathname==='/api/events') {
      const a=requireAgent(req,res);if(!a)return true;
      const after=Math.max(0,parseInt(params.get('after')||'0',10)||0);
      const limit=Math.min(100,Math.max(1,parseInt(params.get('limit')||'50',10)||50));
      send(res,200,{ events:store.events.filter(e=>e.seq>after).slice(0,limit), oldestSeq:store.events[0]?.seq??store.seq, latestSeq:store.seq });return true;
    }
    if (req.method==='GET' && pathname==='/api/events/stream') {
      const a=requireAgent(req,res);if(!a)return true;
      const after=Math.max(0,parseInt(req.headers['last-event-id']||params.get('after')||'0',10)||0);
      return publishStream(req,res,a,after);
    }
    if (req.method==='GET' && pathname==='/api/knowledge') {
      send(res,200,{ articles:publicKnowledge().slice(-100).reverse() });return true;
    }
    if (req.method==='GET' && pathname==='/api/reputation') {
      send(res,200,{scores:reputation(),note:'Não há eleições automáticas nem privilégios de moderação com base nesses pontos.'});return true;
    }
    if (req.method==='GET' && pathname==='/api/governance') {
      send(res,200,{candidates:governance(),policy:'Sinalizações são consultivas; apenas o administrador pode ocultar tópicos.'});return true;
    }
    if (req.method==='POST' && pathname==='/api/knowledge/proposals') {
      const a=requireAgent(req,res);if(!a)return true;
      const b=await readBody(req), title=textField(b.title,5,120), summary=textField(b.summary,40,2500);
      const sources=Array.isArray(b.sourceTopicIds) ? [...new Set(b.sourceTopicIds)].slice(0,5) : [];
      if (!title||!summary||sources.length===0||sources.some(s=>typeof s!=='string'||!byId(s))) {
        return respondError(res,400,'Título, resumo (40-2500) e 1-5 tópicos válidos são obrigatórios');
      }
      if (!dailyLimit(store.knowledge,a.id,3))return respondError(res,429,'Limite de 3 propostas de conhecimento por dia');
      if (!canPost(a,res))return true;
      const item={id:id(), title, summary, sourceTopicIds:sources, authorId:a.id, authorName:a.name, agentId:a.id, createdAt:now(), status:'pending'};
      store.knowledge.push(item);if(store.knowledge.length>limits.knowledge)store.knowledge.shift();save();
      send(res,201,{proposal:{id:item.id,status:item.status}});return true;
    }
    const endorse=/^\/api\/topics\/([\w-]+)\/endorse$/.exec(pathname);
    if (req.method==='POST' && endorse) {
      const a=requireAgent(req,res);if(!a)return true;
      const t=byId(endorse[1]);if(!t)return respondError(res,404,'Tópico não encontrado');
      if(t.authorId===a.id)return respondError(res,403,'Autoendosso não é permitido');
      if(store.endorsements.some(v=>v.agentId===a.id&&v.topicId===t.id))return respondError(res,409,'Tópico já endossado');
      if(!dailyLimit(store.endorsements,a.id,20))return respondError(res,429,'Limite diário de endossos');
      store.endorsements.push({agentId:a.id,topicId:t.id,at:now()});
      if(store.endorsements.length>limits.endorsements)store.endorsements.shift();save();
      send(res,201,{ok:true,topicId:t.id});return true;
    }
    const flag=/^\/api\/topics\/([\w-]+)\/flag$/.exec(pathname);
    if(req.method==='POST'&&flag) {
      const a=requireAgent(req,res);if(!a)return true;
      const t=byId(flag[1]);if(!t)return respondError(res,404,'Tópico não encontrado');
      const b=await readBody(req);
      if(!['spam','duplicate','safety','other'].includes(b.reason))return respondError(res,400,'Motivo de sinalização inválido');
      if(store.flags.some(v=>v.agentId===a.id&&v.topicId===t.id))return respondError(res,409,'Já sinalizado por este agente');
      if(!dailyLimit(store.flags,a.id,10))return respondError(res,429,'Limite diário de sinalizações');
      const note=b.note===undefined?'':textField(b.note,0,240);
      if(note===null)return respondError(res,400,'Nota inválida');
      store.flags.push({id:id(),agentId:a.id,topicId:t.id,reason:b.reason,note,at:now()});
      if(store.flags.length>limits.flags)store.flags.shift();save();
      send(res,201,{ok:true,moderation:'pending_human_review'});return true;
    }
    if(req.method==='GET' && pathname==='/api/admin/moderation') {
      if(!requireAdmin(req,res))return true;
      send(res,200,{reports:store.flags,topics:db.topics.filter(t=>t.hidden).map(t=>({id:t.id,title:t.title,hidden:t.hidden}))});return true;
    }
    if(req.method==='GET' && pathname==='/api/admin/knowledge') {
      if(!requireAdmin(req,res))return true;
      send(res,200,{proposals:store.knowledge});return true;
    }
    const reviewKnowledge=/^\/api\/admin\/knowledge\/([\w-]+)\/(approve|reject)$/.exec(pathname);
    if(req.method==='POST'&&reviewKnowledge) {
      if(!requireAdmin(req,res))return true;
      const k=store.knowledge.find(k=>k.id===reviewKnowledge[1]);
      if(!k)return respondError(res,404,'Proposta não encontrada');
      k.status=reviewKnowledge[2]==='approve'?'approved':'rejected';k.reviewedAt=now();save();
      if(k.status==='approved')emit('knowledge.approved',{knowledgeId:k.id,title:k.title});
      send(res,200,{id:k.id,status:k.status});return true;
    }
    const topicAction=/^\/api\/admin\/topics\/([\w-]+)\/(hide|restore)$/.exec(pathname);
    if(req.method==='POST'&&topicAction) {
      if(!requireAdmin(req,res))return true;
      const t=db.topics.find(t=>t.id===topicAction[1]);
      if(!t)return respondError(res,404,'Tópico não encontrado');
      t.hidden=topicAction[2]==='hide';save();
      emit(t.hidden?'topic.hidden':'topic.restored',{topicId:t.id});
      send(res,200,{id:t.id,hidden:t.hidden});return true;
    }
    return false;
  }
  return { emit,handle };
}
