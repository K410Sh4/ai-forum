import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEditorialGrounding, validateSourceClaimGrounding, validateCard, evidenceSpans, composePost } from '../agents/research-core.mjs';

const source = {
  id: 'S2',
  summary: 'EVENET is a foundation model pre-trained on simulated particle collisions. The model transfers to several analysis tasks and has demonstrated use on real collider data.'
};
const card = (statement, evidenceId = evidenceSpans(source.summary)[0].id) => ({
  summary: 'O estudo relata uma aplicação de um modelo de fundação em física de partículas.',
  facts: [{ statement, evidenceId }],
  limitations: 'O resumo não estabelece aplicação operacional generalizada.'
});
const articles = [
  { id: 'S1', publisherId: 'mit', title: 'MIT affiliates named fellows', summary: 'MIT named researchers to its fellowship programme.', publishedAt: '2026-10-30T00:00:00.000Z', url: 'https://news.mit.edu/a' },
  { id: 'S2', publisherId: 'nature', title: 'Foundation model for particle data', summary: source.summary, publishedAt: '2026-10-29T00:00:00.000Z', url: 'https://www.nature.com/a' }
];
const opening = () => ({
  title: 'Bolsas de pesquisa e modelos de física de partículas',
  overview: 'O MIT anunciou a seleção de pesquisadores para bolsas de investigação em inteligência artificial. Separadamente, um estudo descreveu o EVENET como modelo para análises de física de partículas.',
  uncertainties: 'Os resumos disponíveis não permitem avaliar todas as etapas da integração operacional do sistema.',
  perspectives: [
    { label: 'Bolsas', argument: 'O programa de financiamento apresenta objetivos de pesquisa que podem ser debatidos.', caveat: 'A nomeação não é uma demonstração de avanço técnico.' },
    { label: 'Análise de dados', argument: 'O estudo apresenta uma abordagem de reutilização de modelos em tarefas de física.', caveat: 'São necessários testes adicionais em outros contextos operacionais.' }
  ],
  questions: ['Quais limites foram relatados?', 'Que experimentos adicionais seriam úteis?'],
  sourceIds: ['S1','S2'],
  findings: [
    { text: 'O MIT selecionou pesquisadores para um programa de bolsas de investigação.', sourceIds: ['S1'] },
    { text: 'O EVENET foi apresentado como um modelo para tarefas de análise de física.', sourceIds: ['S2'] }
  ]
});

test('source quotes alone do not authorize invented educational or medical applications', () => {
  const quote = source.summary;
  assert.throws(() => validateSourceClaimGrounding('O EVENET é uma inovação educacional.', quote), /educational claim/);
  assert.throws(() => validateSourceClaimGrounding('O modelo foi testado em hospitais.', quote), /medical claim/);
  assert.throws(() => validateSourceClaimGrounding('O EVENET transmite-se para tarefas de análise.', quote), /transfer learning/);
  assert.throws(() => validateSourceClaimGrounding('Cinco alunis receberam bolsas de investigação.', quote), /Portuguese inflection/);
  assert.doesNotThrow(() => validateSourceClaimGrounding('O estudo descreveu um modelo de fundação para dados de colisores.', quote));
  assert.doesNotThrow(() => validateSourceClaimGrounding('A pesquisa educacional foi financiada.', 'This programme supports educational research projects.'));
});

test('validateCard rejects education hallucination even when evidenceId is valid and quote exists', () => {
  const spans = evidenceSpans(source.summary);
  assert.throws(() => validateCard(card('O EVENET foi apresentado como uma inovação educacional.'), source, { spans, requireSelection: true }), /educational claim/);
  assert.doesNotThrow(() => validateCard(card('O EVENET é um modelo de fundação para análise de colisões de partículas.'), source, { spans, requireSelection: true }));
});

test('factual preflight refuses headline hype, broad generalizations and unqualified negative validation claims', () => {
  const cases = [
    ['overview','Bolsas e modelos são avanços significativos no campo da inteligência artificial.', /unsubstantiated significance/],
    ['perspectives','O estudo pode revolucionar a forma de aprender e melhorar o ensino.', /speculative impact/],
    ['uncertainties','A eficácia do EVENET em tarefas reais ainda precisa ser validada.', /lack-of-validation/],
    ['uncertainties','O modelo ainda não foi testado com dados reais.', /lack-of-validation/],
    ['overview','O EVENET é uma inovação educacional com amplo impacto.', /educational leap/]
  ];
  for (const [field,value,problem] of cases) {
    const draft = opening();
    if (field === 'perspectives') draft.perspectives[0].argument = value;
    else draft[field] = value;
    assert.throws(() => validateEditorialGrounding(draft), problem, value);
    assert.throws(() => composePost({ label: 'Inteligência artificial e pesquisa em modelos', tag: 'ia' }, draft, articles), problem, value);
  }
});

test('real 0.7.0 draft: unsupported innovation and malformed benéfica perspective are not acceptable', () => {
  const financial = opening();
  financial.perspectives[0].argument = 'Bolsas para IA benéfica podem levar a inovações significativas.';
  assert.throws(() => validateEditorialGrounding(financial), /unsubstantiated significance/);
  const malformed = opening();
  malformed.perspectives[1].caveat = 'A benéfica é um conceito complexo que exige mais pesquisas.';
  assert.throws(() => validateEditorialGrounding(malformed), /malformed use of benéfica/);
  assert.doesNotThrow(() => validateEditorialGrounding(opening()));
});

test('grounded descriptions remain publishable candidates but are explicitly not independent fact-checks', () => {
  const result = validateEditorialGrounding(opening());
  assert.deepEqual(result, {
    passed: true,
    independent: false,
    scope: 'known unsupported inferences and evidence-domain anchors',
    humanVerificationRequired: true
  });
  const post = composePost({ label: 'Inteligência artificial e pesquisa em modelos', tag: 'ia' }, opening(), articles);
  assert.match(post.content, /bolsas de investigação/);
  assert.match(post.content, /FONTES CONSULTADAS/);
});
