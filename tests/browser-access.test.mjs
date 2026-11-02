import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sqliteD1 } from './support/sqlite-d1.mjs';
import worker from '../cloudflare/worker.mjs';
import { BrowserAccess } from '../docs/browser-access.js';
import { readRoute, topicUrl } from '../docs/navigation.js';

const API = 'https://forum.test';
const PROFILE = { name: 'Browser Agent', model: 'browser-agent', owner: 'Test Operator' };
class MemoryStorage {
  data = new Map();
  async get(api) { return this.data.get(api) || null; }
  async put(api, identity) { this.data.set(api, structuredClone(identity)); }
}
function harness(t, transform) {
  const sql = new DatabaseSync(':memory:');
  for (const file of fs.readdirSync(new URL('../cloudflare/migrations/', import.meta.url)).sort()) sql.exec(fs.readFileSync(new URL('../cloudflare/migrations/' + file, import.meta.url), 'utf8'));
  const DB = sqliteD1(sql);
  const env = { DB, ADMIN_KEY: 'a'.repeat(64) }, calls = [];
  t.after(() => sql.close());
  const fetchImpl = async (url, options) => {
    const req = new Request(url, options);
    calls.push(new URL(req.url).pathname);
    const result = await worker.fetch(req, env);
    return transform ? transform(req, result) : result;
  };
  return { sql, calls, fetchImpl, storage: new MemoryStorage() };
}
const makeClient = (h, storage = h.storage) => new BrowserAccess(API, { fetchImpl: h.fetchImpl, storage, cryptoImpl: webcrypto });

test('browser: real Web Crypto proof publishes with a scoped session and revokes on logout', async t => {
  const h = harness(t), client = makeClient(h);
  const session = await client.login(PROFILE, { acceptedPolicy: '2026-11-01' });
  assert.equal(session.agent.verification, 'key-possession');
  assert.equal(session.agent.providerIdentityVerified, false);
  assert.equal(h.storage.data.size, 0, 'Identity persistence must be opt-in');
  await assert.rejects(webcrypto.subtle.exportKey('jwk', client.identity.privateKey));
  const published = await client.request('/api/topics', { method: 'POST', token: await client.token(), body: { title: 'Browser access integration', content: 'A public test message in an isolated database.' } });
  assert.ok(published.topic.id);
  assert.equal((await client.request('/api/topics/' + published.topic.id)).topic.content, 'A public test message in an isolated database.');
  await assert.rejects(client.request('/api/projects/proposals', { method: 'POST', token: await client.token(), body: {} }), error => error.status === 403);
  const token = session.token;
  await client.logout();
  await assert.rejects(client.request('/api/me', { token }), error => error.status === 401);
  await assert.rejects(client.token(), /Entre com o perfil/);
});
test('browser: explicit policy acceptance is required before creating or storing a key', async t => {
  const h = harness(t), client = makeClient(h);
  await assert.rejects(client.login(PROFILE, { remember: true }), /Aceite explicitamente/);
  assert.equal(client.identity, null);
  assert.equal(h.storage.data.size, 0);
  assert.deepEqual(h.calls, ['/api/agent-access/policy']);
});
test('browser: optional storage preserves a non-extractable key and profile, never a token', async t => {
  const h = harness(t), first = makeClient(h);
  const a = await first.login(PROFILE, { acceptedPolicy: '2026-11-01', remember: true });
  const record = h.storage.data.get(API);
  assert.deepEqual(Object.keys(record).sort(), ['privateKey', 'profile', 'publicKeyJwk']);
  assert.equal(record.privateKey.extractable, false);
  assert.equal(JSON.stringify(record).includes(a.token), false);
  const second = makeClient(h);
  assert.deepEqual(await second.savedProfile(), PROFILE);
  const b = await second.login(PROFILE, { acceptedPolicy: '2026-11-01', remember: true });
  assert.equal(a.agent.id, b.agent.id);
  assert.notEqual(a.token, b.token);
  await assert.rejects(second.login({ ...PROFILE, name: 'Another Agent' }, { acceptedPolicy: '2026-11-01' }), /perfil de chave/);
  const other = new BrowserAccess('https://other.test', { storage: h.storage });
  assert.equal(await other.savedProfile(), null);
});
test('browser: renewal shares one proof across concurrent callers and never crosses origins', async t => {
  const h = harness(t), client = makeClient(h);
  const first = await client.login(PROFILE, { acceptedPolicy: '2026-11-01' });
  const before = h.calls.filter(p => p === '/api/agent-auth/token').length;
  const [a, b] = await Promise.all([client.token(true), client.token(true)]);
  assert.equal(a, b);
  assert.notEqual(a, first.token);
  assert.equal(h.calls.filter(p => p === '/api/agent-auth/token').length, before + 1);
  await assert.rejects(client.request('https://other.test/api/me', { token: a }), /outra origem/);
});
test('browser: mismatched challenge audience is rejected before signing or token exchange', async t => {
  const h = harness(t, async (req, response) => {
    if (!req.url.endsWith('/api/agent-auth/challenge')) return response;
    const value = await response.json(), claims = JSON.parse(value.challenge);
    claims.audience = 'https://other.test';
    value.challenge = JSON.stringify(claims);
    return Response.json(value, { status: response.status });
  });
  await assert.rejects(makeClient(h).login(PROFILE, { acceptedPolicy: '2026-11-01' }), /não corresponde/);
  assert.equal(h.calls.includes('/api/agent-auth/token'), false);
});
test('permanent topic URLs preserve the project path and validate route identifiers', () => {
  const url = topicUrl('https://example.test/ai-forum/?view=connect#old', 'welcome');
  assert.equal(url.href, 'https://example.test/ai-forum/?topic=welcome');
  assert.deepEqual(readRoute(url.href), { view: 'topic', topic: 'welcome' });
  assert.deepEqual(readRoute('https://example.test/ai-forum/?view=connect'), { view: 'connect', topic: null });
  assert.deepEqual(readRoute('https://example.test/ai-forum/?topic=../admin&view=unknown'), { view: 'forum', topic: null });
  assert.throws(() => topicUrl(url, '../admin'), /inválido/);
});
