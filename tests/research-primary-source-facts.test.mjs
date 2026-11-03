import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNumbersFromEvidence, assertNumbersByGroupFromEvidence } from '../agents/research-numbers.mjs';
import { validateSourceClaimGrounding } from '../agents/research-core.mjs';

// Small literal excerpts checked against primary publisher pages on 2026-11-02.
// Never expand these into a simulated complete article or claim semantic verification.
// MIT: https://news.mit.edu/2026/mit-affiliates-named-schmidt-sciences-ai2050-fellows-1030
const mitLead = 'Five MIT faculty members and two additional alumni are honored with fellowships to advance research on beneficial AI.';
// Nature: https://doi.org/10.1038/s42256-026-01323-8
const natureAbstract = 'Artificial intelligence (AI) providers frequently update their models and system integrations without corresponding changes to their public identifiers.';
// arXiv: https://arxiv.org/abs/2610.40758
const clrDefinition = 'We introduce CLR-Bench, a Curriculum of Latent Rules benchmark.';

test('primary MIT lead supports five faculty and two alumni, but not invented/swapped quantities', () => {
  const supported = 'Cinco docentes e dois ex-alunos receberam bolsas para pesquisas sobre IA.';
  assert.doesNotThrow(() => assertNumbersFromEvidence(supported, mitLead));
  assert.doesNotThrow(() => assertNumbersByGroupFromEvidence(supported, mitLead));
  const inverted = 'Dois docentes e cinco ex-alunos receberam bolsas para pesquisa.';
  assert.doesNotThrow(() => assertNumbersFromEvidence(inverted, mitLead));
  assert.throws(() => assertNumbersByGroupFromEvidence(inverted, mitLead), /unsupported source group/);
  // 2026 occurs elsewhere on the source page (headline/date), not in this quote.
  assert.throws(() => assertNumbersFromEvidence('O MIT anunciou 2026 bolsistas.', mitLead),
    /Numeric fact is absent from its evidence quote: 2026/);
});

test('Nature versioning claim cannot alone support new quantities or a measured effect', () => {
  assert.doesNotThrow(() => assertNumbersFromEvidence(
    'Os provedores de IA atualizam modelos sem mudar identificadores públicos.', natureAbstract));
  assert.throws(() => assertNumbersFromEvidence(
    'O artigo mediu 100 melhorias na precisão dos modelos.', natureAbstract),
    /Numeric fact is absent from its evidence quote: 100/);
});

test('CLR-Bench literal definition does not authorize uncited benchmark quantities', () => {
  assert.doesNotThrow(() => validateSourceClaimGrounding(
    'O CLR-Bench é apresentado como um benchmark.', clrDefinition));
  assert.throws(() => assertNumbersFromEvidence(
    'O CLR-Bench avaliou 20 cadeias em 10 domínios.', clrDefinition),
    /Numeric fact is absent from its evidence quote/);
});
