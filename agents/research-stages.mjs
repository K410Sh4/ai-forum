// Pure boundaries between model output, literal source evidence and publication prose.
// Only selected RSS spans count as evidence; model summaries are never evidence.
import { validateCard } from './research-core.mjs';

const HAS_ALUMNI = /\balumni\b/iu;
const BAD_ALUNIS = /\balunis\b/giu;

export function prepareSourceCard(raw, source, spans) {
  // Repair a *known* morphology-only translation after confirming the exact
  // source fragment contains the English term. No generic text rewriting,
  // numeric inference, or fabricated evidence is permitted.
  const changes = [];
  const facts = Array.isArray(raw?.facts) ? raw.facts.map((fact, index) => {
    if (typeof fact?.statement !== 'string' || !BAD_ALUNIS.test(fact.statement)) {
      BAD_ALUNIS.lastIndex = 0;
      return fact;
    }
    BAD_ALUNIS.lastIndex = 0;
    const quote = spans.find(span => span.id === fact.evidenceId)?.text || '';
    if (!HAS_ALUMNI.test(quote)) return fact;
    const statement = fact.statement.replace(BAD_ALUNIS, 'ex-alunos');
    changes.push({ field: 'facts[' + index + '].statement', rule: 'alumni-to-ex-alunos',
      original: fact.statement, corrected: statement, evidenceId: fact.evidenceId });
    return { ...fact, statement };
  }) : raw?.facts;
  // The core validator still checks all fields, original quote provenance,
  // evidenceId, numbers, complete sentences and unsupported domains.
  const checked = validateCard({ ...raw, facts }, source, { spans, requireSelection: true });
  return changes.length ? { ...checked, normalizations: changes } : checked;
}

export function compactEvidenceCards(cards) {
  return cards.map(card => ({
    sourceId: card.sourceId,
    // Never pass card.summary or card.limitations to the writer: both were
    // model-written and may contain ungrounded interpretations.
    facts: card.facts.slice(0, 2).map(fact => ({
      statement: fact.statement,
      quote: fact.quote
    }))
  }));
}

export function retryDirective(stage, error) {
  const reason = String(error?.message || '');
  if (stage.startsWith('source-')) {
    if (/invalid Portuguese inflection in source fact/u.test(reason))
      return '\nCorrija especificamente facts[].statement: "alunis" não é português; se o trecho original diz "alumni", escreva "ex-alunos". Preserve todos os números, nomes e evidenceId. Não invente informação.';
    if (/Numeric fact is absent from its evidence quote/u.test(reason))
      return '\nConfira facts[].statement: cada número deve existir literalmente no trecho indicado por evidenceId. Não some grupos, não converta bolsistas em docentes e não adivinhe quantidades.';
    if (/existing evidenceId|Evidence quote was not found/u.test(reason))
      return '\nUse somente evidenceId listado em collectedEvidence. O programa recupera a citação original; não crie quote nem referência.';
    if (/educational claim|medical claim|transfer learning/u.test(reason))
      return '\nRemova a aplicação inventada ou o termo mal traduzido de facts[].statement; descreva somente o fenômeno mencionado no trecho indicado, sem alterar o evidenceId.';
    return '\nCorrija somente os campos inválidos, mantendo 1-2 fatos diretamente comprováveis por collectedEvidence, frases completas e evidenceId existente. Não invente fatos.';
  }
  if (stage === 'plan')
    return '\nReenvie kind=analysis ou roundup e angle com uma única frase de 50 a 110 caracteres, sem URL ou nomes em lista; não invente ligação entre fontes.';
  if (stage === 'draft') {
    if (/Invalid overview|Incomplete overview/u.test(reason))
      return '\nO campo overview deve ter 160 a 450 caracteres; corrija a síntese (prefira 200 a 260), em duas frases completas: uma frase por fonte, sem juntar pesquisas não relacionadas. Use exclusivamente evidenceCards.facts.';
    if (/Factual grounding/u.test(reason))
      return '\nRemova do campo apontado qualquer afirmação não ancorada nos fatos selecionados. Não declare revolução, superioridade, educação ou ausência de testes sem apoio explícito.';
    return '\nReescreva apenas o necessário para validar os campos JSON, mantendo overview com 160 a 450 caracteres e cada perspectiva com argumento completo. Não invente fatos.';
  }
  if (stage === 'review')
    return '\nReavalie cada claimId existente, usando apenas evidenceCards.quotes; categorize problemas materiais, e deixe lacunas de detalhes como missing-detail. Sem URLs nos motivos.';
  return '\nCorrija os campos inválidos sem alterar fatos, números ou referências; escreva frases completas em português brasileiro.';
}
