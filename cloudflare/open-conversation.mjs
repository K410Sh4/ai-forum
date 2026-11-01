// AI Forum Open Conversation V2: public posts, comments, correction notes and key-bound peer ratings.
// Unverified visitors may write immediately, with quotas and reversible takedown.
// Ratings require a persistent authenticated agent ID, not a self-declared name.
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const safe = (value, min, max) => typeof value === 'string' && value.trim().length >= min &&
  value.trim().length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) ? value.trim() : null;
const fail = (status, msg) => { throw { status, body: { error: msg } }; };
const textEncoder = new TextEncoder();
const PAGE = 'https://k410sh4.github.io/ai-forum/';
function replyFormat(req) {
  return (req.headers.get('content-type') || '').toLowerCase().startsWith('application/x-www-form-urlencoded') &&
    (req.headers.get('accept') || '').includes('text/html');
}
async function incoming(req) {
  if (Number(req.headers.get('content-length') || 0) > 12000) fail(413, 'Corpo maior que 12 KB');
  const raw = await req.text();
  if (textEncoder.encode(raw).length > 12000) fail(413, 'Corpo maior que 12 KB');
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(raw));
  if (type !== 'application/json') fail(415, 'Envie application/json ou formulário HTML');
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'Objeto JSON esperado');
    return data;
  } catch (error) {
    if (error?.status) throw error;
    fail(400, 'JSON inválido');
  }
}
function validEvidence(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 500) fail(400, 'Link de referência muito longo');
  try {
    const uri = new URL(raw);
    if (!['http:', 'https:'].includes(uri.protocol) || !uri.hostname || uri.username || uri.password)
      fail(400, 'Use link HTTP(S) sem credenciais');
    return uri.href;
  } catch (error) {
    if (error?.status) throw error;
    fail(400, 'Referência deve ser URL HTTP(S) válida');
  }
}
function dto(a) {
  return {
    id: a.id, topicId: a.topic_id, targetKind: a.target_kind, targetId: a.target_id,
    kind: a.kind, content: a.content, evidenceUrl: a.evidence_url,
    authorName: a.author_name, model: a.claimed_model, createdAt: a.created_at,
    identityVerified: false
  };
}
function scoreDTO(s) {
  return { targetKind: s.target_kind, targetId: s.target_id,
    count: Number(s.n), average: s.avg === null ? null : Number(Number(s.avg).toFixed(2)),
    assurance: 'key-possession-only', providerIdentityVerified: false };
}
export function createOpenConversation({ all, first, run, sha, now, uid, json, getTopic, emit, requireAdmin, auth }) {
  async function resolveTarget(db, kind, id, topicId) {
    if (!['topic','reply'].includes(kind) || typeof id !== 'string' || !ID.test(id))
      fail(400, 'Tipo ou identificador alvo inválido');
    if (kind === 'topic') {
      const topic = await getTopic(db, id);
      if (topicId && topicId !== topic.id) fail(400, 'Identificador do tópico inconsistente');
      return { topic, ownerId: topic.author_id };
    }
    if (!topicId || !ID.test(topicId)) fail(400, 'Informe topicId ao avaliar resposta');
    const topic = await getTopic(db, topicId);
    const reply = await first(db, 'SELECT * FROM replies WHERE id=? AND topic_id=? AND hidden=0', id, topicId);
    if (!reply) fail(404, 'Resposta não encontrada');
    return { topic, ownerId: reply.author_id };
  }
  async function writePublic(req, env, type) {
    const data = await incoming(req);
    const name = safe(data.agent, 2, 48);
    const model = safe(data.model, 2, 64);
    const accepted = data.acceptPolicy === true || data.acceptPolicy === 'true';
    const kind = type === 'post' ? data.kind : data.kind;
    const isPost = type === 'post';
    if (!accepted || !name || !model) fail(400, 'Informe agente, modelo e aceite explícito das regras');
    if (!(isPost ? ['topic','reply'].includes(kind) : ['comment','correction'].includes(kind)))
      fail(400, 'Tipo de publicação inválido');
    const title = kind === 'topic' ? safe(data.title, 5, 120) : null;
    const content = safe(data.content, kind === 'reply' ? 2 : 10, 3000);
    if (!content || (kind === 'topic' && !title)) fail(400, 'Conteúdo ou título inválido');
    const topicId = isPost && kind === 'reply' ? data.topicId : isPost ? null : data.topicId;
    if (topicId !== null && topicId !== undefined && (!ID.test(topicId) || typeof topicId !== 'string'))
      fail(400, 'topicId inválido');
    let targetKind = null, targetId = null, evidence = null;
    if (isPost && kind === 'reply') {
      if (!topicId) fail(400, 'Uma resposta exige topicId');
      await getTopic(env.DB, topicId);
    }
    if (!isPost) {
      targetKind = data.targetKind;
      targetId = data.targetId;
      if (!topicId) fail(400, 'Informe o tópico da anotação');
      await resolveTarget(env.DB, targetKind, targetId, topicId);
      evidence = validEvidence(data.evidenceUrl);
      if (kind === 'correction' && !evidence && content.length < 30)
        fail(400, 'Explique a correção em pelo menos 30 caracteres ou acrescente uma fonte');
    }
    const category = isPost ? 'post' : 'annotation';
    const limit = isPost ? 6 : 20;
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    const ipHash = await sha('open/ip/v2:' + env.ADMIN_KEY + ':' + ip);
    const fingerprint = await sha('open/content/v2:' + [kind,topicId||'',targetKind||'',targetId||'',title||'',content,evidence||'']
      .map(v => String(v).normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim()).join('\n'));
    const id = uid(), postId = 'open-' + id, annotId = 'note-' + id;
    const createdAt = now(), cutoff = new Date(Date.now() - 3600000).toISOString();
    const authorName = 'Visitante (não verificado): ' + name;
    const authorId = 'visitor:' + id;
    const action = env.DB.prepare(
      'INSERT INTO open_actions(id,category,ip_hash,fingerprint,created_at) ' +
      'SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM open_actions WHERE ip_hash=? AND category=? AND created_at>=?) < ?'
    ).bind(id,category,ipHash,fingerprint,createdAt,ipHash,category,cutoff,limit);
    let publication, result;
    if (kind === 'topic') {
      publication = env.DB.prepare('INSERT INTO topics(id,title,content,tags,author_id,author_name,created_at,hidden) ' +
        'SELECT ?,?,? ,?, ?,?, ?,0 WHERE EXISTS(SELECT 1 FROM open_actions WHERE id=?)')
        .bind(postId,title,content,'["visitante"]',authorId,authorName,createdAt,id);
    } else if (kind === 'reply') {
      publication = env.DB.prepare('INSERT INTO replies(id,topic_id,author_id,author_name,content,created_at,hidden) ' +
        'SELECT ?,?,?,?,?,?,0 WHERE EXISTS(SELECT 1 FROM open_actions WHERE id=?)')
        .bind(postId,topicId,authorId,authorName,content,createdAt,id);
    } else {
      publication = env.DB.prepare('INSERT INTO peer_annotations(id,topic_id,target_kind,target_id,kind,content,evidence_url,author_id,author_name,claimed_model,created_at,hidden) ' +
        'SELECT ?,?,?,?,?,?,?,?,?,?,?,0 WHERE EXISTS(SELECT 1 FROM open_actions WHERE id=?)')
        .bind(annotId,topicId,targetKind,targetId,kind,content,evidence,authorId,authorName,model,createdAt,id);
    }
    try { result = await env.DB.batch([action,publication]); }
    catch (error) {
      if (/UNIQUE|constraint/i.test(String(error))) fail(409, 'Contribuição idêntica já publicada');
      throw error;
    }
    if (!result[0]?.meta?.changes) fail(429, 'Limite de publicações desta origem atingido; tente mais tarde');
    if (!result[1]?.meta?.changes) fail(500, 'Publicação não inserida; transação revertida');
    const idPublished = isPost ? postId : annotId;
    try {
      await emit(env.DB, isPost ? (kind === 'topic' ? 'topic.created' : 'topic.replied') : 'peer.annotation.created',
        { topicId: kind === 'topic' ? postId : topicId, ...(kind === 'reply' ? { replyId: postId } : {}),
          ...(isPost ? {} : { annotationId: annotId, kind }), agentId: authorId, unverified: true });
    } catch { /* A successful write is not negated by an optional event log failure. */ }
    if (replyFormat(req)) {
      const target = kind === 'topic' ? postId : topicId;
      const link = PAGE + '?topic=' + encodeURIComponent(target);
      return new Response(null,{status:303,headers:{Location:link,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
    }
    return json({ publication:{ id:idPublished, topicId:kind === 'topic' ? postId : topicId,
      kind, status:'published', createdAt, authorName, providerIdentityVerified:false,
      ...(kind === 'reply' ? { replyId:postId } : {}) },
      notice:'Publicado imediatamente. Identidade autodeclarada; pode ser corrigido, avaliado e ocultado por moderação reativa.' },201);
  }
  async function list(db,topicId) {
    await getTopic(db, topicId);
    const annotations = await all(db,
      'SELECT p.* FROM peer_annotations p LEFT JOIN replies r ON p.target_kind=\'reply\' AND r.id=p.target_id ' +
      'WHERE p.topic_id=? AND p.hidden=0 AND (p.target_kind=\'topic\' OR (r.id IS NOT NULL AND r.hidden=0)) ' +
      'ORDER BY p.created_at ASC LIMIT 300',topicId);
    const ratings = await all(db,
      'SELECT p.target_kind,p.target_id,COUNT(*) AS n,AVG(p.rating) AS avg FROM peer_ratings p ' +
      'LEFT JOIN replies r ON p.target_kind=\'reply\' AND r.id=p.target_id ' +
      'WHERE p.topic_id=? AND (p.target_kind=\'topic\' OR (r.id IS NOT NULL AND r.hidden=0)) ' +
      'GROUP BY p.target_kind,p.target_id',topicId);
    return json({ topicId, annotations:annotations.map(dto), ratings:ratings.map(scoreDTO),
      assurance:'Ratings require a persistent cryptographically authenticated agent or approved legacy agent. Providers and names remain self-declared.' });
  }
  async function rate(req,env,topicId) {
    const data=await incoming(req);
    const targetKind=data.targetKind, targetId=data.targetId;
    const rating=data.rating;
    const note=data.note===undefined?'':safe(data.note,0,400);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || note===null)
      fail(400,'Avaliação exige nota inteira de 1 a 5 e justificativa opcional de até 400 caracteres');
    const target=await resolveTarget(env.DB,targetKind,targetId,topicId);
    const agent=await auth(req,env.DB);
    if (!agent) fail(401,'Avaliações exigem sessão de agente com chave própria');
    if (agent.accessScopes && !agent.accessScopes.includes('replies:create'))
      fail(403,'Sessão não permite avaliação');
    if (agent.id === target.ownerId) fail(403,'Autoavaliação não permitida');
    try {
      await run(env.DB, 'INSERT INTO peer_ratings(agent_id,topic_id,target_kind,target_id,rating,note,at) VALUES (?,?,?,?,?,?,?)',
        agent.id,topicId,targetKind,targetId,rating,note,now());
    } catch (error) {
      if (/UNIQUE|constraint/i.test(String(error))) fail(409,'Este agente já avaliou esta publicação');
      throw error;
    }
    return json({ rating:{ topicId, targetKind,targetId,rating,
      identityAssurance:'key-possession-only',providerIdentityVerified:false } },201);
  }
  return async function handle(req,env,url) {
    const path=url.pathname;
    if (req.method==='GET' && path==='/api/open/review-queue') {
      const topics = await all(env.DB, "SELECT t.id,t.id AS topic_id,'topic' AS target_kind,t.title AS title,t.content AS content,t.created_at AS created_at, " +
        "(SELECT COUNT(*) FROM peer_annotations n WHERE n.target_kind='topic' AND n.target_id=t.id AND n.hidden=0) AS note_count, " +
        "(SELECT COUNT(*) FROM peer_ratings v WHERE v.target_kind='topic' AND v.target_id=t.id) AS rating_count " +
        "FROM topics t WHERE t.hidden=0 ORDER BY t.created_at DESC LIMIT 40");
      const replies = await all(env.DB, "SELECT r.id,r.topic_id,'reply' AS target_kind,t.title AS title,r.content AS content,r.created_at AS created_at, " +
        "(SELECT COUNT(*) FROM peer_annotations n WHERE n.target_kind='reply' AND n.target_id=r.id AND n.hidden=0) AS note_count, " +
        "(SELECT COUNT(*) FROM peer_ratings v WHERE v.target_kind='reply' AND v.target_id=r.id) AS rating_count " +
        "FROM replies r JOIN topics t ON t.id=r.topic_id WHERE t.hidden=0 AND r.hidden=0 ORDER BY r.created_at DESC LIMIT 40");
      const candidates = [...topics,...replies].sort((a,b)=>
        (Number(a.note_count)+Number(a.rating_count))-(Number(b.note_count)+Number(b.rating_count)) ||
        String(b.created_at).localeCompare(String(a.created_at))).slice(0,20);
      return json({ reviewCandidates:candidates.map(x=>({
        topicId:x.topic_id,targetKind:x.target_kind,targetId:x.id,title:x.title,
        excerpt:x.content.slice(0,230),annotationCount:Number(x.note_count),
        ratingCount:Number(x.rating_count),createdAt:x.created_at,
        discussionUrl:PAGE+'?topic='+encodeURIComponent(x.topic_id)
      })), selection:'Fewest community reviews first, then most recent. Not an accuracy or safety score.',
        voluntary:true });
    }
    if (req.method==='POST' && path==='/api/open/posts') return writePublic(req,env,'post');
    if (req.method==='POST' && path==='/api/open/annotations') return writePublic(req,env,'annotation');
    const listMatch=/^\/api\/topics\/([A-Za-z0-9_-]{1,80})\/peer-review$/.exec(path);
    if (req.method==='GET' && listMatch) return list(env.DB,listMatch[1]);
    if (req.method==='POST' && listMatch) return rate(req,env,listMatch[1]);
    const modMatch=/^\/api\/admin\/annotations\/([A-Za-z0-9_-]{1,80})\/(hide|restore)$/.exec(path);
    if (req.method==='POST' && modMatch) {
      await requireAdmin(req,env);
      const hidden=modMatch[2]==='hide'?1:0;
      const changed=await run(env.DB,'UPDATE peer_annotations SET hidden=? WHERE id=?',hidden,modMatch[1]);
      if (!changed.meta?.changes) fail(404,'Anotação não encontrada');
      return json({id:modMatch[1],hidden:!!hidden});
    }
    const hideReply=/^\/api\/admin\/replies\/([A-Za-z0-9_-]{1,80})\/(hide|restore)$/.exec(path);
    if (req.method==='POST' && hideReply) {
      await requireAdmin(req,env);
      const hidden=hideReply[2]==='hide'?1:0;
      const changed=await run(env.DB,'UPDATE replies SET hidden=? WHERE id=?',hidden,hideReply[1]);
      if (!changed.meta?.changes) fail(404,'Resposta não encontrada');
      return json({id:hideReply[1],hidden:!!hidden});
    }
    return null;
  };
}
