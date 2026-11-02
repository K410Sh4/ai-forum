import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNumbersFromEvidence, factualNumbers } from '../agents/research-numbers.mjs';
import { retryDirective, prepareSourceCard } from '../agents/research-stages.mjs';
import { evidenceSpans } from '../agents/research-core.mjs';
import { OllamaResearcher } from '../agents/research-model.mjs';

// Regression taken from a real Qwen7B rejection on 2026-11-02.
// The year in a headline or metadata is NOT evidence for the selected fact.
const excerpt = 'Schmidt Sciences AI2050 Fellows include researchers and alumni from MIT. The award supports beneficial artificial intelligence research.';
const source = { id: 'S2', title: 'Schmidt Sciences AI2050 Fellows', summary: excerpt };
const spans = evidenceSpans(excerpt);

test('AI2050 is a name, not a free-standing numeric quantity or asserted year', () => {
  assert.deepEqual(factualNumbers('Schmidt Sciences AI2050 Fellows'), []);
  assert.deepEqual(factualNumbers('O MIT nomeou 2026 Schmidt Sciences AI2050 Fellows.'), ['2026']);
  assert.deepEqual(factualNumbers('O MIT nomeou 2026 dois ex-alunos como bolsistas do Schmidt Sciences AI2050.'), ['2026', '2']);
  assert.doesNotThrow(() => assertNumbersFromEvidence('O programa Schmidt Sciences AI2050 foi mencionado.', excerpt));
  assert.throws(() => assertNumbersFromEvidence('O MIT nomeou 2026 Schmidt Sciences AI2050 Fellows.', excerpt),
    /Numeric fact is absent from its evidence quote: 2026/);
});

test('missing year and separate count are reported independently without fabricating either', () => {
  assert.throws(() => assertNumbersFromEvidence(
    'O MIT nomeou 2026 dois ex-alunos como bolsistas do Schmidt Sciences AI2050.', excerpt
  ), /Numeric fact is absent from its evidence quote: 2026, 2/);
  assert.throws(() => assertNumbersFromEvidence('O MIT nomeou três ex-alunos.', excerpt),
    /Numeric fact is absent from its evidence quote: 3/);
  assert.doesNotThrow(() => assertNumbersFromEvidence(
    'O MIT nomeou dois ex-alunos.', 'MIT announced two alumni as fellows.'
  ));
});

test('numeric retry names only bounded digits and instructs source-local correction', () => {
  const advice = retryDirective('source-S2', Error('Numeric fact is absent from its evidence quote: 2026, 2'));
  assert.match(advice, /2026, 2/);
  assert.match(advice, /evidenceId/);
  assert.match(advice, /AI2050/);
  assert.match(advice, /Remova números sem apoio/);
  assert.doesNotMatch(advice, /https?:\/\//);
  const generic = retryDirective('source-S2', Error('Numeric fact is absent from its evidence quote'));
  assert.match(generic, /número ausente/);
});

test('real source-stage pattern: model can remove unsupported year without bypassing factual gate', async () => {
  const output = [
    'O MIT nomeou 2026 Schmidt Sciences AI2050 Fellows.',
    'A fonte informa que existem pesquisadores e ex-alunos no programa Schmidt Sciences AI2050.'
  ];
  const prompts = [];
  const model = new OllamaResearcher({
    config: { modelAttempts: 2, modelTimeoutSeconds: 30, numContext: 4096 },
    fetchImpl: async (url, opts) => {
      assert.equal(url, 'http://127.0.0.1:11434/api/chat');
      const body = JSON.parse(opts.body);
      prompts.push(body.messages[1].content);
      return Response.json({ done_reason: 'stop', message: {
        content: JSON.stringify({ facts: [{ statement: output[Math.min(prompts.length - 1, 1)], evidenceId: spans[0].id }] })
      } });
    }
  });
  const schema = { type: 'object', properties: {
    facts: { type: 'array', items: { type: 'object', properties: {
      statement: { type: 'string' }, evidenceId: { type: 'string' }
    } } }
  } };
  const card = await model.ask('source-S2', schema, { collectedEvidence: spans },
    draft => prepareSourceCard(draft, source, spans));
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /2026/);
  assert.equal(card.facts[0].evidenceId, spans[0].id);
  assert.equal(card.facts[0].quote, spans[0].text);
  assert.doesNotMatch(card.facts[0].statement, /2026/);
  assert.equal(model.validationTrace[0].error, 'Numeric fact is absent from its evidence quote: 2026');
});
