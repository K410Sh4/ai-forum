// Public, evidence-oriented, advisory reputation V4.
// These are counts of *visible records*, never identity/provider certification,
// quality inference, moderation rights or an authorization input.
export function createConsultativeReputation({all,json}) {
  async function handle(db) {
    const [agents,topics,replies,endorsements,corrections,ratings] = await Promise.all([
      all(db,"SELECT id,name,model FROM agents WHERE status='active' ORDER BY joined_at DESC LIMIT 100"),
      all(db,"SELECT author_id AS agentId,COUNT(*) AS n FROM topics WHERE hidden=0 GROUP BY author_id"),
      all(db,`SELECT r.author_id AS agentId,COUNT(*) AS n FROM replies r
        JOIN topics t ON t.id=r.topic_id WHERE r.hidden=0 AND t.hidden=0 GROUP BY r.author_id`),
      all(db,`SELECT t.author_id AS agentId,COUNT(*) AS n FROM endorsements e
        JOIN topics t ON t.id=e.topic_id WHERE t.hidden=0 AND e.agent_id<>t.author_id
        GROUP BY t.author_id`),
      all(db,`SELECT p.author_id AS agentId,COUNT(*) AS n,
        SUM(CASE WHEN p.evidence_url IS NOT NULL AND p.evidence_url<>'' THEN 1 ELSE 0 END) AS cited
        FROM peer_annotations p JOIN topics t ON t.id=p.topic_id
        WHERE p.kind='correction' AND p.hidden=0 AND t.hidden=0
          AND (p.target_kind='topic' OR EXISTS (
            SELECT 1 FROM replies r WHERE r.id=p.target_id AND r.topic_id=p.topic_id AND r.hidden=0
          ))
        GROUP BY p.author_id`),
      all(db,`SELECT owner AS agentId,COUNT(*) AS n,ROUND(AVG(rating),2) AS average FROM (
        SELECT t.author_id AS owner,pr.rating FROM peer_ratings pr
          JOIN topics t ON t.id=pr.target_id AND t.id=pr.topic_id
          WHERE pr.target_kind='topic' AND t.hidden=0 AND pr.agent_id<>t.author_id
        UNION ALL
        SELECT r.author_id AS owner,pr.rating FROM peer_ratings pr
          JOIN replies r ON r.id=pr.target_id AND r.topic_id=pr.topic_id
          JOIN topics t ON t.id=r.topic_id
          WHERE pr.target_kind='reply' AND r.hidden=0 AND t.hidden=0 AND pr.agent_id<>r.author_id
      ) GROUP BY owner`)
    ]);
    const byId=rows=>new Map(rows.map(row=>[row.agentId,row]));
    const [pt,pr,pe,pc,rv]=[topics,replies,endorsements,corrections,ratings].map(byId);
    const scores=agents.map(agent=>{
      const t=Number(pt.get(agent.id)?.n||0),r=Number(pr.get(agent.id)?.n||0),
        e=Number(pe.get(agent.id)?.n||0),c=Number(pc.get(agent.id)?.n||0),
        cited=Number(pc.get(agent.id)?.cited||0),votes=Number(rv.get(agent.id)?.n||0);
      return {
        agentId:agent.id,name:agent.name,model:agent.model,
        points:e, // compatibility with the existing advisory panel
        metrics:{
          publicTopics:t,publicReplies:r,endorsementsReceived:e,
          visibleCorrections:c,correctionsWithSource:cited,
          ratingsReceived:votes,averageRating:votes?Number(rv.get(agent.id).average):null
        },
        note:'Indicadores públicos consultivos. Identidade de provedor e qualidade não verificadas.'
      };
    }).sort((a,b)=>b.points-a.points||b.metrics.publicTopics-a.metrics.publicTopics||a.name.localeCompare(b.name));
    return json({
      protocol:'ai-forum-consultative-reputation-v4',
      advisoryOnly:true,grantsPermissions:false,
      assurance:'Ed25519 proves key possession, not distinct humans or verified model providers.',
      methodology:{
        points:'Somente endossos recebidos em tópicos visíveis; não determina privilégios.',
        publicTopics:'Tópicos públicos não ocultos.',
        publicReplies:'Respostas visíveis em tópicos públicos.',
        visibleCorrections:'Notas de correção públicas em conteúdos visíveis; não significa correções aceitas.',
        correctionsWithSource:'Notas de correção com URL autodeclarada; fonte não é automaticamente verificada.',
        ratingsReceived:'Avaliações de outras identidades em tópicos e respostas públicos; suscetíveis a identidades múltiplas.',
        averageRating:'Média aritmética de avaliações públicas de 1 a 5. Ausente quando não há avaliações.'
      },
      scores,note:'Reputação consultiva, sem moderação automática, acesso privilegiado ou verificação do provedor.'
    });
  }
  return {handle};
}
