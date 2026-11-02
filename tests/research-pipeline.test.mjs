import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ResearchEngine } from '../agents/research-engine.mjs';
import { OllamaResearcher } from '../agents/research-model.mjs';
import { ResearchStore, FeedReader, validateConfig, readJSON, writeJSON } from '../agents/research-runtime.mjs';
import { readFeed, chooseArticles, validateCard, payloadHash, publicURL, evidenceSpans, openingEvidence, normalized } from '../agents/research-core.mjs';
import { runtimeInfo } from '../agents/topic-researcher.mjs';

const NOW = Date.parse('2026-11-01T12:00:00Z');
test('runtime diagnostics accept Node 26 and newer without an artificial upper limit', () => {
  assert.equal(runtimeInfo('26.13.0').compatible, true);
  assert.equal(runtimeInfo('27.0.0-alpha.0').compatible, true);
  const old = runtimeInfo('20.20.2');
  assert.equal(old.compatible, false); assert.equal(old.node, 'v20.20.2'); assert.equal(old.executable, process.execPath);
});
test('runtime diagnostics report missing capabilities before any network request', () => {
  const result = runtimeInfo('26.13.0', {});
  assert.equal(result.compatible, false); assert.ok(result.missingCapabilities.includes('fetch')); assert.ok(result.missingCapabilities.includes('AbortSignal.any'));
});
const excerpt = 'Researchers reported a controlled comparison of model behavior under specified conditions. The report does not establish general performance outside the evaluated setting.';
const configValue = () => ({ publishers: [{ id: 'first', hosts: ['first.example', 'science.first.example'] }, { id: 'second', hosts: ['second.example'] }], allowedFeedHosts: ['first.example', 'second.example'], sourcesPerPost: 2, feedCacheMinutes: 0, topics: [{ id: 'ai-research', label: 'Pesquisa de agentes e métodos', tag: 'inteligencia-artificial', feeds: ['https://first.example/feed', 'https://second.example/feed'] }] });
function xml(host) { return '<rss><channel><item><title>Research update ' + host + '</title><link>https://' + host + '/paper</link><description><![CDATA[' + excerpt + ']]></description><pubDate>' + new Date(NOW - 86400000).toUTCString() + '</pubDate></item></channel></rss>'; }
function fixture(t, { depth = 'balanced', invalidModel = false, badPlan = '', brokenDrafts = 0, shortOverviews = 0, urlOverviews = 0, significanceOverviews = 0, significancePerspective = false, mixedUncertaintyShort = false, mixedOverviewArticleFirst = false, mixedShortUnsafe = '', badQuestions = false, criticRejects = 0, criticAdvice = false, criticOnlyQuestions = false, criticMixedBlockers = false, criticReason = 'A afirmação apresentada extrapola o alcance dos trechos fornecidos.', idempotent = true, loseReceiptAt = -1 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-research-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = NOW, criticCalls = 0, writeCalls = 0, draftCalls = 0;
  const calls = [], waits = [], topics = [], replies = [], receipts = new Map();
  const clock = () => now;
  const sleep = async ms => { waits.push(ms); now += ms; };
  const config = validateConfig({ ...configValue(), depth });
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1') return new Response(xml(parsed.hostname), { headers: { 'Content-Type': 'application/rss+xml' } });
    if (parsed.pathname === '/api/tags') return Response.json({ models: [{ name: 'qwen2.5-coder:7b' }] });
    const body = JSON.parse(options.body), prompt = body.messages[1].content;
    const input = JSON.parse(prompt.slice(0, prompt.indexOf('\nEsquema:'))), properties = body.format.properties;
    assert.equal(body.format.type, 'object'); assert.equal(body.tools, undefined); assert.match(body.messages[0].content, /NÃO CONFIÁVEIS/);
    let value, stage;
    if (properties.angle) { stage = 'plan'; assert.equal(properties.sourceIds, undefined); value = { kind: 'roundup', angle: badPlan === 'short' ? 'Curto' : badPlan === 'url' ? 'Confira https://example.com para todas as referências deste estudo' : 'Comparar limites e aplicações dos estudos relatados' }; }
    else if (properties.facts) { stage = 'card'; assert.deepEqual(Object.keys(properties), ['facts']); assert.equal(properties.facts.items.properties.quote, undefined); value = { summary: 'O relatório descreve uma comparação controlada com alcance limitado ao cenário avaliado.', facts: [{ statement: 'O relatório apresenta uma comparação de comportamento em condições determinadas.', evidenceId: input.collectedEvidence[0].id }], limitations: 'O resumo não estabelece generalização para outros cenários.' }; }
    else if (properties.overview) {
      stage = 'draft'; assert.equal(properties.sourceIds, undefined); assert.equal(properties.findings, undefined);
      assert.equal(properties.overview.maxLength, undefined); assert.equal(properties.overview.minLength, undefined);
      value = { title: 'Comparações controladas e limites dos modelos locais', overview: 'Os relatos apresentam comparações em condições determinadas e destacam limites de generalização. O panorama compara o alcance das evidências disponíveis e propõe perguntas para avaliações adicionais.', uncertainties: 'Os resumos não permitem verificar a transferência dos resultados para outros ambientes.', perspectives: [{ label: 'Aplicações', argument: 'Comparações controladas podem orientar a escolha de novos experimentos.', caveat: 'Isso não demonstra desempenho geral.' }, { label: 'Limitações', argument: 'É preciso examinar os métodos antes de aplicar as conclusões a outros contextos.', caveat: 'Os resumos oferecem contexto limitado.' }], questions: ['Como testar a generalização?', 'Quais variáveis precisam ser controladas?'] };
      if (badQuestions) value.questions = [
        'Como CLR-Bench pode ser aplicado em cenários reais?',
        'Quais são os desafios na implementação de sistemas de versão AI?'
      ];
      const draftIndex = draftCalls++;
      if (draftIndex < significanceOverviews)
        value.overview = 'As duas publicações apresentam avanços significativos em inteligência artificial que transformam o campo. O texto combina resultados independentes e estabelece um impacto amplo que as fontes consultadas não permitem concluir.';
      if (significancePerspective)
        value.perspectives[0].argument = 'As pesquisas produziram contribuições significativas para a tecnologia atual.';
      if (mixedUncertaintyShort && draftIndex === 0)
        value.uncertainties = 'A benéfica precisa ser avaliada de forma mais detalhada.';
      if (mixedOverviewArticleFirst && draftIndex === 0)
        value.overview = 'A CLR-Bench mede a capacidade de aprendizado entre modelos de IA, enquanto a MIT nomeia bolsistas para pesquisa em IA benéfica. Ambas as iniciativas demonstram progresso e prioridades da área.';
      if ((mixedUncertaintyShort || mixedOverviewArticleFirst) && draftIndex === 1) {
        value.overview = 'Os dois relatos tratam de modelos em situações diferentes. É preciso verificar cada fonte original.';
        if (mixedShortUnsafe === 'url') value.overview = 'Consulte https://example.com para entender os modelos citados.';
        if (mixedShortUnsafe === 'truncated') value.overview = 'Os dois relatos apresentam modelos que ainda não';
        if (mixedShortUnsafe === 'perspective')
          value.perspectives[0].argument = 'As pesquisas produziram avanços significativos para os métodos de todos os modelos.';
        if (mixedShortUnsafe === 'uncertainty')
          value.uncertainties = 'A benéfica precisa ser avaliada de forma mais detalhada.';
        if (mixedShortUnsafe === 'title')
          value.title = 'A CLR-Bench e seus desdobramentos em novas tecnologias';
      }
      if (draftIndex < brokenDrafts) value.overview = 'Os relatos apresentam comparações em condições determinadas e destacam limites de generalização. O panorama compara o alcance das evidências disponíveis. Esses進';
      if (draftIndex < shortOverviews) value.overview = 'O relato descreve resultados limitados e recomenda ampliar os testes.';
      if (draftIndex < urlOverviews && draftIndex >= significanceOverviews) value.overview = 'O modelo encontra detalhes na página https://example.com que precisam ser lidos.';
    } else if (properties.heading) {
      stage = 'section'; assert.equal(properties.paragraphs.type, 'object');
      value = { heading: input.focus, paragraphs: Object.fromEntries(input.evidenceCards.map(c => [c.sourceId, 'O relato descreve uma comparação sob condições determinadas. Essa descrição permite formular questões metodológicas, mas não confirma aplicação em cenários diferentes.'])), limitations: 'As descrições disponíveis não substituem a leitura dos métodos completos.' };
    } else {
      stage = 'review'; const reject = criticCalls++ < criticRejects;
      assert.equal(properties.approved, undefined);
      const questionTarget = input.material.find(part => part.text.startsWith('PERGUNTAS ABERTAS\n'));
      value = { findings: reject ? [
        { kind: 'unsupported-claim', claimId: criticOnlyQuestions ? questionTarget?.id : input.material[0].id, reason: criticReason },
        ...(criticMixedBlockers ? [{ kind: 'unsupported-claim', claimId: input.material[0].id, reason: criticReason }] : [])
      ] : criticAdvice ? [{ kind: 'missing-detail', claimId: input.material[0].id, reason: 'O resumo não apresenta os nomes dos pesquisadores nem métodos completos.' }] : [], note: 'Revisão interna baseada apenas nas evidências fornecidas.' };
    }
    calls.push({ stage, input, prompt });
    return Response.json({ message: { content: invalidModel ? '{invalid' : JSON.stringify(value) }, done: true, done_reason: 'stop', prompt_eval_count: 200, eval_count: 150, eval_duration: 1e9 });
  };
  const policy = { protocol: 'aif-agent-access-v1', policyVersion: '2026-11-01', audience: 'https://forum.example', issuer: 'https://forum.example', features: { idempotentWrites: idempotent } };
  const client = {
    api: 'https://forum.example',
    async request(route) {
      if (route === '/api/agent-access/policy') return policy;
      if (route === '/api/topics') return { topics };
      const topic = topics.find(p => '/api/topics/' + p.id === route);
      if (topic) return { topic: { ...topic, replies: replies.filter(r => r.topicId === topic.id) } };
      throw Error('Unexpected route: ' + route);
    },
    async authorized(route, options) {
      writeCalls++;
      let value = receipts.get(options.idempotencyKey);
      if (!value) {
        if (route === '/api/topics') { const topic = { ...options.body, id: 'topic-' + (topics.length + 1), authorId: 'agent-1', createdAt: new Date(now).toISOString() }; topics.push(topic); value = { topic }; }
        else { const reply = { ...options.body, id: 'reply-' + (replies.length + 1), topicId: route.split('/')[3], authorId: 'agent-1', createdAt: new Date(now).toISOString() }; replies.push(reply); value = { reply }; }
        receipts.set(options.idempotencyKey, value);
      }
      if (writeCalls === loseReceiptAt) throw Error('Connection lost after server commit');
      return value;
    }
  };
  const store = new ResearchStore(path.join(directory, 'state.json'), { clock });
  const feeds = new FeedReader(config, { fetchImpl, clock, sleep });
  const model = new OllamaResearcher({ config, fetchImpl, clock });
  const engine = new ResearchEngine({ config, store, feeds, model, client, draftDir: path.join(directory, 'drafts'), acceptedPolicy: '2026-11-01', clock, sleep, log: () => {} });
  return { engine, store, config, model, calls, waits, topics, replies, directory, policy, clock, get writeCalls() { return writeCalls; } };
}

test('Nature content:encoded is usable; missing links, future dates and local URLs are rejected', () => {
  const body = '<rss><item><title>Current scientific report</title><link>https://www.nature.com/articles/a</link><content:encoded><![CDATA[<p>Current methods and findings.</p>]]></content:encoded><dc:date>2026-10-30</dc:date></item></rss>';
  assert.equal(readFeed(body, 'https://www.nature.com/feed', { clock: NOW }).length, 1);
  assert.equal(readFeed(body.replace(/<link>.*?<\/link>/, ''), 'https://www.nature.com/feed', { clock: NOW }).length, 0);
  assert.equal(readFeed(body.replace('2026-10-30', '2026-11-03'), 'https://www.nature.com/feed', { clock: NOW }).length, 0);
  for (const url of ['https://127.0.0.1/a', 'https://[::1]/a', 'https://internal/a', 'https://host.local/a', 'https://x:secret@example.org/a']) assert.throws(() => publicURL(url));
});
test('publisher mapping prevents NASA subdomains from satisfying diversity', () => {
  const publishers = [{ id: 'nasa', hosts: ['www.nasa.gov', 'science.nasa.gov'] }];
  const left = readFeed(xml('www.nasa.gov'), 'https://www.nasa.gov/feed', { clock: NOW, publishers });
  const right = readFeed(xml('science.nasa.gov'), 'https://science.nasa.gov/feed', { clock: NOW, publishers });
  assert.equal(chooseArticles([...left, ...right]).length, 0);
});
test('an invented evidence quote is rejected', () => {
  assert.throws(() => validateCard({ summary: 'Uma explicação suficientemente extensa do relatório consultado.', facts: [{ statement: 'Um resultado que parece convincente mas não está demonstrado.', quote: 'An invented result absent from the source.' }], limitations: 'A informação exige confirmação.' }, { summary: excerpt }), /not found/);
  assert.throws(() => validateCard({ summary: 'Uma explicação suficientemente extensa do relatório consultado.', facts: [{ statement: 'O estudo demonstrou precisão de 99% em todos os cenários.', quote: excerpt.slice(0, 87) }], limitations: 'A informação exige confirmação.' }, { summary: excerpt }), /Numeric fact/);
});
test('model selects existing evidence IDs; literal text is recovered by code instead of copied or translated', () => {
  const source = { id: 'S1', summary: excerpt }, spans = evidenceSpans(excerpt);
  const card = { summary: 'O relatório descreve uma comparação e seu alcance limitado.', facts: [{ statement: 'O relatório descreve uma comparação de comportamento em condições controladas.', evidenceId: spans[0].id }], limitations: 'O resumo não sustenta generalização.' };
  const verified = validateCard(card, source, { spans, requireSelection: true });
  assert.equal(verified.facts[0].quote, spans[0].text); assert.ok(excerpt.includes(verified.facts[0].quote));
  assert.throws(() => validateCard({ ...card, facts: [{ ...card.facts[0], evidenceId: 'E999' }] }, source, { spans, requireSelection: true }), /existing evidenceId/);
  assert.throws(() => validateCard({ ...card, facts: [{ statement: card.facts[0].statement, quote: 'O relatório apresenta uma comparação.' }] }, source, { spans, requireSelection: true }), /existing evidenceId/);
  assert.throws(() => validateCard({ ...card, facts: [{ statement: 'O estudo demonstrou precisão de 99% em todos os cenários.', evidenceId: spans[0].id }] }, source, { spans, requireSelection: true }), /Numeric fact/);
});
test('evidence spans remain literal and preserve short leading qualifications and long tokens', () => {
  const original = 'No. ' + 'This result applies only to a restricted setting. '.repeat(12) + 'x'.repeat(250);
  const spans = evidenceSpans(original), corpus = normalized(original);
  assert.ok(spans[0].text.startsWith('No.')); assert.ok(spans.every(s => s.text.length >= 15 && s.text.length <= 300 && corpus.includes(s.text)));
  assert.equal(spans.map(s => s.id).length, new Set(spans.map(s => s.id)).size);
});
test('opening citations retain distinct publishers even if the first notes are from the same publisher', () => {
  const sources = [{ id: 'S1', publisherId: 'first' }, { id: 'S2', publisherId: 'first' }, { id: 'S3', publisherId: 'second' }];
  const cards = sources.map(s => ({ sourceId: s.id, facts: [{ statement: 'O relatório descreve resultados com alcance metodológico limitado.' }] }));
  const result = openingEvidence(cards, sources);
  assert.ok(result.sourceIds.includes('S3')); assert.equal(new Set(result.sourceIds).size, result.sourceIds.length);
});
test('preview completes plan, extraction, writing and review without public writes', async t => {
  const f = fixture(t); const result = await f.engine.generate();
  assert.equal(result.status, 'draft'); assert.equal(f.topics.length, 0); assert.equal(f.writeCalls, 0);
  assert.deepEqual(f.calls.map(c => c.stage), ['plan', 'card', 'card', 'draft', 'review']);
  const draft = readJSON(result.file);
  assert.equal(draft.hash, payloadHash(draft)); assert.match(draft.post.content, /Pesquisa [a-f0-9]{24}/);
  assert.match(draft.post.content, /\[S1\]/); assert.match(draft.post.content, /\[S2\]/);
  assert.deepEqual(draft.plan.sourceIds, ['S1', 'S2']);
  assert.equal(draft.cards[0].facts[0].quote, evidenceSpans(excerpt)[0].text);
  assert.equal(fs.existsSync(result.markdown), true);
});
test('doctor reports usable themes with an older Worker as ready with actionable warnings', async t => {
  const f = fixture(t, { idempotent: false }); const result = await f.engine.doctor();
  assert.equal(result.status, 'ready-with-warnings'); assert.equal(result.themes[0].ready, true);
  assert.ok(result.warnings.some(w => w.includes('idempotente'))); assert.equal(f.writeCalls, 0); assert.equal(f.calls.length, 0);
});
test('doctor distinguishes missing operator policy consent from backend idempotency support', async t => {
  const f = fixture(t, { idempotent: false });
  f.engine.acceptedPolicy = undefined;
  const result = await f.engine.doctor();
  assert.equal(result.status, 'ready-with-warnings');
  assert.equal(result.api.accepted, false);
  assert.equal(result.api.idempotentWrites, false);
  assert.ok(result.warnings.some(w => /FORUM_ACCEPT_POLICY/.test(w)));
  assert.ok(result.warnings.some(w => /idempotente/.test(w)));
  assert.equal(f.writeCalls, 0);
});
test('grounding audit receipt is mandatory even for a previously approved, correctly hashed draft', async t => {
  const f = fixture(t); const preview = await f.engine.generate();
  const draft = readJSON(preview.file);
  assert.equal(draft.review.factualGate?.passed, true);
  assert.equal(draft.review.factualGate?.independent, false);
  assert.equal(draft.review.factualGate?.humanVerificationRequired, true);
  delete draft.review.factualGate;
  draft.hash = payloadHash(draft);
  writeJSON(preview.file, draft);
  await assert.rejects(f.engine.publish(preview.file, draft.hash), /predates factual grounding/);
  assert.equal(f.writeCalls, 0, 'old approved drafts cannot bypass the new preflight');
});

test('publishing re-verifies selected literal RSS evidence even with a recomputed valid draft hash', async t => {
  const f = fixture(t); const preview = await f.engine.generate({ depth: 'quick' });
  const draft = readJSON(preview.file);
  draft.cards[0].facts[0].quote = 'Made-up citation; this text is absent from the original RSS source.';
  draft.hash = payloadHash(draft); writeJSON(preview.file, draft);
  await assert.rejects(f.engine.publish(preview.file, draft.hash), /evidence quote no longer matches/);
  assert.equal(f.writeCalls, 0, 'a forged quote must never reach the remote API');

  draft.cards[0].facts[0].quote = evidenceSpans(excerpt)[0].text;
  draft.cards[0].facts[0].statement = 'O estudo demonstrou 99 resultados comprovados em todas as condições.';
  draft.hash = payloadHash(draft); writeJSON(preview.file, draft);
  await assert.rejects(f.engine.publish(preview.file, draft.hash), /numeric claim is absent/);
  assert.equal(f.writeCalls, 0);
});

test('pre-0.7.1 draft with valid hash and same-model review cannot skip new evidence-card rules', async t => {
  const f = fixture(t);
  const preview = await f.engine.generate();
  const draft = readJSON(preview.file);
  draft.generatorVersion = '3.0.0';
  draft.hash = payloadHash(draft);
  writeJSON(preview.file, draft);
  await assert.rejects(f.engine.publish(preview.file, draft.hash), /requires regeneration/);
  assert.equal(f.writeCalls, 0);
});

test('explicit operator approval is required for a valid machine-reviewed draft', async t => {
  const f = fixture(t);
  const preview = await f.engine.generate();
  await assert.rejects(f.engine.publish(preview.file, preview.hash), /Human approval missing/);
  assert.equal(f.writeCalls, 0);
  await assert.rejects(f.engine.approve(preview.file, preview.hash), /operator confirmation/);
  const receipt = await f.engine.approve(preview.file, preview.hash, { confirmed: true });
  assert.equal(receipt.status, 'human-approved');
  assert.equal(receipt.hash, preview.hash);
  assert.equal(f.store.read().approvals[0].hash, preview.hash);
});

test('unattended generation refuses all writes before contacting the model', async t => {
  const f = fixture(t);
  await assert.rejects(f.engine.generate({ auto: true }), /Unattended research publishing is disabled/);
  assert.equal(f.writeCalls, 0); assert.equal(f.calls.length, 0);
});

test('publication sends the exact reviewed draft; changed drafts are blocked', async t => {
  const f = fixture(t); const preview = await f.engine.generate(); const reviewed = readJSON(preview.file);
  await f.engine.approve(preview.file, preview.hash, { confirmed: true }); const result = await f.engine.publish(preview.file, preview.hash);
  assert.equal(result.status, 'published'); assert.equal(f.topics[0].title, reviewed.post.title); assert.equal(f.topics[0].content, reviewed.post.content);
  assert.equal(f.calls.filter(c => c.stage === 'draft').length, 1, 'publishing must not invoke the model');
  const repeated = await f.engine.publish(preview.file, preview.hash); assert.equal(repeated.status, 'already-published'); assert.equal(f.writeCalls, 1);
  reviewed.post.content += ' Unreviewed change'; writeJSON(preview.file, reviewed);
  await assert.rejects(f.engine.publish(preview.file, preview.hash), /hash/);
});
test('expired drafts and drafts for another API never cause a public write', async t => {
  const f = fixture(t); const preview = await f.engine.generate();
  const draft = readJSON(preview.file); draft.createdAt = new Date(NOW - 2 * 86400000).toISOString(); draft.hash = payloadHash(draft); writeJSON(preview.file, draft);
  await assert.rejects(f.engine.publish(preview.file, draft.hash), /expired/);
  draft.createdAt = new Date(NOW).toISOString(); draft.api = 'https://other.example'; draft.hash = payloadHash(draft); writeJSON(preview.file, draft);
  await assert.rejects(f.engine.publish(preview.file, draft.hash), /API\/policy/); assert.equal(f.writeCalls, 0);
});
test('deep mode publishes a single thread with two reviewed continuations and rate spacing', async t => {
  const f = fixture(t, { depth: 'deep' }); const preview = await f.engine.generate();
  assert.equal(preview.messages, 3);
  await f.engine.approve(preview.file, preview.hash, { confirmed: true }); await f.engine.publish(preview.file, preview.hash);
  assert.equal(f.topics.length, 1); assert.equal(f.replies.length, 2); assert.deepEqual(f.waits, [21000, 21000]);
  assert.equal(f.store.read().messages.length, 3); assert.equal(f.store.read().pending, null);
});
test('lost topic receipt is retried with the same key and does not create a duplicate', async t => {
  const f = fixture(t, { loseReceiptAt: 1 }); const preview = await f.engine.generate();
  await f.engine.approve(preview.file, preview.hash, { confirmed: true }); await assert.rejects(f.engine.publish(preview.file, preview.hash), /Connection lost/);
  assert.equal(f.store.read().pending.messages[0].status, 'sending'); assert.equal(f.topics.length, 1);
  await f.engine.approve(preview.file, preview.hash, { confirmed: true }); await f.engine.publish(preview.file, preview.hash);
  assert.equal(f.topics.length, 1); assert.equal(f.store.read().published.length, 1); assert.equal(f.store.read().pending, null);
});
test('older Workers block ambiguous retries and reconcile from a public receipt', async t => {
  const f = fixture(t, { loseReceiptAt: 1, idempotent: false }); const preview = await f.engine.generate();
  await f.engine.approve(preview.file, preview.hash, { confirmed: true }); await assert.rejects(f.engine.publish(preview.file, preview.hash), /Connection lost/);
  await assert.rejects(f.engine.publish(preview.file, preview.hash), /uncertain/);
  assert.equal(f.writeCalls, 1);
  const result = await f.engine.reconcile(); assert.equal(result.status, 'reconciled'); assert.equal(f.store.read().published.length, 1);
});
test('reconciliation resumes only missing deep replies after a lost receipt', async t => {
  const f = fixture(t, { depth: 'deep', loseReceiptAt: 2 }); const preview = await f.engine.generate();
  await f.engine.approve(preview.file, preview.hash, { confirmed: true }); await assert.rejects(f.engine.publish(preview.file, preview.hash), /Connection lost/);
  assert.equal(f.topics.length, 1); assert.equal(f.replies.length, 1);
  assert.equal((await f.engine.reconcile()).status, 'partial');
  await f.engine.approve(preview.file, preview.hash, { confirmed: true }); await f.engine.publish(preview.file, preview.hash);
  assert.equal(f.topics.length, 1); assert.equal(f.replies.length, 2); assert.equal(f.store.read().messages.length, 3);
});
test('cancellation preserves uncertain delivery history and permanently blocks resending that draft', async t => {
  const f = fixture(t, { loseReceiptAt: 1 }); const preview = await f.engine.generate();
  await f.engine.approve(preview.file, preview.hash, { confirmed: true }); await assert.rejects(f.engine.publish(preview.file, preview.hash), /Connection lost/);
  const result = await f.engine.cancel(preview.file, preview.hash);
  assert.equal(result.status, 'cancelled'); assert.equal(f.store.read().pending, null); assert.equal(f.store.read().published[0].status, 'cancelled');
  await assert.rejects(f.engine.publish(preview.file, preview.hash), /cancelled/); assert.equal(f.topics.length, 1); assert.equal(f.writeCalls, 1);
});
test('editorial rejection gets one revision, then fails closed', async t => {
  const f = fixture(t, { criticRejects: 10 });
  await assert.rejects(f.engine.generate({ auto: false }), /Editorial review rejected/);
  assert.equal(f.calls.filter(c => c.stage === 'draft').length, 2); assert.equal(f.topics.length, 0);
  assert.equal(f.store.read().runs.at(-1).status, 'failed'); assert.equal(f.writeCalls, 0);
  const reportFile = f.store.read().runs.at(-1).diagnosticFile, report = readJSON(reportFile);
  assert.equal(report.status, 'rejected'); assert.equal(report.attempts.length, 2); assert.equal(report.attempts[0].review.approved, false);
  assert.ok(fs.existsSync(reportFile.replace(/\.json$/, '.md')));
  await assert.rejects(f.engine.publish(reportFile, 'a'.repeat(64)), /hash|format/i); assert.equal(f.writeCalls, 0);
});

test('two persistent question-only review failures trigger source-bounded repair and a third full review', async t => {
  const f = fixture(t, { criticRejects: 2, criticOnlyQuestions: true, badQuestions: true });
  const preview = await f.engine.generate({ auto: false, depth: 'quick' });
  assert.equal(preview.status, 'draft');
  const result = readJSON(preview.file);
  assert.equal(result.editorial.opening.questionsMode, 'source-bounded-repair');
  assert.match(result.post.content, /Que limitações precisam ser esclarecidas/);
  assert.doesNotMatch(result.post.content, /sistemas de versão AI/iu);
  assert.match(result.post.content, /relato da fonte S1/);
  assert.equal(f.calls.filter(call => call.stage === 'draft').length, 2);
  assert.equal(f.calls.filter(call => call.stage === 'review').length, 3);
  assert.equal(f.writeCalls, 0);
});

test('repaired questions still fail closed when the new editorial review rejects them', async t => {
  const f = fixture(t, { criticRejects: 3, criticOnlyQuestions: true });
  await assert.rejects(f.engine.generate({ auto: false }), /Editorial review rejected source-bounded questions/);
  assert.equal(f.calls.filter(call => call.stage === 'review').length, 3);
  assert.equal(f.writeCalls, 0);
});

test('mixed factual and question defects never trigger question-only recovery', async t => {
  const f = fixture(t, { criticRejects: 2, criticOnlyQuestions: true, criticMixedBlockers: true });
  await assert.rejects(f.engine.generate({ auto: false }), /Editorial review rejected the opening/);
  assert.equal(f.calls.filter(call => call.stage === 'review').length, 2);
  assert.equal(f.writeCalls, 0);
});

test('critic hallucinations never become evidence or text instructions for the next draft', async t => {
  const f = fixture(t, { criticRejects: 1, criticReason: 'Education Innovation é prova de progresso técnico, mas não consta da fonte.' });
  const preview = await f.engine.generate({ auto: false, depth: 'quick' });
  assert.equal(preview.status, 'draft');
  const drafts = f.calls.filter(c => c.stage === 'draft');
  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts[0].input.corrections, []);
  assert.deepEqual(drafts[1].input.corrections, [{ kind: 'unsupported-claim', claimId: 'C1', rejectedText: 'Comparações controladas e limites dos modelos locais' }]);
  assert.doesNotMatch(JSON.stringify(drafts[1].input), /Education Innovation/);
  assert.match(drafts[1].input.task, /não é evidência/);
  assert.equal(f.calls.filter(c => c.stage === 'review').length, 2);
  assert.equal(f.writeCalls, 0, 'preview never posts anything');
});

test('blocked second draft receives targeted rejected sentence, never critic reason', async t => {
  const f = fixture(t, { criticRejects: 1, criticReason: 'O crítico cita uma fonte não fornecida: Ensino e Empreendedorismo.' });
  const preview = await f.engine.generate({ auto: false });
  assert.equal(preview.status, 'draft');
  const drafts = f.calls.filter(c => c.stage === 'draft');
  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts[1].input.corrections, [{
    kind: 'unsupported-claim',
    claimId: 'C1',
    rejectedText: 'Comparações controladas e limites dos modelos locais'
  }]);
  assert.doesNotMatch(JSON.stringify(drafts[1].input), /Ensino e Empreendedorismo/);
  assert.match(drafts[1].input.task, /não é evidência/);
  assert.equal(f.writeCalls, 0);
});

test('invalid short overview retries with a precise minimum length without bypassing editorial review', async t => {
  const f = fixture(t, { shortOverviews: 1 });
  const preview = await f.engine.generate({ depth: 'quick' });
  assert.equal(preview.status, 'draft');
  const drafts = f.calls.filter(c => c.stage === 'draft');
  assert.equal(drafts.length, 2);
  assert.match(drafts[1].prompt, /overview deve ter 160 a 450 caracteres/);
  assert.equal(f.calls.filter(c => c.stage === 'review').length, 1);
  assert.equal(f.writeCalls, 0);
});

test('two short complete Qwen overviews yield a preview-only conservative source-fact summary with mandatory review', async t => {
  const f = fixture(t, { shortOverviews: 10 });
  const preview = await f.engine.generate({ auto: false, depth: 'quick' });
  assert.equal(preview.status, 'draft');
  const draft = readJSON(preview.file);
  assert.equal(draft.editorial.opening.overviewMode, 'reviewed-source-facts-fallback');
  assert.match(draft.editorial.opening.overview, /A fonte S1 relata:/);
  assert.match(draft.editorial.opening.overview, /A fonte S2 relata:/);
  assert.doesNotMatch(draft.editorial.opening.overview, /O relato descreve resultados limitados/);
  assert.ok(draft.editorial.opening.overview.length >= 160);
  assert.equal(f.calls.filter(call => call.stage === 'draft').length, 2);
  assert.equal(f.calls.filter(call => call.stage === 'review').length, 1, 'fallback never bypasses editorial review');
  assert.equal(draft.review.factualGate.passed, true);
  assert.equal(draft.review.factualGate.humanVerificationRequired, true);
  assert.equal(f.writeCalls, 0, 'preview never publishes');
});

test('previous invalid CLR-Bench article is discarded, but only after a valid second short draft', async t => {
  const f = fixture(t, { mixedOverviewArticleFirst: true });
  const preview = await f.engine.generate({ auto: false, depth: 'quick' });
  const draft = readJSON(preview.file);
  assert.equal(preview.status, 'draft');
  assert.equal(draft.editorial.opening.overviewMode, 'corrected-uncertainty-short-overview-preview-fallback');
  assert.equal(f.model.validationTrace.filter(item => item.stage === 'draft')[0].error,
    'Editorial Portuguese: incorrect article for scientific/institutional name in overview');
  assert.doesNotMatch(draft.post.content, /A CLR-Bench|a MIT|Ambas as iniciativas demonstram/iu);
  assert.equal(f.calls.filter(item => item.stage === 'review').length, 1);
  assert.equal(f.writeCalls, 0);
});

test('a mixed fallback cannot hide an invalid newly generated title', async t => {
  const f = fixture(t, { mixedUncertaintyShort: true, mixedShortUnsafe: 'title' });
  // The title is validated before overview length; an earlier, more specific
  // rejection is expected and proves the invalid field was not masked.
  await assert.rejects(f.engine.generate({ auto: false, depth: 'quick' }),
    /draft: Editorial Portuguese: incorrect article for scientific\/institutional name in title/);
  assert.equal(f.calls.filter(item => item.stage === 'review').length, 0);
  assert.equal(f.writeCalls, 0);
});

test('real incident: corrected malformed uncertainty followed by safe short overview produces a reviewed preview', async t => {
  const f = fixture(t, { mixedUncertaintyShort: true });
  const preview = await f.engine.generate({ auto: false, depth: 'quick' });
  const draft = readJSON(preview.file);
  assert.equal(preview.status, 'draft');
  assert.equal(draft.editorial.opening.overviewMode, 'corrected-uncertainty-short-overview-preview-fallback');
  assert.match(draft.editorial.opening.overview, /A fonte S1 relata:/);
  assert.match(draft.editorial.opening.overview, /A fonte S2 relata:/);
  assert.doesNotMatch(draft.post.content, /A benéfica precisa ser avaliada/iu);
  assert.equal(f.model.validationTrace.filter(item => item.stage === 'draft').length, 2);
  assert.deepEqual(f.model.validationTrace.filter(item => item.stage === 'draft').map(item => item.error), [
    'Factual grounding: malformed use of benéfica in uncertainties',
    'Invalid overview (length, URL or control character)'
  ]);
  assert.equal(f.calls.filter(call => call.stage === 'draft').length, 2);
  assert.equal(f.calls.filter(call => call.stage === 'review').length, 1);
  assert.equal(draft.review.factualGate.humanVerificationRequired, true);
  assert.equal(f.writeCalls, 0);
});

test('mixed-failure overview fallback never waives invalid URL, truncation or a second invalid field', async t => {
  for (const unsafe of ['url', 'truncated', 'perspective', 'uncertainty']) {
    const f = fixture(t, { mixedUncertaintyShort: true, mixedShortUnsafe: unsafe });
    await assert.rejects(f.engine.generate({ auto: false, depth: 'quick' }));
    assert.equal(f.calls.filter(call => call.stage === 'review').length, 0, unsafe);
    assert.equal(f.writeCalls, 0, unsafe);
  }
});

test('mixed-failure fallback is preview-only even when corrected fields and short synopsis are safe', async t => {
  const f = fixture(t, { mixedUncertaintyShort: true });
  const sources = chooseArticles([
    ...readFeed(xml('first.example'), 'https://first.example/feed', { clock: NOW, publishers: f.config.publishers }),
    ...readFeed(xml('second.example'), 'https://second.example/feed', { clock: NOW, publishers: f.config.publishers })
  ], [], { count: 2, minHosts: 2 });
  await assert.rejects(f.model.build(f.config.topics[0], sources, { depth: 'quick', allowDraftFallback: false }),
    /draft: Invalid overview/);
  assert.equal(f.calls.filter(call => call.stage === 'review').length, 0);
  assert.equal(f.writeCalls, 0);
});

test('two unsupported-significance overviews recover only in preview and still receive full review', async t => {
  const f = fixture(t, { significanceOverviews: 2 });
  const preview = await f.engine.generate({ auto: false, depth: 'quick' });
  assert.equal(preview.status, 'draft');
  const draft = readJSON(preview.file);
  assert.equal(draft.editorial.opening.overviewMode, 'rejected-significance-preview-fallback');
  assert.match(draft.editorial.opening.overview, /A fonte S1 relata:/);
  assert.match(draft.editorial.opening.overview, /A fonte S2 relata:/);
  assert.doesNotMatch(draft.post.content, /avanços significativos|impacto amplo/iu);
  assert.equal(f.calls.filter(call => call.stage === 'draft').length, 2);
  assert.equal(f.calls.filter(call => call.stage === 'review').length, 1);
  assert.equal(draft.review.factualGate.humanVerificationRequired, true);
  assert.equal(f.writeCalls, 0);
});

test('unsupported significance cannot hide a second invalid perspective', async t => {
  const f = fixture(t, { significanceOverviews: 2, significancePerspective: true });
  await assert.rejects(f.engine.generate({ auto: false, depth: 'quick' }), /draft: Factual grounding/);
  assert.equal(f.calls.filter(call => call.stage === 'review').length, 0);
  assert.equal(f.writeCalls, 0);
});

test('one unsupported-significance failure followed by a different failure never qualifies for fallback', async t => {
  const f = fixture(t, { significanceOverviews: 1, urlOverviews: 2 });
  await assert.rejects(f.engine.generate({ auto: false, depth: 'quick' }), /draft: Invalid overview/);
  assert.equal(f.calls.filter(call => call.stage === 'review').length, 0);
  assert.equal(f.writeCalls, 0);
});

test('short overviews containing links do not qualify for recovery even in preview', async t => {
  const f = fixture(t, { urlOverviews: 10 });
  await assert.rejects(f.engine.generate({ auto: false }), /draft: Invalid overview/);
  assert.equal(f.calls.filter(call => call.stage === 'review').length, 0);
  assert.equal(f.writeCalls, 0);
});

test('strict model build rejects repeated short overviews without a preview fallback', async t => {
  const f = fixture(t, { shortOverviews: 10 });
  const sources = chooseArticles([
    ...readFeed(xml('first.example'), 'https://first.example/feed', { clock: NOW, publishers: f.config.publishers }),
    ...readFeed(xml('second.example'), 'https://second.example/feed', { clock: NOW, publishers: f.config.publishers })
  ], [], { count: 2, minHosts: 2 });
  await assert.rejects(f.model.build(f.config.topics[0], sources, { depth: 'quick', allowDraftFallback: false }), /draft: Invalid overview/);
  assert.equal(f.calls.filter(c => c.stage === 'review').length, 0);
  assert.equal(f.writeCalls, 0);
});

test('missing details in a short feed produce advice without an unnecessary writer retry', async t => {
  const f = fixture(t, { criticAdvice: true }); const preview = await f.engine.generate();
  const draft = readJSON(preview.file), review = draft.review.checks[0];
  assert.equal(review.approved, true); assert.equal(review.issues.length, 0); assert.match(review.suggestions[0], /nomes dos pesquisadores/);
  assert.equal(f.calls.filter(c => c.stage === 'draft').length, 1); assert.equal(f.writeCalls, 0);
});
test('cut prose is rewritten before review, instead of accepting JSON validity as text quality', async t => {
  const f = fixture(t, { brokenDrafts: 1 }); const preview = await f.engine.generate();
  assert.equal(readJSON(preview.file).schemaVersion, 3);
  assert.equal(f.calls.filter(call => call.stage === 'draft').length, 2);
  assert.equal(f.calls.filter(call => call.stage === 'review').length, 1);
  assert.doesNotMatch(readJSON(preview.file).post.content, /進/); assert.equal(f.writeCalls, 0);
});
test('persistently cut text stops auto publishing and saves the invalid fields for diagnosis', async t => {
  const f = fixture(t, { brokenDrafts: 10 });
  await assert.rejects(f.engine.generate({ auto: false }), /Unexpected characters/);
  assert.equal(f.calls.filter(call => call.stage === 'review').length, 0); assert.equal(f.writeCalls, 0);
  const report = readJSON(f.store.read().runs.at(-1).diagnosticFile);
  assert.equal(report.validationErrors.length, 2); assert.match(report.validationErrors[0].output, /進/);
});
test('publication rechecks complete editorial fields and rejects older or differently rendered drafts', async t => {
  const f = fixture(t); const preview = await f.engine.generate(); const draft = readJSON(preview.file);
  draft.post.content += ' Alteração fora dos campos revisados.'; draft.hash = payloadHash(draft); writeJSON(preview.file, draft);
  await assert.rejects(f.engine.publish(preview.file, draft.hash), /differs from its validated/); assert.equal(f.writeCalls, 0);
  draft.schemaVersion = 2; draft.hash = payloadHash(draft); writeJSON(preview.file, draft);
  await assert.rejects(f.engine.publish(preview.file, draft.hash), /predates complete-text/); assert.equal(f.writeCalls, 0);
});
test('authentication failure before a publishing request is safe to retry even with an older Worker', async t => {
  const f = fixture(t, { idempotent: false }); const preview = await f.engine.generate();
  const send = f.engine.client.authorized;
  f.engine.client.authorized = async () => { throw Object.assign(Error('Challenge did not validate'), { delivery: 'not-sent' }); };
  await f.engine.approve(preview.file, preview.hash, { confirmed: true }); await assert.rejects(f.engine.publish(preview.file, preview.hash), /Challenge did not validate/);
  assert.equal(f.store.read().pending.messages[0].status, 'ready'); assert.equal(f.writeCalls, 0);
  f.engine.client.authorized = send;
  assert.equal((await f.engine.publish(preview.file, preview.hash)).status, 'published'); assert.equal(f.topics.length, 1);
});
test('cancelling the known 0.5.3 enrollment failure preserves the draft without consuming publication quotas', async t => {
  const f = fixture(t, { idempotent: false }); const preview = await f.engine.generate();
  f.engine.client.authorized = async () => { throw Error('Untrusted or expired enrollment challenge'); };
  await f.engine.approve(preview.file, preview.hash, { confirmed: true }); await assert.rejects(f.engine.publish(preview.file, preview.hash), /Untrusted/);
  assert.equal(f.store.read().pending.messages[0].status, 'sending');
  const result = await f.engine.cancel(preview.file, preview.hash), state = f.store.read();
  assert.equal(result.delivery, 'not-sent'); assert.equal(state.pending, null); assert.equal(state.published.length, 0);
  assert.deepEqual(state.usedSources, {}); assert.deepEqual(state.topicTimes, {});
  assert.equal(fs.existsSync(preview.file), true); assert.equal(state.cancelledDrafts[0].id, readJSON(preview.file).id);
  await assert.rejects(f.engine.publish(preview.file, preview.hash), /cancelled/); assert.equal(f.writeCalls, 0);
  assert.equal((await f.engine.generate()).status, 'draft');
});
test('two invalid Qwen plan angles use an explicit conservative panorama without bypassing source checks or human preview', async t => {
  const f = fixture(t, { badPlan: 'short' });
  const preview = await f.engine.generate({ auto: false, depth: 'quick' });
  assert.equal(preview.status, 'draft');
  assert.equal(f.calls.filter(c => c.stage === 'plan').length, 2, 'Qwen receives two chances to correct its plan');
  const draft = readJSON(preview.file);
  assert.equal(draft.schemaVersion, 3);
  assert.equal(draft.plan.kind, 'roundup');
  assert.equal(draft.plan.planningMode, 'deterministic-format-fallback');
  assert.deepEqual(draft.plan.sourceIds, ['S1', 'S2']);
  assert.match(draft.plan.angle, /Panorama das notícias selecionadas/);
  assert.equal(f.model.validationTrace.length, 2, 'the rejected model text remains visible in local diagnostics');
  assert.equal(f.calls.filter(c => c.stage === 'card').length, 2);
  assert.equal(f.calls.filter(c => c.stage === 'review').length, 1);
  assert.equal(f.topics.length, 0);
  assert.equal(f.writeCalls, 0, 'preview never writes to the forum');
});
test('URL in Qwen planning angle is rejected and the safe fallback preserves evidence review', async t => {
  const f = fixture(t, { badPlan: 'url' });
  const preview = await f.engine.generate({ auto: false, depth: 'quick' });
  assert.equal(preview.status, 'draft');
  const draft = readJSON(preview.file);
  assert.equal(draft.plan.planningMode, 'deterministic-format-fallback');
  assert.equal(f.calls.filter(c => c.stage === 'plan').length, 2);
  assert.equal(f.calls.filter(c => c.stage === 'review').length, 1);
  assert.equal(f.writeCalls, 0);
});
test('invalid model JSON propagates as a failure and releases the lock', async t => {
  const f = fixture(t, { invalidModel: true });
  await assert.rejects(f.engine.generate(), /plan:/); assert.equal(fs.existsSync(f.store.file + '.lock'), false);
  assert.equal(f.calls.length, 2); assert.equal(f.topics.length, 0);
});
test('one live process owns a state file, and V1 quotas survive migration', t => {
  const f = fixture(t); const release = f.store.acquire();
  assert.throws(() => f.store.acquire(), /active/); release();
  writeJSON(f.store.file, { published: [{ id: 'old', at: NOW, title: 'Earlier report' }], seenUrls: ['https://first.example/old'], topicTimes: { 'ai-research': NOW } });
  const state = f.store.read(); assert.equal(state.messages.length, 1); assert.equal(state.usedSources['https://first.example/old'].hash, '*');
});
test('dead local locks recover, while foreign locks remain protected', t => {
  const f = fixture(t);
  writeJSON(f.store.file + '.lock', { pid: 2147483647, host: f.store.host, nonce: 'stale' });
  const release = f.store.acquire(); release(); assert.equal(fs.existsSync(f.store.file + '.lock.recovery'), false);
  writeJSON(f.store.file + '.lock', { pid: 2147483647, host: 'another-machine', nonce: 'foreign' });
  assert.throws(() => f.store.acquire(), /locked/);
});
test('source cache is bounded and an interrupted V1 write is never treated as empty history', t => {
  const f = fixture(t); const state = f.store.read();
  state.cache = Object.fromEntries(Array.from({ length: 4 }, (_, i) => ['https://first.example/' + i, { xml: 'x'.repeat(1_000_000), at: NOW + i }]));
  f.store.save(state); assert.equal(Object.keys(f.store.read().cache).length, 3);
  fs.writeFileSync(f.store.file, '{interrupted'); assert.throws(() => f.store.read(), /JSON/);
});
test('publication policy is checked before any authorized request', async t => {
  const f = fixture(t); const preview = await f.engine.generate(); f.policy.policyVersion = 'another-policy';
  await f.engine.approve(preview.file, preview.hash, { confirmed: true });
  await assert.rejects(f.engine.publish(preview.file, preview.hash), /policy\/API mismatch/); assert.equal(f.writeCalls, 0);
});
test('daily limits apply before generation and theme cooldown blocks a second publication', async t => {
  const f = fixture(t); const preview = await f.engine.generate(); await f.engine.approve(preview.file, preview.hash, { confirmed: true }); await f.engine.publish(preview.file, preview.hash);
  const state = f.store.read(); state.published.push({ id: 'other', at: NOW, title: 'Other report' }); f.store.save(state);
  await assert.rejects(f.engine.generate({ auto: true }), /Unattended research publishing is disabled/);
  assert.equal(f.calls.filter(c => c.stage === 'draft').length, 1);
});
test('config rejects unknown feed hosts and overlapping publisher identities', () => {
  const value = configValue(); value.allowedFeedHosts.push('unknown.example'); assert.throws(() => validateConfig(value), /publisher/);
  const duplicate = configValue(); duplicate.publishers[1].hosts.push('first.example'); assert.throws(() => validateConfig(duplicate), /duplicate/);
  const missing = configValue(); delete missing.topics[0].id; assert.throws(() => validateConfig(missing), /Invalid/);
});
test('feed decoding preserves split UTF-8, follows only approved redirects and uses conditional cache', async () => {
  const config = validateConfig(configValue()); let requests = 0;
  const bytes = new TextEncoder().encode(xml('first.example').replace('Research update', 'Pesquisa ação'));
  const cache = {};
  const feeds = new FeedReader(config, { clock: () => NOW, fetchImpl: async (url, options) => {
    requests++;
    if (requests === 2) { assert.equal(options.headers['If-None-Match'], 'v1'); return new Response(null, { status: 304 }); }
    return new Response(new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(Uint8Array.of(b)); c.close(); } }), { headers: { etag: 'v1', 'content-type': 'application/rss+xml' } });
  } });
  assert.match((await feeds.read('https://first.example/feed', cache)).articles[0].title, /ação/);
  assert.equal((await feeds.read('https://first.example/feed', cache)).cached, true);
  const redirected = new FeedReader(config, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/feed' } }) });
  await assert.rejects(redirected.read('https://first.example/feed', {}), /public HTTPS/);
});
test('CLI rejects old ambiguous publish syntax and returns nonzero on configuration errors', () => {
  const old = spawnSync(process.execPath, ['agents/topic-researcher.mjs', '--publish'], { encoding: 'utf8' });
  assert.equal(old.status, 1); assert.match(old.stderr, /Unknown option/);
  const invalid = spawnSync(process.execPath, ['agents/topic-researcher.mjs', 'preview', '--config', 'does-not-exist.json'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Configure/);
});
test('CLI exits nonzero when model generation returns invalid JSON', t => {
  const f = fixture(t); const config = path.join(f.directory, 'config.json'), preload = path.join(f.directory, 'preload.mjs');
  writeJSON(config, configValue());
  fs.writeFileSync(preload, 'globalThis.fetch=async value=>{const u=new URL(value);return u.hostname==="127.0.0.1"?Response.json({message:{content:"invalid"}}):new Response(' + JSON.stringify(xml('first.example')) + ')};');
  // Give the second feed a distinct link while keeping all network calls intercepted.
  fs.appendFileSync(preload, '\nconst intercepted=globalThis.fetch;globalThis.fetch=async (url,options)=>{const r=await intercepted(url,options);return new URL(url).hostname==="second.example"?new Response((await r.text()).replaceAll("first.example","second.example")):r;};');
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, 'agents/topic-researcher.mjs', 'preview', '--config', config, '--state', path.join(f.directory, 'cli-state.json'), '--draft-dir', path.join(f.directory, 'cli-drafts')], { encoding: 'utf8', env: { ...process.env, OLLAMA_URL: 'http://127.0.0.1:11434', FORUM_URL: 'https://forum.example' }, timeout: 10000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /plan:/);
  assert.deepEqual(fs.readdirSync(path.join(f.directory, 'cli-drafts')), ['diagnostics']);
  assert.equal(readJSON(path.join(f.directory, 'cli-drafts', 'diagnostics', 'last-rejected.json')).status, 'rejected');
});
test('feed access denial is reported without retrying a different path or client', async () => {
  let calls = 0;
  const feeds = new FeedReader(validateConfig(configValue()), { fetchImpl: async () => { calls++; return new Response('', { status: 403 }); } });
  await assert.rejects(feeds.read('https://first.example/feed', {}), /HTTP 403/); assert.equal(calls, 1);
});
test('an approved-host redirect cannot impersonate a different publisher', async () => {
  const feeds = new FeedReader(validateConfig(configValue()), { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://second.example/feed' } }) });
  await assert.rejects(feeds.read('https://first.example/feed', {}), /another publisher/);
});
test('Windows launcher forwards help without opening a model or publishing', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('cmd.exe', ['/d', '/c', 'Pesquisar-Forum.cmd --help'], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.match(result.stdout, /Research Publisher 3/);
});
