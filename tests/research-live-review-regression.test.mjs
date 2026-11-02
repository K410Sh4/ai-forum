import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReview, validateEditorialGrounding, evidenceSpans, normalized } from '../agents/research-core.mjs';
import { OllamaResearcher } from '../agents/research-model.mjs';
import { prepareSourceCard, retryDirective } from '../agents/research-stages.mjs';

const generic = 'O texto não explica como as atualizações dos modelos AI afetam a confiabilidade e a eficácia dos sistemas.';
const material = Array.from({ length: 8 }, (_, i) => ({
  id: 'C' + (i + 1), text: 'Parte distinta da pesquisa com conteúdo e objetivo próprio número ' + (i + 1) + '.'
}));
const repeated = () => ({
  findings: material.map(item => ({ kind: 'missing-detail', claimId: item.id, reason: generic })),
  note: 'O texto não fornece detalhes suficientes sobre as atualizações dos modelos.'
});

test('real 2026-11-02 Qwen failure: eight generic findings cannot silently approve', () => {
  assert.throws(() => validateReview(repeated(), material), /Repetitive advisory review/);
  const distinct = repeated();
  distinct.findings = distinct.findings.slice(0, 3);
  assert.equal(validateReview(distinct, material).approved, true,
    'Three advisory findings alone are not proof of an invalid review');
  const blocked = repeated();
  blocked.findings[0] = {
    ...blocked.findings[0], kind: 'unsupported-claim',
    reason: 'A afirmação não decorre dos trechos citados e exige correção factual.'
  };
  assert.equal(validateReview(blocked, material).approved, false,
    'Blocking findings must continue to block, even when advice repeats');
});

test('review retries a repetitive Qwen response without treating suggestions as factual edits', async () => {
  let calls = 0;
  const message = {
    title: 'Panorama de duas publicações científicas',
    content: Array.from({ length: 7 }, (_, i) => 'TÓPICO ' + i + '\nAfirmação editorial ' + i + '.').join('\n\n')
  };
  const parts = [message.title, ...message.content.split('\n\n')].map((text, index) => ({ id: 'C' + (index + 1), text }));
  const reviewer = new OllamaResearcher({
    config: { numContext: 4096, modelAttempts: 2, modelTimeoutSeconds: 30 },
    fetchImpl: async (_url, options) => {
      calls++;
      const input = JSON.parse(JSON.parse(options.body).messages[1].content.split('\nEsquema:')[0]);
      assert.equal(input.material.length, parts.length);
      if (calls === 2) assert.match(JSON.parse(options.body).messages[1].content, /repetiu o mesmo conselho/);
      const response = calls === 1
        ? { findings: input.material.map(item => ({ kind: 'missing-detail', claimId: item.id, reason: generic })),
            note: 'Faltam explicações específicas sobre cada parte.' }
        : { findings: [], note: 'Nenhum bloqueio material demonstrado pelos trechos recebidos.' };
      return Response.json({ done_reason: 'stop', message: { content: JSON.stringify(response) } });
    }
  });
  const result = await reviewer.review(message, [], 'Analisar evidências e limites das fontes.');
  assert.equal(result.approved, true);
  assert.equal(calls, 2);
  assert.match(reviewer.validationTrace[0].error, /Repetitive advisory review/);
});

test('review fails closed when both attempts repeat identical generic advice', async () => {
  let calls = 0;
  const message = {
    title: 'Panorama de duas notícias distintas',
    content: Array.from({ length: 7 }, (_, i) => 'BLOCO ' + i + '\nInformação publicada de exemplo ' + i + '.').join('\n\n')
  };
  const reviewer = new OllamaResearcher({
    config: { numContext: 4096, modelAttempts: 2, modelTimeoutSeconds: 30 },
    fetchImpl: async (_url, options) => {
      calls++;
      const input = JSON.parse(JSON.parse(options.body).messages[1].content.split('\nEsquema:')[0]);
      return Response.json({ done_reason: 'stop', message: { content: JSON.stringify({
        findings: input.material.map(item => ({ kind: 'missing-detail', claimId: item.id, reason: generic })),
        note: 'Faltam explicações sobre as fontes citadas.'
      }) } });
    }
  });
  await assert.rejects(reviewer.review(message, [], 'Analisar as fontes.'), /Repetitive advisory review/);
  assert.equal(calls, 2);
});

test('generated PT-BR prose rejects generic English AI fragments but permits proper names', () => {
  const draft = {
    title: 'Estudos sobre versões e métodos de IA',
    overview: 'Os pesquisadores relatam métodos próprios e resultados limitados.',
    uncertainties: 'A interpretação dos resultados requer exame das fontes.',
    perspectives: [{ argument: 'Os autores propõem avaliar métodos adicionais.',
      caveat: 'É preciso verificar os dados.' }],
    questions: ['Quais limites foram relatados?', 'Como verificar os métodos citados?']
  };
  assert.equal(validateEditorialGrounding(draft).passed, true);
  assert.throws(() => validateEditorialGrounding({ ...draft, title: 'Atualizações de modelos AI e suas implicações' }), /Editorial Portuguese/);
  assert.throws(() => validateEditorialGrounding({ ...draft, overview: 'AI providers atualizam modelos de forma contínua.' }), /Editorial Portuguese/);
  assert.throws(() => validateEditorialGrounding({ ...draft, questions: ['Como sistemas AI são versionados?', 'Quais limites foram relatados?'] }), /Editorial Portuguese/);
  assert.equal(validateEditorialGrounding({ ...draft, title: 'OpenAI e estudos sobre IA' }).passed, true);
  assert.match(retryDirective('draft', Error('Editorial Portuguese: mixed AI terminology in title')), /provedores de IA/);
});

test('quoted evidence preserves the complete public identifiers clause', () => {
  const evidence = 'Nature Machine Intelligence, Published online: 02 November 2026; doi:10.1038/s42256-026-01323-8 Artificial intelligence (AI) providers frequently update their models and system integrations without corresponding changes to their public identifiers. This undermines regulatory oversight and scientific reproducibility.';
  const spans = evidenceSpans(evidence);
  assert.ok(spans.some(span => span.text.includes('without corresponding changes to their public identifiers.')),
    'The complete noun phrase must stay together in one literal quote');
  assert.ok(spans.every(span => span.text.length <= 300 && normalized(evidence).includes(span.text)));
  assert.equal(new Set(spans.map(span => span.id)).size, spans.length);
});

test('source card translates AI providers only when the literal selected quote warrants it', () => {
  const text = 'Artificial intelligence (AI) providers frequently update their models and system integrations without corresponding changes to their public identifiers.';
  const source = { id: 'S2', summary: text };
  const spans = evidenceSpans(text);
  const input = { facts: [{
    statement: 'AI providers atualizam seus modelos e integrações sem alterar os identificadores públicos.',
    evidenceId: spans[0].id
  }] };
  const card = prepareSourceCard(input, source, spans);
  assert.match(card.facts[0].statement, /^provedores de IA atualizam/iu);
  assert.equal(card.facts[0].quote, spans[0].text);
  assert.equal(card.facts[0].evidenceId, spans[0].id);
  assert.equal(card.normalizations[0].rule, 'ai-providers-to-provedores-de-ia');
  const otherSource = { id: 'S1', summary: 'A generic research paper presents a test methodology and does not mention any model provider.' };
  const otherSpans = evidenceSpans(otherSource.summary);
  const unrelatedInput = { facts: [{
    statement: 'AI providers atualizam os modelos em estudos científicos.',
    evidenceId: otherSpans[0].id
  }] };
  const unrelated = prepareSourceCard(unrelatedInput, otherSource, otherSpans);
  assert.equal(unrelated.facts[0].statement, unrelatedInput.facts[0].statement,
    'English phrase must not be silently replaced without literal source support');
});
