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
import { readFeed, chooseArticles, validateCard, payloadHash, publicURL } from '../agents/research-core.mjs';
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
function fixture(t, { depth = 'balanced', invalidModel = false, criticRejects = 0, idempotent = true, loseReceiptAt = -1 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-research-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = NOW, criticCalls = 0, writeCalls = 0;
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
    if (properties.angle) { stage = 'plan'; value = { kind: 'roundup', angle: 'Comparar limites e aplicações dos estudos relatados', sourceIds: ['S1', 'S2'] }; }
    else if (properties.facts) { stage = 'card'; value = { summary: 'O relatório descreve uma comparação controlada com alcance limitado ao cenário avaliado.', facts: [{ statement: 'O relatório apresenta uma comparação de comportamento em condições determinadas.', quote: excerpt.slice(0, 87) }], limitations: 'O resumo não estabelece generalização para outros cenários.' }; }
    else if (properties.findings) {
      stage = 'draft'; value = { title: 'Comparações controladas e limites dos modelos locais', overview: 'Os relatos apresentam comparações em condições determinadas e destacam limites de generalização. O panorama compara o alcance das evidências disponíveis e propõe perguntas para avaliações adicionais.', findings: [{ text: 'O primeiro relatório descreve uma comparação em condições determinadas.', sourceIds: ['S1'] }, { text: 'O segundo relato também limita o alcance das conclusões ao cenário avaliado.', sourceIds: ['S2'] }], sourceIds: ['S1', 'S2'], uncertainties: 'Os resumos não permitem verificar a transferência dos resultados para outros ambientes.', perspectives: [{ label: 'Aplicações', argument: 'Comparações controladas podem orientar a escolha de novos experimentos.', caveat: 'Isso não demonstra desempenho geral.' }, { label: 'Limitações', argument: 'É preciso examinar os métodos antes de aplicar as conclusões a outros contextos.', caveat: 'Os resumos oferecem contexto limitado.' }], questions: ['Como testar a generalização?', 'Quais variáveis precisam ser controladas?'] };
    } else if (properties.heading) {
      stage = 'section'; value = { heading: input.focus, paragraphs: [{ text: 'O primeiro relato descreve uma comparação sob condições determinadas. Essa descrição permite formular questões metodológicas, mas não confirma aplicação em cenários diferentes.', sourceIds: ['S1'] }, { text: 'O segundo relato também apresenta limites de alcance. Uma proposta de trabalho seria comparar os cenários, sem presumir que os dois estudos confirmam um mesmo resultado.', sourceIds: ['S2'] }], limitations: 'As descrições disponíveis não substituem a leitura dos métodos completos.' };
    } else {
      stage = 'review'; const reject = criticCalls++ < criticRejects;
      value = { approved: !reject, issues: reject ? ['Explique melhor o alcance das evidências apresentadas.'] : [], note: 'Revisão interna baseada apenas nas evidências fornecidas.' };
    }
    calls.push({ stage, input });
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
test('preview completes plan, extraction, writing and review without public writes', async t => {
  const f = fixture(t); const result = await f.engine.generate();
  assert.equal(result.status, 'draft'); assert.equal(f.topics.length, 0); assert.equal(f.writeCalls, 0);
  assert.deepEqual(f.calls.map(c => c.stage), ['plan', 'card', 'card', 'draft', 'review']);
  const draft = readJSON(result.file);
  assert.equal(draft.hash, payloadHash(draft)); assert.match(draft.post.content, /Pesquisa [a-f0-9]{24}/);
  assert.equal(fs.existsSync(result.markdown), true);
});
test('publication sends the exact reviewed draft; changed drafts are blocked', async t => {
  const f = fixture(t); const preview = await f.engine.generate(); const reviewed = readJSON(preview.file);
  const result = await f.engine.publish(preview.file, preview.hash);
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
  await f.engine.publish(preview.file, preview.hash);
  assert.equal(f.topics.length, 1); assert.equal(f.replies.length, 2); assert.deepEqual(f.waits, [21000, 21000]);
  assert.equal(f.store.read().messages.length, 3); assert.equal(f.store.read().pending, null);
});
test('lost topic receipt is retried with the same key and does not create a duplicate', async t => {
  const f = fixture(t, { loseReceiptAt: 1 }); const preview = await f.engine.generate();
  await assert.rejects(f.engine.publish(preview.file, preview.hash), /Connection lost/);
  assert.equal(f.store.read().pending.messages[0].status, 'sending'); assert.equal(f.topics.length, 1);
  await f.engine.publish(preview.file, preview.hash);
  assert.equal(f.topics.length, 1); assert.equal(f.store.read().published.length, 1); assert.equal(f.store.read().pending, null);
});
test('older Workers block ambiguous retries and reconcile from a public receipt', async t => {
  const f = fixture(t, { loseReceiptAt: 1, idempotent: false }); const preview = await f.engine.generate();
  await assert.rejects(f.engine.publish(preview.file, preview.hash), /Connection lost/);
  await assert.rejects(f.engine.publish(preview.file, preview.hash), /uncertain/);
  assert.equal(f.writeCalls, 1);
  const result = await f.engine.reconcile(); assert.equal(result.status, 'reconciled'); assert.equal(f.store.read().published.length, 1);
});
test('reconciliation resumes only missing deep replies after a lost receipt', async t => {
  const f = fixture(t, { depth: 'deep', loseReceiptAt: 2 }); const preview = await f.engine.generate();
  await assert.rejects(f.engine.publish(preview.file, preview.hash), /Connection lost/);
  assert.equal(f.topics.length, 1); assert.equal(f.replies.length, 1);
  assert.equal((await f.engine.reconcile()).status, 'partial');
  await f.engine.publish(preview.file, preview.hash);
  assert.equal(f.topics.length, 1); assert.equal(f.replies.length, 2); assert.equal(f.store.read().messages.length, 3);
});
test('cancellation preserves uncertain delivery history and permanently blocks resending that draft', async t => {
  const f = fixture(t, { loseReceiptAt: 1 }); const preview = await f.engine.generate();
  await assert.rejects(f.engine.publish(preview.file, preview.hash), /Connection lost/);
  const result = await f.engine.cancel(preview.file, preview.hash);
  assert.equal(result.status, 'cancelled'); assert.equal(f.store.read().pending, null); assert.equal(f.store.read().published[0].status, 'cancelled');
  await assert.rejects(f.engine.publish(preview.file, preview.hash), /cancelled/); assert.equal(f.topics.length, 1); assert.equal(f.writeCalls, 1);
});
test('editorial rejection gets one revision, then fails closed', async t => {
  const f = fixture(t, { criticRejects: 10 });
  await assert.rejects(f.engine.generate(), /Editorial review rejected/);
  assert.equal(f.calls.filter(c => c.stage === 'draft').length, 2); assert.equal(f.topics.length, 0);
  assert.equal(f.store.read().runs.at(-1).status, 'failed');
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
  await assert.rejects(f.engine.publish(preview.file, preview.hash), /policy\/API mismatch/); assert.equal(f.writeCalls, 0);
});
test('daily limits apply before generation and theme cooldown blocks a second publication', async t => {
  const f = fixture(t); const preview = await f.engine.generate(); await f.engine.publish(preview.file, preview.hash);
  const state = f.store.read(); state.published.push({ id: 'other', at: NOW, title: 'Other report' }); f.store.save(state);
  await assert.rejects(f.engine.generate({ auto: true }), /Daily topic limit/);
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
  assert.equal(result.status, 1); assert.match(result.stderr, /plan:/); assert.equal(fs.existsSync(path.join(f.directory, 'cli-drafts')), false);
});
test('feed access denial is reported without retrying a different path or client', async () => {
  let calls = 0;
  const feeds = new FeedReader(validateConfig(configValue()), { fetchImpl: async () => { calls++; return new Response('', { status: 403 }); } });
  await assert.rejects(feeds.read('https://first.example/feed', {}), /HTTP 403/); assert.equal(calls, 1);
});
test('Windows launcher forwards help without opening a model or publishing', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('cmd.exe', ['/d', '/c', 'Pesquisar-Forum.cmd --help'], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.match(result.stdout, /Research Publisher 2/);
});
