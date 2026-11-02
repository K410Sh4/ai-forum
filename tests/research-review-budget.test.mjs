import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_REVIEW_FINDINGS, validateReview } from '../agents/research-core.mjs';

const material = Array.from({ length: 14 }, (_, index) => ({
  id: 'C' + (index + 1),
  text: 'Afirmação verificável número ' + (index + 1) + ' associada à fonte.'
}));
const finding = index => ({
  kind: 'unsupported-claim', claimId: 'C' + index,
  reason: 'A afirmação não está sustentada pelo trecho literal fornecido.'
});

test('critic can report more than three blocking findings without silently discarding them', () => {
  assert.ok(MAX_REVIEW_FINDINGS >= 10);
  const result = validateReview({
    findings: [1, 2, 3, 4, 5].map(finding),
    note: 'Cinco afirmações exigem verificação adicional.'
  }, material);
  assert.equal(result.approved, false);
  assert.equal(result.issues.length, 5);
  assert.deepEqual(result.findings.map(item => item.claimId),
    ['C1', 'C2', 'C3', 'C4', 'C5']);
});

test('critic refuses findings beyond the explicit review budget', () => {
  assert.throws(() => validateReview({
    findings: Array.from({ length: MAX_REVIEW_FINDINGS + 1 }, (_, i) => finding(i + 1)),
    note: 'Excesso de achados.'
  }, material), /classified-finding limit/);
});

test('critic rejects a finding attached to an unknown claimId', () => {
  assert.throws(() => validateReview({
    findings: [{ ...finding(1), claimId: 'C100' }],
    note: 'Referência inexistente.'
  }, material), /existing claimId/);
});
