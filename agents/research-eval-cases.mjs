// Small, fixed, human-auditable contrast set for the local Qwen 7B.
// Not a representative production benchmark or a proof of factual reliability.
// Order is interleaved so --cases N samples supported, contradicted and unknown.
export const RESEARCH_EVAL_CASES = Object.freeze([
  { id: 'mit-groups-ok', category: 'translation-quantities', expected: 'supported',
    evidence: 'Five MIT faculty members and two additional alumni are honored with fellowships.',
    claim: 'Cinco docentes do MIT e dois ex-alunos receberam bolsas.' },
  { id: 'mit-groups-swapped', category: 'translation-quantities', expected: 'contradicted',
    evidence: 'Five MIT faculty members and two additional alumni are honored with fellowships.',
    claim: 'Dois docentes do MIT e cinco ex-alunos receberam bolsas.' },
  { id: 'mit-benefits-invented', category: 'unsupported-outcome', expected: 'insufficient',
    evidence: 'Five MIT faculty members and two additional alumni are honored with fellowships to advance research.',
    claim: 'As bolsas já produziram avanços científicos comprovados.' },

  { id: 'latency-fell-ok', category: 'numerical-direction', expected: 'supported',
    evidence: 'Median latency decreased from 120 milliseconds to 95 milliseconds on the test machine.',
    claim: 'A latência mediana diminuiu de 120 para 95 milissegundos.' },
  { id: 'latency-inverted', category: 'numerical-direction', expected: 'contradicted',
    evidence: 'Median latency decreased from 120 milliseconds to 95 milliseconds on the test machine.',
    claim: 'A latência mediana aumentou de 95 para 120 milissegundos.' },
  { id: 'latency-global', category: 'unsupported-generalization', expected: 'insufficient',
    evidence: 'Median latency decreased from 120 milliseconds to 95 milliseconds on the test machine.',
    claim: 'O sistema ficou mais rápido em todos os dispositivos existentes.' },

  { id: 'participants-ok', category: 'entity-scope', expected: 'supported',
    evidence: 'The pilot enrolled twelve adult participants at one research site.',
    claim: 'O estudo-piloto incluiu doze adultos em um local de pesquisa.' },
  { id: 'participants-wrong', category: 'entity-scope', expected: 'contradicted',
    evidence: 'The pilot enrolled twelve adult participants at one research site.',
    claim: 'O estudo-piloto incluiu vinte e um adultos.' },
  { id: 'participants-hospital', category: 'unsupported-generalization', expected: 'insufficient',
    evidence: 'The pilot enrolled twelve adult participants at one research site.',
    claim: 'A eficácia do método foi comprovada em hospitais de todo o mundo.' },

  { id: 'no-training-ok', category: 'negation', expected: 'supported',
    evidence: 'No new model training was performed during the experiment.',
    claim: 'Nenhum novo treinamento de modelo foi realizado durante o experimento.' },
  { id: 'no-training-inverted', category: 'negation', expected: 'contradicted',
    evidence: 'No new model training was performed during the experiment.',
    claim: 'Os pesquisadores treinaram um novo modelo durante o experimento.' },
  { id: 'no-training-performance', category: 'unsupported-outcome', expected: 'insufficient',
    evidence: 'No new model training was performed during the experiment.',
    claim: 'A nova versão superou todas as alternativas em precisão.' },

  { id: 'os-linux-ok', category: 'platform-scope', expected: 'supported',
    evidence: 'The software was evaluated only on Linux; no Windows tests were performed.',
    claim: 'O programa foi avaliado apenas no Linux.' },
  { id: 'os-windows-invented', category: 'platform-scope', expected: 'contradicted',
    evidence: 'The software was evaluated only on Linux; no Windows tests were performed.',
    claim: 'O programa também foi testado no Windows.' },
  { id: 'os-android', category: 'platform-scope', expected: 'insufficient',
    evidence: 'The software was evaluated only on Linux; no Windows tests were performed.',
    claim: 'Uma versão Android está planejada para lançamento em dezembro.' },

  { id: 'ai-benchmark-ok', category: 'technical-terminology', expected: 'supported',
    evidence: 'We introduce a Curriculum of Latent Rules benchmark to evaluate the learning of hidden rules.',
    claim: 'Foi apresentado um benchmark de regras latentes para avaliar o aprendizado de regras ocultas.' },
  { id: 'ai-benchmark-deployment', category: 'technical-terminology', expected: 'contradicted',
    evidence: 'We introduce a benchmark for testing learning of hidden rules; the paper reports no deployment.',
    claim: 'O artigo descreve a implantação prática da tecnologia.' },
  { id: 'ai-benchmark-rules', category: 'technical-terminology', expected: 'insufficient',
    evidence: 'The task reveals member and non-member examples during practice and tests unseen items.',
    claim: 'O modelo resolve a tarefa escrevendo cada nova correção como uma exceção.' }
]);
export const RESEARCH_EVAL_LABELS = Object.freeze(['supported', 'contradicted', 'insufficient']);

export function summarizeResearchEval(entries) {
  const valid = entries.filter(row => RESEARCH_EVAL_LABELS.includes(row.predicted));
  const eligible = entries.filter(row => row.expected !== 'supported');
  const falseSupport = eligible.filter(row => row.predicted === 'supported').length;
  return {
    total: entries.length,
    valid: valid.length,
    correct: entries.filter(row => row.predicted === row.expected).length,
    accuracy: entries.length ? entries.filter(row => row.predicted === row.expected).length / entries.length : null,
    errors: entries.length - valid.length,
    falseSupport,
    falseSupportRate: eligible.length ? falseSupport / eligible.length : null,
    averageMilliseconds: entries.length ? Math.round(entries.reduce((sum, row) => sum + (row.milliseconds || 0), 0) / entries.length) : null
  };
}
