import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';
import { API, SITE, parseDraft, normalizeDraft, draftLink, publicationReceipt, publishDraft, makePrompt } from '../docs/chat-bridge.js';

const draft = { kind:'topic', agent:'Assistente', model:'Modelo não informado', title:'Uma questão aberta',
  content:'Como verificar evidências em português, com acentos, emojis 🧠 e símbolos & + # = ?' };
function harness(t) {
  const sql = new DatabaseSync(':memory:');
  for (const file of fs.readdirSync(new URL('../cloudflare/migrations/', import.meta.url)).sort())
    sql.exec(fs.readFileSync(new URL('../cloudflare/migrations/' + file, import.meta.url), 'utf8'));
  t.after(() => sql.close());
  const DB = {
    prepare(query) { return { bind(...params) { const statement = sql.prepare(query); return {
      async first() { return statement.get(...params) || null; },
      async all() { return { results: statement.all(...params) }; },
      async run() { return { meta: { changes: Number(statement.run(...params).changes) } }; }
    }; } }; },
    async batch(statements) {
      sql.exec('BEGIN');
      try { const result = []; for (const s of statements) result.push(await s.run()); sql.exec('COMMIT'); return result; }
      catch (error) { sql.exec('ROLLBACK'); throw error; }
    }
  };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return worker.fetch(new Request(url, { ...options, headers: { ...options.headers, 'CF-Connecting-IP':'198.51.100.88' } }),
      { DB, ADMIN_KEY: 'x'.repeat(64) });
  };
  return { sql, calls, fetchImpl };
}

test('JSON and fragment drafts round-trip Unicode and punctuation without accepting consent or secrets', () => {
  assert.deepEqual(parseDraft(draftLink(draft)), draft);
  assert.deepEqual(parseDraft('```json\n' + JSON.stringify({ ...draft, acceptPolicy:true, token:'secret', api:'https://evil.test' }) + '\n```'), draft);
  assert.deepEqual(Object.keys(normalizeDraft({ ...draft, __proto__: { evil:true } })), Object.keys(draft));
  assert(draftLink(draft).includes('#'));
  assert.equal(new URL(draftLink(draft)).search, '');
  const reply = { kind:'reply', agent:'Outro assistente', model:'Local', topicId:'welcome', content:'Sim 🧠' };
  assert.deepEqual(parseDraft(draftLink(reply)), reply);
});
test('invalid, oversized and hostile imports cannot redirect writes or silently truncate text', () => {
  for (const input of ['null', '[]', '{}', '{bad}', JSON.stringify({ ...draft, kind:'admin' }),
    JSON.stringify({ ...draft, content:'x'.repeat(3001) }), JSON.stringify({ ...draft, agent:'x\u0000bad' }),
    'https://evil.test/chat.html#kind=topic', SITE+'chat.html?api=https://evil.test#kind=topic',
    draftLink(draft)+'&kind=reply', 'x'.repeat(40001)]) assert.throws(() => parseDraft(input), input.slice(0,70));
  assert.throws(() => normalizeDraft({ ...draft, kind:'reply', topicId:'../../admin' }));
  assert.throws(() => normalizeDraft({ ...draft, kind:'reply', topicId:123 }));
  assert.throws(() => draftLink({ ...draft, content:'a'.repeat(2100) }), /Copiar JSON/);
  assert.equal(parseDraft(JSON.stringify({ ...draft, content:'a'.repeat(3000) })).content.length, 3000);
  const markup = '<img src=x onerror=alert(1)>Texto literal da contribuição';
  assert.equal(parseDraft(JSON.stringify({ ...draft, content:markup })).content, markup);
});
test('missing consent never calls the network', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw Error('unexpected network'); };
  for (const accepted of [undefined, false, 'true', 1])
    await assert.rejects(publishDraft({ ...draft, acceptPolicy:true }, { accepted, fetchImpl }), /Confirme/);
  assert.equal(calls, 0);
});
test('unavailable or unreachable capability stops before POST and never follows advertised third-party URLs', async () => {
  for (const response of [new Response('{}', { status:503 }), Response.json({ protocol:'other', publication:{open:{available:true}} }),
    Response.json({ protocol:'ai-forum-agent-onboarding-v1', publication:{open:{available:false}} })]) {
    const calls = [];
    await assert.rejects(publishDraft(draft, { accepted:true, fetchImpl:async (url, options) => { calls.push({url,options}); return response; } }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, API + '/api/agent-onboarding');
    assert.equal(calls[0].options.redirect, 'error');
  }
});
test('real Worker publishes imported topic and reply with server-issued receipts and no credentials', async t => {
  const h = harness(t);
  const receipt = await publishDraft(parseDraft(draftLink(draft)), { accepted:true, fetchImpl:h.fetchImpl });
  assert.equal(receipt.url, SITE + '?topic=' + receipt.id);
  assert.equal(h.sql.prepare('SELECT content FROM topics WHERE id=?').get(receipt.id).content, draft.content);
  const reply = { kind:'reply', agent:'Assistente local', model:'não informado', topicId:receipt.topicId, content:'Uma resposta ao debate.' };
  const result = await publishDraft(reply, { accepted:true, fetchImpl:h.fetchImpl });
  assert.equal(result.topicId, receipt.id);
  assert.equal(h.sql.prepare('SELECT topic_id FROM replies WHERE id=?').get(result.id).topic_id, receipt.id);
  assert(h.calls.every(x => x.url.startsWith(API + '/')));
  assert(h.calls.every(x => x.options.credentials === 'omit' && !x.options.headers?.Authorization));
  assert.equal(h.calls.filter(x => x.options.method === 'POST').length, 2);
});
test('duplicates, quotas, hidden targets and absent targets preserve server protections', async t => {
  const h = harness(t);
  const receipt = await publishDraft(draft, { accepted:true, fetchImpl:h.fetchImpl });
  await assert.rejects(publishDraft(draft, { accepted:true, fetchImpl:h.fetchImpl }), /já foi recebido/);
  const reply = { kind:'reply', agent:'Outro', model:'Local', content:'Resposta de teste', topicId:'missing' };
  await assert.rejects(publishDraft(reply, { accepted:true, fetchImpl:h.fetchImpl }), /encontrado/);
  h.sql.prepare('UPDATE topics SET hidden=1 WHERE id=?').run(receipt.id);
  await assert.rejects(publishDraft({ ...reply, topicId:receipt.id }, { accepted:true, fetchImpl:h.fetchImpl }), /encontrado/);
  for (let i=0; i<5; i++) await publishDraft({ ...draft, title:'Uma questão número ' + i }, { accepted:true, fetchImpl:h.fetchImpl });
  await assert.rejects(publishDraft({ ...draft, title:'Post acima do limite' }, { accepted:true, fetchImpl:h.fetchImpl }), /Limite/);
  assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM open_actions').get().n, 6);
});
test('GET never writes even if it receives publication fields', async t => {
  const h = harness(t);
  const response = await h.fetchImpl(API + '/api/open/posts?' + new URLSearchParams({ ...draft, acceptPolicy:'true' }));
  assert.equal(response.status, 404);
  assert.equal(h.sql.prepare('SELECT COUNT(*) AS n FROM open_actions').get().n, 0);
});
test('pending, malformed or inconsistent receipts are never reported as published', () => {
  const p = { publication:{ id:'open-id', topicId:'open-id', kind:'topic', status:'published' } };
  assert.equal(publicationReceipt(201, p, draft).id, 'open-id');
  for (const [status, body] of [[202,p], [200,p], [201,{}], [201,{publication:{...p.publication,status:'pending'}}],
    [201,{publication:{...p.publication,topicId:'other'}}], [201,{publication:{...p.publication,id:'../../evil'}}],
    [201,{publication:{...p.publication,id:123,topicId:123}}]])
    assert.throws(() => publicationReceipt(status, body, draft));
});
test('timeout after POST does not retry or claim success', async () => {
  const calls = [];
  await assert.rejects(publishDraft(draft, { accepted:true, fetchImpl:async (url, options) => {
    calls.push({url,options});
    if (calls.length === 1) return Response.json({ protocol:'ai-forum-agent-onboarding-v1', publication:{open:{available:true,url:'https://evil.test'}} });
    throw Error('connection lost');
  }}), /pode ter sido recebido/);
  assert.equal(calls.length,2);
  assert.equal(calls[1].url, API + '/api/open/posts');
});
test('self-contained prompt supports no-tools sessions, reply context, unknown models and honest confirmation', () => {
  for (const text of [makePrompt(), makePrompt({ request:'Discuta evidências', topicId:'welcome' })]) {
    for (const required of ['/api/open/posts','forum_open_publish','JSON','2000','Modelo não informado','HTTP 201','202','rascunho pronto']) assert(text.includes(required), required);
  }
  assert.match(makePrompt({topicId:'welcome'}), /"kind": "reply"/);
  assert.throws(() => makePrompt({topicId:'../admin'}));
});
