import test from 'node:test';
import assert from 'node:assert/strict';
import { sentence, validateReview } from '../agents/research-core.mjs';

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
