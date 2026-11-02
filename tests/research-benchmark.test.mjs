import test from 'node:test';
import assert from 'node:assert/strict';
import { RESEARCH_EVAL_CASES, RESEARCH_EVAL_LABELS, summarizeResearchEval } from '../agents/research-eval-cases.mjs';
import { benchmarkOptions, classifyCase, runBenchmark } from '../agents/research-benchmark.mjs';

test('multilingual contradiction probes have unambiguous IDs and balanced label counts', () => {
  const ids = RESEARCH_EVAL_CASES.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(RESEARCH_EVAL_CASES.length, 18);
  assert.deepEqual(RESEARCH_EVAL_LABELS, ['supported', 'contradicted', 'insufficient']);
  for (const expected of RESEARCH_EVAL_LABELS)
    assert.equal(RESEARCH_EVAL_CASES.filter(item => item.expected === expected).length, 6);
  for (const item of RESEARCH_EVAL_CASES)
    assert.ok(item.evidence.length > 15 && item.claim.length > 15);
});

test('benchmark arguments reject unsupported variants and excessive case count', () => {
  assert.deepEqual(benchmarkOptions([]), { cases: 9, compare: false, variant: 'strict', model: 'qwen2.5-coder:7b', json: false });
  assert.equal(benchmarkOptions(['--cases', '6', '--compare']).compare, true);
  assert.throws(() => benchmarkOptions(['--cases', '19']), /between 1 and/);
  assert.throws(() => benchmarkOptions(['--variant', 'invented']), /compact or strict/);
  assert.throws(() => benchmarkOptions(['--model', 'evil model']), /Invalid local model/);
  assert.throws(() => benchmarkOptions(['--unknown']), /Unknown/);
});

test('benchmark uses only loopback Ollama with temperature zero and no forum publishing', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, request: JSON.parse(options.body) });
    return Response.json({
      done_reason: 'stop', message: { content: JSON.stringify({ verdict: 'supported' }) },
      prompt_eval_count: 100, eval_count: 10, eval_duration: 1e9
    });
  };
  const result = await runBenchmark(benchmarkOptions(['--cases', '3', '--compare']), { fetchImpl });
  assert.equal(calls.length, 6);
  assert.ok(calls.every(call => call.url === 'http://127.0.0.1:11434/api/chat'));
  assert.ok(calls.every(call => call.request.options.temperature === 0));
  assert.ok(calls.every(call => call.request.options.num_ctx === 4096));
  assert.ok(calls.every(call => !call.request.tools));
  assert.equal(result.byVariant.strict.total, 3);
  assert.equal(result.byVariant.compact.total, 3);
  assert.equal(result.byVariant.strict.correct, 1);
  assert.equal(result.byVariant.strict.falseSupport, 2);
  assert.equal(result.byVariant.compact.falseSupport, 2);
});

test('invalid model verdicts fail closed and count as errors rather than supported', async () => {
  const result = await classifyCase(RESEARCH_EVAL_CASES[0], {
    model: 'qwen2.5-coder:7b', variant: 'strict',
    fetchImpl: async () => Response.json({ message: { content: '{"verdict":"maybe"}' } })
  });
  assert.equal(result.predicted, null);
  assert.equal(result.correct, false);
  assert.match(result.error, /Invalid structured verdict/);
  assert.equal(summarizeResearchEval([result]).errors, 1);
});

test('false support rate excludes true supported cases and counts unsupported positives', () => {
  const metrics = summarizeResearchEval([
    { expected: 'supported', predicted: 'supported', milliseconds: 10 },
    { expected: 'contradicted', predicted: 'supported', milliseconds: 20 },
    { expected: 'insufficient', predicted: 'insufficient', milliseconds: 30 }
  ]);
  assert.equal(metrics.correct, 2);
  assert.equal(metrics.falseSupport, 1);
  assert.equal(metrics.falseSupportRate, 0.5);
  assert.equal(metrics.averageMilliseconds, 20);
});
