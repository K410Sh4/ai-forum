import test from 'node:test';
import assert from 'node:assert/strict';
import {
  quantifiedGroups, assertNumbersByGroupFromEvidence,
  assertNumbersFromEvidence
} from '../agents/research-numbers.mjs';

const source = 'Five members of the MIT faculty and two alumni were named fellows.';

test('quantity associations match equivalent English source and Portuguese claim', () => {
  assert.deepEqual(quantifiedGroups(source), [
    { group: 'faculty', value: '5' }, { group: 'alumni', value: '2' }
  ]);
  assert.doesNotThrow(() => {
    assertNumbersFromEvidence('Cinco membros do corpo docente e dois ex-alunos foram nomeados.', source);
    assertNumbersByGroupFromEvidence('Cinco membros do corpo docente e dois ex-alunos foram nomeados.', source);
  });
});

test('inverting groups is rejected even when all numbers occur in the quote', () => {
  const swapped = 'Dois docentes e cinco ex-alunos foram nomeados.';
  assert.doesNotThrow(() => assertNumbersFromEvidence(swapped, source));
  assert.throws(() => assertNumbersByGroupFromEvidence(swapped, source),
    /unsupported source group: faculty/);
});

test('missing group support is not silently inferred from a matching number', () => {
  assert.throws(() => assertNumbersByGroupFromEvidence(
    'Cinco ex-alunos participaram da cerimônia.',
    'Five members of the faculty joined the ceremony.'
  ), /unsupported source group: alumni/);
});

test('non-group numbers preserve their previous lexical validation behavior', () => {
  assert.doesNotThrow(() => assertNumbersByGroupFromEvidence(
    'O estudo avaliou cinco tarefas.', 'The study evaluated five tasks.'
  ));
  assert.throws(() => assertNumbersFromEvidence(
    'O estudo avaliou seis tarefas.', 'The study evaluated five tasks.'
  ), /Numeric fact/);
});
