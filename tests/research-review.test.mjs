import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewMaterial, validateReview } from '../agents/research-core.mjs';
import { OllamaResearcher } from '../agents/research-model.mjs';

const message = { title: 'Limites de uma pesquisa relatada', content: 'SÍNTESE\nO resumo relata um resultado limitado e não informa o método completo.\n\nPERSPECTIVAS PARA DEBATE\nUma proposta seria comparar outros cenários; isso ainda precisa ser testado.\n\nFONTES CONSULTADAS\n[S1] Relato — https://first.example/paper' };
const material = reviewMaterial(message);
const review = findings => ({ findings, note: 'Revisão restrita ao texto e às evidências disponíveis.' });
const finding = (kind, reason) => ({ kind, claimId: material[1].id, reason });

test('review suggestions distinguish missing names, methods and ethical depth from false claims', () => {
  const result = validateReview(review([
    finding('missing-detail', 'O resumo não informa os nomes dos membros nomeados como fellows.'),
    finding('missing-detail', 'Faltam detalhes do método e impactos éticos de longo prazo.'),
    finding('style', 'Uma explicação adicional poderia deixar a leitura mais clara.')
  ]), material);
  assert.equal(result.approved, true); assert.equal(result.issues.length, 0); assert.equal(result.suggestions.length, 3);
  assert.equal(result.findings[0].quote, material[1].text);
});
test('an invented result remains blocking even when the critic also suggests more detail', () => {
  const result = validateReview({ ...review([
    finding('unsupported-claim', 'O texto afirma desempenho geral que os trechos não demonstram.'),
    finding('missing-detail', 'Seria útil consultar o método completo em outra pesquisa.')
  ]), approved: true }, material);
  assert.equal(result.approved, false); assert.equal(result.issues.length, 1); assert.equal(result.suggestions.length, 1);
  assert.match(result.issues[0], /O resumo relata/);
  for (const kind of ['contradiction', 'hypothesis-as-fact', 'false-consensus', 'false-independence']) {
    assert.equal(validateReview(review([finding(kind, 'O trecho apresenta uma conclusão que exige correção factual.')]), material).approved, false);
  }
});
test('reviews fail closed on unknown targets, unknown categories or the old unclassified verdict', () => {
  assert.throws(() => validateReview(review([{ ...finding('unsupported-claim', 'Afirmação fora do material avaliado.'), claimId: 'C999' }]), material), /existing claimId/);
  assert.throws(() => validateReview(review([finding('anything', 'Uma categoria não definida não pode decidir a revisão.')]), material), /Unknown review/);
  assert.throws(() => validateReview({ approved: false, issues: ['Faltam métodos completos.'], note: 'Rejeição sem categoria e sem trecho identificado.' }, material), /classified findings/);
  assert.ok(material.every(part => !part.text.includes('https://')));
});
test('the model reviews existing block IDs with an explicit short-source rubric', async () => {
  let calls = 0;
  const model = new OllamaResearcher({ config: { numContext: 4096, modelAttempts: 2, modelTimeoutSeconds: 30 }, fetchImpl: async (url, options) => {
    calls++;
    const body = JSON.parse(options.body), prompt = body.messages[1].content;
    const input = JSON.parse(prompt.slice(0, prompt.indexOf('\nEsquema:')));
    assert.match(input.limits, /nomes, métodos/); assert.match(input.limits, /INVENTA/);
    assert.ok(body.format.properties.findings.items.properties.claimId.enum.includes(input.material[1].id));
    return Response.json({ message: { content: JSON.stringify(review([{ kind: 'missing-detail', claimId: input.material[1].id, reason: 'O resumo não fornece o método completo nem detalhes adicionais.' }])) }, done_reason: 'stop' });
  } });
  const result = await model.review(message, [], 'Panorama de evidências curtas.');
  assert.equal(result.approved, true); assert.equal(calls, 1); assert.equal(model.reviewTrace[0].review, result);
});
test('four-source review keeps complete evidence quotes within the default context budget', async () => {
  const quotes = ['a'.repeat(299) + '1', 'b'.repeat(299) + '2'];
  const cards = Array.from({ length: 4 }, (_, index) => ({ sourceId: 'S' + (index + 1), summary: 'r'.repeat(260), limitations: 'l'.repeat(180), facts: quotes.map(quote => ({ statement: 'f'.repeat(160), quote })) }));
  let calls = 0;
  const model = new OllamaResearcher({ config: { numContext: 4096, modelAttempts: 1, modelTimeoutSeconds: 30 }, fetchImpl: async (url, options) => {
    calls++;
    const body = JSON.parse(options.body), prompt = body.messages[1].content;
    const input = JSON.parse(prompt.slice(0, prompt.indexOf('\nEsquema:')));
    assert.ok(prompt.length <= (4096 - 1200) * 3);
    assert.equal(input.evidenceCards.length, 4); assert.deepEqual(input.evidenceCards[0].quotes, quotes);
    assert.equal(input.evidenceCards[0].summary, undefined);
    return Response.json({ message: { content: JSON.stringify(review([])) }, done_reason: 'stop' });
  } });
  const result = await model.review({ title: 't'.repeat(115), content: 'SÍNTESE\n' + 'c'.repeat(2800) }, cards, 'Métodos, resultados relatados e comparação das evidências');
  assert.equal(result.approved, true); assert.equal(calls, 1);
});
