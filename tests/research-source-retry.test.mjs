import test from 'node:test';
import assert from 'node:assert/strict';
import { OllamaResearcher } from '../agents/research-model.mjs';
import { prepareSourceCard, retryDirective } from '../agents/research-stages.mjs';
import { evidenceSpans, validateSourceClaimGrounding } from '../agents/research-core.mjs';
import { FeedReader } from '../agents/research-runtime.mjs';

const quote = 'Researchers reported a controlled comparison of model behavior under specified conditions. The report does not establish general performance outside the evaluated setting.';
const source = { id: 'S2', summary: quote };
const spans = evidenceSpans(quote);
const accepted = 'O relatório apresenta uma comparação de comportamento em condições determinadas.';

const cardSchema = {
  type: 'object',
  properties: { facts: { type: 'array', items: {
    type: 'object',
    properties: { statement: { type: 'string' }, evidenceId: { type: 'string' } },
    required: ['statement', 'evidenceId'],
    additionalProperties: false
  } } },
  required: ['facts'], additionalProperties: false
};

function localReviewer(sequence) {
  const requests = [];
  const researcher = new OllamaResearcher({
    config: { modelAttempts: 2, modelTimeoutSeconds: 30, numContext: 4096 },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:11434/api/chat');
      const input = JSON.parse(options.body);
      assert.equal(input.tools, undefined);
      requests.push(input.messages[1].content);
      const statement = sequence[Math.min(requests.length - 1, sequence.length - 1)];
      return Response.json({ done_reason: 'stop', message: { content: JSON.stringify({
        facts: [{ statement, evidenceId: spans[0].id }]
      }) } });
    }
  });
  return { researcher, requests };
}

test('known malformed scientific and institutional names have specific diagnostic reasons', () => {
  for (const phrase of ['da MIT', 'pela MIT', 'curso oculto de regras', 'nomeados como fellowships']) {
    assert.throws(() => validateSourceClaimGrounding('Os pesquisadores ' + phrase + ' apresentam resultados.', quote),
      /mistranslated scientific term or institutional name \(/);
  }
  assert.doesNotThrow(() => validateSourceClaimGrounding(accepted, quote));
});

test('second source attempt receives targeted guidance and can recover without changing evidenceId', async () => {
  const { researcher, requests } = localReviewer([
    'A equipe da MIT publicou uma comparação controlada.',
    accepted
  ]);
  const card = await researcher.ask('source-S2', cardSchema,
    { title: 'Controlled comparison', collectedEvidence: spans },
    result => prepareSourceCard(result, source, spans));
  assert.equal(requests.length, 2);
  assert.match(requests[1], /do MIT/);
  assert.equal(card.facts[0].statement, accepted);
  assert.equal(card.facts[0].evidenceId, spans[0].id);
  assert.equal(card.facts[0].quote, spans[0].text);
  assert.match(researcher.validationTrace[0].error, /da mit/);
});

test('persistent mistranslation fails closed after two attempts without inventing a corrected fact', async () => {
  const { researcher, requests } = localReviewer([
    'A equipe da MIT publicou uma comparação controlada.',
    'A equipe da MIT publicou uma comparação controlada.'
  ]);
  await assert.rejects(
    researcher.ask('source-S2', cardSchema, { collectedEvidence: spans },
      result => prepareSourceCard(result, source, spans)),
    /source-S2: Factual grounding: mistranslated scientific term or institutional name/
  );
  assert.equal(requests.length, 2);
  assert.equal(researcher.validationTrace.length, 2);
});

test('retry instruction distinguishes curriculum, fellows, fellowships and MIT without suppressing evidence checks', () => {
  const instruction = retryDirective('source-S2',
    Error('Factual grounding: mistranslated scientific term or institutional name (curso oculto de regras)'));
  assert.match(instruction, /curriculum/);
  assert.match(instruction, /fellowships/);
  assert.match(instruction, /evidenceId/);
  assert.match(instruction, /citação/);
});

test('Nature authentication redirects must not be treated as a trusted science feed', async () => {
  let calls = 0;
  const reader = new FeedReader({
    allowedFeedHosts: ['www.nature.com'],
    publishers: [{ id: 'nature', hosts: ['www.nature.com'] }],
    feedCacheMinutes: 0, maxSourceAgeDays: 14
  }, { fetchImpl: async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: { Location: 'https://idp.nature.com/secure-login' }
    });
  } });
  await assert.rejects(reader.read('https://www.nature.com/natmachintell.rss', {}),
    /Feed redirected to an unapproved destination: www\.nature\.com -> idp\.nature\.com/);
  assert.equal(calls, 1, 'No request must be sent to the identity provider');
});
