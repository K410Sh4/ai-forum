import test from 'node:test';
import assert from 'node:assert/strict';
import { sentence, validateReview, validateCard, evidenceSpans } from '../agents/research-core.mjs';

test('the visibly cut passages from the real preview cannot pass prose validation', () => {
  for (const value of [
    'Esses進.',
    'Embora o EVENET seja capaz de se transm',
    'É crucial que esses avanços sejam monitorados e regulamentados para garantir que sejam usá',
    'Além disso, o resumo não fornece detalhes sobre os limites e',
    'O resultado ainda precisa de confirmação...'
  ]) assert.throws(() => sentence(value, 5, 500), /Incomplete|Unexpected/);
  assert.equal(sentence('O método precisa de avaliação adicional.', 5, 500), 'O método precisa de avaliação adicional.');
  assert.equal(sentence('A hipótese usa α (alfa) como parâmetro.', 5, 500), 'A hipótese usa α (alfa) como parâmetro.');
});
test('a visible incomplete sentence is a blocking review finding', () => {
  const result = validateReview({ findings: [{ kind: 'incomplete-text', claimId: 'C1', reason: 'A frase termina com uma palavra interrompida e precisa ser reescrita.' }], note: 'Texto precisa de uma frase completa.' }, [{ id: 'C1', text: 'Embora o EVENET seja capaz de se transm' }]);
  assert.equal(result.approved, false); assert.equal(result.suggestions.length, 0);
});

test('unfinished source summary is reconstructed from a fact with a verified literal evidenceId', () => {
  const source = {
    id: 'S1',
    summary: 'Researchers compared learning systems under controlled test conditions. The source does not discuss deployment in other settings.'
  };
  const spans = evidenceSpans(source.summary);
  const card = {
    summary: 'O estudo compara sistemas sob condições',
    facts: [{ statement: 'Os pesquisadores compararam sistemas de aprendizagem em condições controladas.', evidenceId: spans[0].id }],
    limitations: 'O resumo não avalia a utilização fora do cenário descrito.'
  };
  const result = validateCard(card, source, { spans, requireSelection: true });
  assert.equal(result.summaryMode, 'supported-fact-fallback');
  assert.equal(result.summary, 'Achado relatado na fonte consultada: ' + card.facts[0].statement);
  assert.equal(result.facts[0].quote, spans[0].text);
  assert.equal(result.facts[0].evidenceId, spans[0].id);
  assert.match(result.summary, /\.$/);

  const complete = validateCard({ ...card, summary: 'O relato descreve condições controladas e limitações explícitas.' }, source, { spans, requireSelection: true });
  assert.equal(complete.summaryMode, 'model');
});
test('source summary recovery never suppresses invalid quotes, unsupported numbers, URLs or incomplete facts', () => {
  const source = { id: 'S1', summary: 'Researchers compared learning systems under controlled test conditions.' };
  const spans = evidenceSpans(source.summary);
  const card = {
    summary: 'O estudo compara sistemas sob condições',
    facts: [{ statement: 'Pesquisadores compararam os sistemas em condições controladas.', evidenceId: spans[0].id }],
    limitations: 'O resumo não avalia a generalização para outras condições.'
  };
  assert.throws(() => validateCard({ ...card, facts:[{ ...card.facts[0], evidenceId: 'E999' }] }, source, { spans, requireSelection:true }), /Select an existing evidenceId/);
  assert.throws(() => validateCard({ ...card, facts:[{ statement:'Pesquisadores compararam 123 sistemas em condições controladas.', evidenceId:spans[0].id }] }, source, { spans, requireSelection:true }), /Numeric fact is absent/);
  assert.throws(() => validateCard({ ...card, facts:[{ statement:'Pesquisadores compararam sistemas em condições controladas', evidenceId:spans[0].id }] }, source, { spans, requireSelection:true }), /Incomplete fact/);
  assert.throws(() => validateCard({ ...card, summary:'Consulte https://example.com para informações adicionais de pesquisa.' }, source, { spans, requireSelection:true }), /Invalid source summary/);
  assert.throws(() => validateCard({ ...card, limitations:'O resumo não detalha as condições' }, source, { spans, requireSelection:true }), /Incomplete source limitation/);
});
