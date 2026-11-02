import test from 'node:test';
import assert from 'node:assert/strict';
import { describeOverviewAttempt, summarizeDraftAttemptFailures } from '../agents/research-diagnostics.mjs';

const examine = overview => describeOverviewAttempt(JSON.stringify({ title: 'Pesquisa', overview }));

test('two complete but short overviews are distinguishable from malformed outputs', () => {
  const value = examine('As duas fontes apresentam relatos distintos e precisam de avaliação.');
  assert.equal(value.category, 'under-160');
  assert.ok(value.length < 160);
});

test('long but complete overview is identified without silently authorizing fallback', () => {
  const value = examine('Descrição dos achados e do contexto pesquisado. '.repeat(20));
  assert.equal(value.category, 'over-550');
  assert.ok(value.length > 550);
});

test('URLs and control characters are reported as unsafe even with a short overview', () => {
  const url = examine('Consulte https://example.com para investigar a afirmação.');
  assert.match(url.category, /contains-url/);
  const control = examine('O estudo informou que o resultado não foi reproduzido.\u0003');
  assert.match(control.category, /control-char/);
});

test('truncation and unexpected glyphs are independently flagged', () => {
  const cut = examine('Os resultados não esclarecem se');
  assert.match(cut.category, /incomplete-sentence/);
  const junk = examine('A apresentação relaciona os dados e a análise進.');
  assert.match(junk.category, /unexpected-characters/);
});

test('valid long-enough overview retains structural signal without claims of factual proof', () => {
  const x = examine('As duas publicações apresentam informações específicas sobre pesquisas distintas. Os resultados precisam ser interpretados a partir das fontes originais, sem assumir qualquer confirmação entre os trabalhos consultados.');
  assert.equal(x.category, 'structurally-complete');
  assert.ok(x.length >= 160 && x.length <= 550);
});

test('diagnostic accepts invalid JSON and missing overview without exposing source text', () => {
  assert.deepEqual(describeOverviewAttempt('{bad'), { category: 'invalid-json' });
  assert.deepEqual(describeOverviewAttempt(JSON.stringify({ title: 'Sem síntese' })), { category: 'missing-overview' });
  assert.ok(!Object.hasOwn(examine('Esta informação é privada.'), 'text'));
});

test('trace summaries are bounded to the last attempts and contain no raw model output', () => {
  const trace = [
    { stage: 'source-S1', attempt: 1, error: 'Invalid fact', output: 'x' },
    { stage: 'draft', attempt: 1, error: 'Invalid overview', output: JSON.stringify({ overview: 'Breve.' }) },
    { stage: 'draft', attempt: 2, error: 'Invalid overview', output: JSON.stringify({ overview: 'https://example.org' }) }
  ];
  const result = summarizeDraftAttemptFailures(trace, 2);
  assert.equal(result.length, 2);
  assert.match(result[0].overview.category, /under-160/);
  assert.match(result[1].overview.category, /contains-url/);
  assert.ok(!JSON.stringify(result).includes('https://example.org'));
});
