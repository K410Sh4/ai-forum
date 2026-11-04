// Pure UI model for the Operations Board. No Chrome APIs, side effects or
// assumptions about model versions, provider quotas or latency metrics.
export const PROVIDERS=Object.freeze([
  {name:'ChatGPT',glyph:'◎',tone:'#28d1a1',background:'#173b35'},
  {name:'Grok',glyph:'X',tone:'#e0e4ed',background:'#2a2d38'},
  {name:'Gemini',glyph:'✦',tone:'#a58aff',background:'#342b54'},
  {name:'Copilot',glyph:'C',tone:'#ffb28c',background:'#473027'},
  {name:'Meta AI',glyph:'∞',tone:'#73b8ff',background:'#233450'}
]);
export const STATUS=Object.freeze({
  preparando:{label:'Preparando',tone:'active',phase:'Preparando sessão'},
  aguardando:{label:'Aguardando',tone:'active',phase:'Esperando resposta'},
  gerando:{label:'Gerando',tone:'active',phase:'Gerando resposta'},
  validando:{label:'Validando',tone:'active',phase:'Validando JSON'},
  validado:{label:'Revisão',tone:'warning',phase:'Proposta validada'},
  publicando:{label:'Publicando',tone:'active',phase:'Enviando ao AI Forum'},
  publicado:{label:'Publicado',tone:'success',phase:'Publicação confirmada'},
  erro:{label:'Falha',tone:'error',phase:'Erro na operação'},
  interrompido:{label:'Interrompido',tone:'warning',phase:'Sessão interrompida'},
  'aba-descartada':{label:'Aba suspensa',tone:'error',phase:'Aba indisponível'},
  'limite-uso':{label:'Limite de uso',tone:'warning',phase:'Quota do provedor atingida'},
  'falha-publicacao':{label:'Falha no envio',tone:'error',phase:'Publicação não confirmada'},
  'publicacao-incerta':{label:'Envio incerto',tone:'warning',phase:'Verifique o fórum antes de tentar novamente'}
});
export const ISSUE_STATES=new Set(['erro','aba-descartada','limite-uso','falha-publicacao','publicacao-incerta']);
export const TERMINAL_STATES=new Set(['validado','publicado','erro','interrompido','aba-descartada','limite-uso','falha-publicacao','publicacao-incerta']);
export function providerInfo(name){return PROVIDERS.find(x=>x.name===name)||{name:String(name||'IA'),glyph:'?',tone:'#a58aff',background:'#342b54'};}
export function phaseFor(entry,tab){
  if(entry){
    return STATUS[entry.status]||{label:'Em andamento',phase:String(entry.status||'Indefinido'),tone:'active'};
  }
  if(tab?.discarded||tab?.frozen)return {label:'Indisponível',phase:'Ative esta aba antes de iniciar',tone:'warning'};
  return {label:'Disponível',phase:'Aguardando início autorizado',tone:'idle'};
}
export function summarizeSession(session){
  const entries=Object.values(session?.entries||{});
  const total=entries.length;
  const published=entries.filter(e=>e.status==='publicado'&&e.receipt?.id&&e.receipt?.topicId).length;
  const validated=entries.filter(e=>e.status==='validado'||e.status==='publicado'||e.status==='publicando').length;
  const issues=entries.filter(e=>ISSUE_STATES.has(e.status)).length;
  const pending=entries.filter(e=>!TERMINAL_STATES.has(e.status)).length;
  const finished=entries.filter(e=>TERMINAL_STATES.has(e.status)).length;
  return {total,published,validated,issues,pending,finished,percent:total?Math.round(finished*100/total):0};
}
export function sanitizedPreview(session){
  if(!session)return null;
  const summary=summarizeSession(session);
  return {
    sessionId:String(session.id||'').slice(0,64),
    status:session.running?'em andamento':session.endedAt?'encerrada':'preparando',
    quantidadeIAs:summary.total,
    publicacoesConfirmadas:summary.published,
    pendentesDeRevisao:Object.values(session.entries||{}).filter(e=>e.status==='validado').length,
    publicacoes:Object.values(session.entries||{})
      .filter(e=>e.status==='publicado'&&e.receipt?.id)
      .map(e=>({provedor:String(e.provider).slice(0,30),id:String(e.receipt.id).slice(0,80)}))
  };
}
