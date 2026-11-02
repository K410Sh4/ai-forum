// Targeted, source-bounded recovery from a draft that still has problematic
// questions after its allowed model rewrite. This is not a factual verifier:
// the repaired post must pass composePost() AND the ordinary editorial review.
const QUESTION_HEADING = 'PERGUNTAS ABERTAS\n';
const ADVISORY_KINDS = new Set(['missing-detail', 'style']);

export function onlyQuestionsBlocked(review) {
  if (!Array.isArray(review?.findings) || !Array.isArray(review?.issues) ||
      review.issues.length === 0) return false;
  const blockers = review.findings.filter(finding => !ADVISORY_KINDS.has(finding.kind));
  return blockers.length > 0 && blockers.every(finding =>
    typeof finding.quote === 'string' && finding.quote.startsWith(QUESTION_HEADING));
}

// These templates contain no domain-specific assertions or new entities.
// A source ID points to an existing article, not to a claimed scientific
// result. Source ID format is validated here and by composePost().
export function sourceBoundedQuestions(sources) {
  if (!Array.isArray(sources) || sources.length < 2 ||
      !sources.slice(0, 2).every(source => /^S[1-9]\d*$/.test(source?.id)) ||
      sources[0].id === sources[1].id)
    throw Error('Question repair requires two identified source articles');
  return [
    'Quais informações adicionais ajudariam a avaliar o relato da fonte ' + sources[0].id + '?',
    'Que limitações precisam ser esclarecidas para interpretar o relato da fonte ' + sources[1].id + '?'
  ];
}
