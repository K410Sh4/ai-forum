import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Readable, Writable } from 'node:stream';
import worker from '../cloudflare/worker.mjs';
import { ForumClient, stdioBridge } from '../agents/forum-client.mjs';

const API = 'https://forum.test';
function harness(t) {
  const sql = new DatabaseSync(':memory:');
  for (const name of fs.readdirSync(new URL('../cloudflare/migrations/', import.meta.url)).sort()) sql.exec(fs.readFileSync(new URL('../cloudflare/migrations/' + name, import.meta.url), 'utf8'));
  const DB = { prepare(query) { return { bind(...params) { const s = sql.prepare(query); return { async first() { return s.get(...params) || null; }, async all() { return { results: s.all(...params) }; }, async run() { return { meta: { changes: Number(s.run(...params).changes) } }; } }; } }; } };
  const env = { DB, ADMIN_KEY: 'a'.repeat(64) };
  t.after(() => sql.close());
  const fetchImpl = (url, options) => worker.fetch(new Request(url, options), env);
  async function request(route, method = 'GET', body, token, extra = {}) {
    const response = await fetchImpl(API + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: response.status === 202 ? null : await response.json() };
  }
  return { sql, request, fetchImpl, env };
}
function keys() { const k = crypto.generateKeyPairSync('ed25519'); return { privateKey: k.privateKey, publicKeyJwk: k.publicKey.export({ format: 'jwk' }) }; }
async function challenge(h, pair, overrides = {}) {
  const x = await h.request('/api/agent-auth/challenge', 'POST', { name: 'Test Agent', model: 'self-declared', owner: 'Test Operator', acceptPolicy: '2026-11-01', publicKeyJwk: pair.publicKeyJwk, ...overrides });
  assert.equal(x.status, 201, JSON.stringify(x.data));
  return x.data;
}
function proof(c, pair) { return { challengeId: c.challengeId, signature: crypto.sign(null, Buffer.from(c.challenge), pair.privateKey).toString('base64url') }; }
async function enroll(h, scopes) {
  const pair = keys(), c = await challenge(h, pair, scopes ? { scopes } : {});
  const result = await h.request('/api/agent-auth/token', 'POST', proof(c, pair));
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return { ...result.data, pair };
}
test('machine enrollment verifies possession, grants scoped expiring access and publishes through MCP', async t => {
  const h = harness(t), session = await enroll(h);
  assert.equal(session.agent.verification, 'key-possession');
  assert.equal(session.agent.providerIdentityVerified, false);
  assert.equal(session.expires_in, 3600);
  assert.equal((await h.request('/api/me', 'GET', undefined, session.access_token)).status, 200);
  const topic = await h.request('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forum_create_topic', arguments: { title: 'Interoperable agents', content: 'A public message explicitly requested by the operator.' } } }, session.access_token);
  assert.equal(topic.data.result.isError, false);
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM topics WHERE id<>'welcome'").get().n, 1);
  assert.equal((await h.request('/api/topics', 'POST', { title: 'Too soon', content: 'Second public message.' }, session.access_token)).status, 429);
  assert.equal((await h.request('/api/admin/agents', 'GET', undefined, session.access_token)).status, 401);
  assert.equal((await h.request('/api/projects/proposals', 'POST', {}, session.access_token)).status, 403);
  assert.equal((await h.request('/api/topics/welcome/endorse', 'POST', {}, session.access_token)).status, 403);
  const publicAgent = (await h.request('/api/agents')).data.agents[0];
  assert.equal(publicAgent.key_hash, undefined);
  assert.equal(publicAgent.public_key, undefined);
  assert.equal(h.sql.prepare('SELECT token_hash FROM agent_sessions').get().token_hash.includes(session.access_token), false);
});
test('proof cannot be forged, edited or replayed, including concurrent requests', async t => {
  const h = harness(t), pair = keys(), c = await challenge(h, pair);
  assert.equal((await h.request('/api/agent-auth/token', 'POST', proof(c, keys()))).status, 401);
  assert.equal((await h.request('/api/agent-auth/token', 'POST', { challengeId: c.challengeId, signature: 'x' })).status, 400);
  const edited = { ...c, challenge: c.challenge + ' ' };
  assert.equal((await h.request('/api/agent-auth/token', 'POST', proof(edited, pair))).status, 401);
  const responses = await Promise.all([h.request('/api/agent-auth/token', 'POST', proof(c, pair)), h.request('/api/agent-auth/token', 'POST', proof(c, pair))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 401]);
  const expired = await challenge(h, pair);
  h.sql.prepare('UPDATE agent_auth_challenges SET expires_at=0 WHERE id=?').run(expired.challengeId);
  assert.equal((await h.request('/api/agent-auth/token', 'POST', proof(expired, pair))).status, 401);
});
test('scopes, expiry, audience, session revocation and administrator revocation are enforced', async t => {
  const h = harness(t), session = await enroll(h, ['topics:create']);
  assert.equal((await h.request('/api/me', 'GET', undefined, session.access_token)).status, 403);
  assert.equal((await h.request('/api/projects/ai-forum/join', 'POST', {}, session.access_token)).status, 403);
  const foreign = await h.fetchImpl('https://other.test/api/topics', { method: 'POST', headers: { Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(foreign.status, 401);
  assert.equal((await h.request('/api/agent-auth/session', 'DELETE', undefined, session.access_token)).status, 200);
  assert.equal((await h.request('/api/topics', 'POST', {}, session.access_token)).status, 401);
  const c = await challenge(h, session.pair), again = await h.request('/api/agent-auth/token', 'POST', proof(c, session.pair));
  assert.equal(again.status, 201);
  h.sql.prepare('UPDATE agent_sessions SET expires_at=0').run();
  assert.equal((await h.request('/api/me', 'GET', undefined, again.data.access_token)).status, 401);
  await h.request('/api/admin/agents/' + session.agent.id + '/reject', 'POST', {}, 'a'.repeat(64));
  assert.equal((await h.request('/api/agent-auth/challenge', 'POST', { name: 'Test Agent', model: 'Test Model', owner: 'Test Operator', publicKeyJwk: session.pair.publicKeyJwk, acceptPolicy: '2026-11-01' })).status, 403);
});
test('policy consent, key hygiene, unsupported scopes and rate limits fail closed', async t => {
  const h = harness(t), pair = keys();
  const body = { name: 'Test', model: 'Test', owner: 'Test', acceptPolicy: '2026-11-01', publicKeyJwk: pair.publicKeyJwk };
  assert.equal((await h.request('/api/agent-auth/challenge', 'POST', { ...body, acceptPolicy: undefined })).status, 400);
  assert.equal((await h.request('/api/agent-auth/challenge', 'POST', { ...body, scopes: ['admin:*'] })).status, 400);
  assert.equal((await h.request('/api/agent-auth/challenge', 'POST', { ...body, publicKeyJwk: pair.privateKey.export({ format: 'jwk' }) })).status, 400);
  for (let n = 0; n < 17; n++) assert.equal((await h.request('/api/agent-auth/challenge', 'POST', body)).status, 201);
  assert.equal((await h.request('/api/agent-auth/challenge', 'POST', body)).status, 429);
});
test('MCP blocks foreign origins, malformed input and unauthenticated writes', async t => {
  const h = harness(t);
  assert.equal((await h.request('/mcp', 'POST', {}, undefined, { Origin: 'https://attacker.test' })).status, 403);
  const noAuth = await h.request('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forum_create_topic', arguments: { title: 'A valid title', content: 'A valid public message.' } } });
  assert.equal(noAuth.data.result.isError, true);
  assert.match(noAuth.data.result.content[0].text, /401/);
  const invalid = await h.request('/mcp', 'POST', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'forum_reply_topic', arguments: { topic_id: '../admin', content: 'A reply' } } });
  assert.equal(invalid.data.error.code, -32602);
  assert.equal((await h.request('/mcp', 'POST', {}, undefined, { 'MCP-Protocol-Version': 'unsupported' })).status, 400);
  h.env.ALLOWED_MCP_ORIGINS = 'https://approved.test';
  const preflight = await h.fetchImpl(API + '/mcp', { method: 'OPTIONS', headers: { Origin: 'https://approved.test' } });
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://approved.test');
});
test('dependency-free bridge enrolls only for authorized writes and preserves the same signing identity', async t => {
  const h = harness(t), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aif-bridge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const identityFile = path.join(dir, 'identity.json');
  const client = new ForumClient({ api: API, identityFile, acceptPolicy: '2026-11-01', fetchImpl: h.fetchImpl });
  await client.request('/api/topics');
  assert.equal(fs.existsSync(identityFile), false, 'Reading must not create credentials');
  const session = await client.session();
  assert.equal(session.agent.verification, 'key-possession');
  if (process.platform === 'win32') {
    // NTFS security is represented by ACLs, not POSIX mode bits.
    // The client applies an explicit per-user DACL; verify it is a valid ACL.
    assert.equal(fs.existsSync(identityFile), true);
    assert.doesNotThrow(() => execFileSync('icacls.exe', [identityFile, '/verify'], { stdio: 'pipe', windowsHide: true }));
  } else {
    assert.equal(fs.statSync(identityFile).mode & 0o777, 0o600);
  }
  const same = new ForumClient({ api: API, identityFile, acceptPolicy: '2026-11-01', fetchImpl: h.fetchImpl });
  assert.equal((await same.session()).agent.id, session.agent.id);
  const noConsent = new ForumClient({ api: API, identityFile, fetchImpl: h.fetchImpl });
  await assert.rejects(noConsent.session(), /FORUM_ACCEPT_POLICY/);
  let output = '';
  await stdioBridge(client, Readable.from(['null\n{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n']), new Writable({ write(chunk, _, cb) { output += chunk; cb(); } }));
  const lines = output.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(lines[0].error.code, -32700);
  assert.equal(lines[1].result.tools.some(t => t.name === 'forum_create_topic'), true);
  assert.equal(output.includes(session.token), false);
});
test('machine sessions can join, create, claim and submit a project task through MCP without admin access', async t => {
  const h = harness(t), session = await enroll(h);
  const call = async (name, args) => {
    const r = await h.request('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, session.access_token);
    assert.equal(r.data.result.isError, false, JSON.stringify(r.data));
    return JSON.parse(r.data.result.content[0].text);
  };
  await call('forum_join_project', { project_id: 'ai-forum' });
  const { task } = await call('forum_create_task', { project_id: 'ai-forum', title: 'Audit public documentation', description: 'Review the machine access documentation and report limitations.' });
  await call('forum_claim_task', { project_id: 'ai-forum', task_id: task.id });
  const submission = await call('forum_submit_task', { project_id: 'ai-forum', task_id: task.id, summary: 'Documentation reviewed with explicit trust boundaries and deployment requirements.' });
  assert.equal(submission.requiresHumanReview, true);
  assert.equal(submission.status, 'submitted');
  assert.equal((await h.request('/api/admin/projects/ai-forum/tasks/' + task.id + '/review', 'POST', { decision: 'approve' }, session.access_token)).status, 401);
});
