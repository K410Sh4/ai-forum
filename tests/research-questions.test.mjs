import test from 'node:test';
import assert from 'node:assert/strict';
import { onlyQuestionsBlocked, sourceBoundedQuestions } from '../agents/research-questions.mjs';
import { reviewMaterial, validateReview, composePost } from '../agents/research-core.mjs';

const source = id => ({
  id, publisherId: id === 'S1' ? 'mit' : 'arxiv',
  host: id === 'S1' ? 'news.mit.edu' : 'arxiv.org',
  title: 'Relato de pesquisa ' + id,
  url: id === 'S1' ? 'https://news.mit.edu/test' : 'https://arxiv.org/abs/2610.00000',
  publishedAt: '2026-11-02T00:00:00.000Z'
});
const sources = [source('S1'), source('S2')];
const draft = {
  title: 'Duas publicações e questões de pesquisa',
  overview: 'Os relatórios analisados apresentam informações de duas fontes distintas. Esta síntese preserva a separação entre os relatos e não afirma que os resultados de uma notícia confirmam as conclusões da outra.',
  uncertainties: 'Os excertos consultados não permitem avaliar todos os métodos citados nos textos originais.',
  perspectives: [
    { label: 'Pesquisa', argument: 'A leitura da fonte pode orientar estudos adicionais para delimitar as hipóteses.', caveat: 'O excerto disponível é limitado.' },
    { label: 'Métodos', argument: 'Outras verificações seriam necessárias antes de adotar conclusões mais gerais.', caveat: 'A comparação não foi demonstrada.' }
  ],
  questions: ['Como os métodos podem ser avaliados?', 'O que resta esclarecer?'],
  sourceIds: ['S1', 'S2']
};
const material = reviewMaterial(composePost({ label: 'Pesquisa científica', tag: 'pesquisa' }, draft, sources));

test('only question-section blockers permit a narrowly targeted repair', () => {
  const question = material.find(entry => entry.text.startsWith('PERGUNTAS ABERTAS\n'));
  assert.ok(question, 'Rendered questions have an explicit review target');
  const review = validateReview({
    findings: [{ kind: 'incomplete-text', claimId: question.id, reason: 'A questão gerada contém um conceito indefinido e não pode ser interpretada.' }],
    note: 'A pergunta precisa de reformulação antes da publicação.'
  }, material);
  assert.equal(onlyQuestionsBlocked(review), true);
  assert.equal(onlyQuestionsBlocked(validateReview({
    findings: [{ kind: 'missing-detail', claimId: question.id, reason: 'Faltam detalhes metodológicos nas perguntas.' }],
    note: 'Observações opcionais sobre a redação.'
  }, material)), false);
});

test('other blocking claims must never be masked by question recovery', () => {
  const question = material.find(entry => entry.text.startsWith('PERGUNTAS ABERTAS\n'));
  const nonQuestion = material.find(entry => entry.text.startsWith('SÍNTESE\n'));
  assert.ok(nonQuestion);
  const review = validateReview({
    findings: [
      { kind: 'incomplete-text', claimId: question.id, reason: 'Pergunta obscura sobre tecnologia não citada.' },
      { kind: 'unsupported-claim', claimId: nonQuestion.id, reason: 'Conclusão factual sem fundamento na fonte.' }
    ],
    note: 'Dois problemas exigem correções distintas.'
  }, material);
  assert.equal(onlyQuestionsBlocked(review), false);
  assert.equal(onlyQuestionsBlocked({ findings: [], issues: [] }), false);
  assert.equal(onlyQuestionsBlocked(null), false);
});

test('deterministic replacement questions are safe, complete and source-identified', () => {
  const questions = sourceBoundedQuestions(sources);
  assert.equal(questions.length, 2);
  assert.ok(questions[0].includes('S1'));
  assert.ok(questions[1].includes('S2'));
  assert.ok(questions.every(value => value.endsWith('?') && value.length <= 90));
  const composed = composePost({ label: 'Pesquisa científica', tag: 'pesquisa' },
    { ...draft, questions }, sources);
  assert.ok(composed.content.includes(questions[0]));
  assert.ok(composed.content.includes(questions[1]));
  assert.doesNotMatch(composed.content, /sistemas de versão AI/iu);
});

test('question repair rejects absent or duplicated sources', () => {
  assert.throws(() => sourceBoundedQuestions([]), /two identified/);
  assert.throws(() => sourceBoundedQuestions([source('S1')]), /two identified/);
  assert.throws(() => sourceBoundedQuestions([source('S1'), source('S1')]), /two identified/);
  assert.throws(() => sourceBoundedQuestions([source('bad'), source('S2')]), /two identified/);
});
