import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createToolHub, executeHubTool, hubCatalog, HUB_TOOLS } from '../cloudflare/tool-hub.mjs';
import { createMcp } from '../cloudflare/mcp.mjs';
import worker from '../cloudflare/worker.mjs';

const ORIGIN = 'https://ai-forum.test';
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
const readBody = async req => JSON.parse(await req.text());
function fixtures() {
  const calls = [];
  const route = async req => {
    calls.push({ method: req.method, path: new URL(req.url).pathname, authorization: req.headers.get('authorization') });
    const u = new URL(req.url);
    if (u.pathname === '/api/topics') return json({
      topics: Array.from({ length: 30 }, (_, i) => ({ id: 'topic-' + i, title: 'Title ' + i, content: 'Public content ' + i,
        authorName: 'Test Agent', replyCount: i, createdAt: '2026-11-01' }))
    });
    if (u.pathname === '/api/topics/welcome') return json({ topic: { id: 'welcome', title: 'Welcome',
      content: 'Public body', createdAt: '2026-11-01', authorName: 'Forum',
      replies: Array.from({ length: 40 }, (_, i) => ({ id: 'reply-' + i, content: 'Hello ' + i })) } });
    if (u.pathname === '/api/search') return json({ results: [
      { type: 'topic', id: 'welcome', title: 'Welcome' },
      { type: 'reply', id: 'private-reply-dropped', title: 'Not a topic' }
    ] });
    return json({ error: 'not found' }, 404);
  };
  const run = (name, args, env, request) => executeHubTool(name, args, { route, env, request });
  const hub = createToolHub({ readBody, json, runTool: run });
  const mcp = createMcp({ readBody, json, route, accessPolicy: () => ({}), runHubTool: run });
  const request = (path, payload, method = 'POST', type = 'application/json') =>
    new Request(ORIGIN + path, { method, headers: { 'Content-Type': type, Authorization: 'Bearer secret-never-forward' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  return { calls, route, run, hub, mcp, request };
}
test('catalog exposes only allowlisted, read-only tools with closed schemas', () => {
  const catalog = hubCatalog(ORIGIN);
  assert.equal(catalog.tools.length, 5);
  assert.equal(HUB_TOOLS.length, 5);
  assert.ok(catalog.tools.every(tool => tool.readOnly && !tool.requiresAuthentication && tool.inputSchema.additionalProperties === false));
  assert.equal(catalog.execute, ORIGIN + '/api/tools/execute');
});
test('REST tool executor runs server-side without forwarding caller credentials', async () => {
  const f = fixtures();
  const catalog = await f.hub(f.request('/api/tools', undefined, 'GET'), {}, new URL(ORIGIN + '/api/tools'));
  assert.equal(catalog.status, 200);
  const post = f.request('/api/tools/execute', { name: 'hub_list_topics', arguments: { limit: 2 } });
  const response = await f.hub(post, {}, new URL(post.url));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.execution, 'server');
  assert.equal(body.result.topics.length, 2);
  assert.equal(f.calls[0].method, 'GET');
  assert.equal(f.calls[0].authorization, null);
  assert.equal(body.result.topics[0].excerpt, 'Public content 0');
});
test('topic read bounds replies; search returns only visible topic matches', async () => {
  const f = fixtures();
  const read = await f.run('hub_read_topic', { topic_id: 'welcome' }, {}, f.request('/api/tools'));
  assert.equal(read.replies.length, 25);
  const search = await f.run('hub_search_topics', { query: 'welcome', limit: 2 }, {}, f.request('/api/tools'));
  assert.equal(search.topics.length, 1);
  assert.equal(search.topics[0].id, 'welcome');
});
test('text processing matches Node digest and Unicode semantics', async () => {
  const f = fixtures();
  const body = 'Olá mundo\n🦊!';
  const stats = await f.run('hub_text_statistics', { text: body }, {}, f.request('/api/tools'));
  assert.equal(stats.characters, Array.from(body).length);
  assert.equal(stats.utf8Bytes, Buffer.byteLength(body));
  assert.equal(stats.lines, 2);
  const hash = await f.run('hub_sha256', { text: body }, {}, f.request('/api/tools'));
  assert.equal(hash.hex, createHash('sha256').update(body).digest('hex'));
  assert.equal(f.calls.length, 0);
});
test('bad tool names, schema extras, oversized inputs and malformed IDs fail closed', async () => {
  const f = fixtures();
  for (const [name, args] of [
    ['hub_execute_shell', { command: 'whoami' }],
    ['hub_text_statistics', { text: '' }],
    ['hub_text_statistics', { text: 'a'.repeat(2049) }],
    ['hub_text_statistics', { text: 'ok', arbitrary: true }],
    ['hub_list_topics', { limit: 300 }],
    ['hub_read_topic', { topic_id: '../admin' }],
    ['hub_read_topic', { topic_id: 'welcome', extra: true }],
    ['hub_search_topics', { query: 'x' }]
  ]) await assert.rejects(() => f.run(name, args, {}, f.request('/api/tools')),
    error => [400, 404].includes(error.status));
  assert.equal(f.calls.length, 0);
});
test('REST execute accepts POST JSON only and requires arguments key', async () => {
  const f = fixtures();
  const get = f.request('/api/tools/execute', undefined, 'GET');
  assert.equal((await f.hub(get, {}, new URL(get.url))).status, 405);
  const invalidType = f.request('/api/tools/execute', { name:'hub_list_topics', arguments:{} }, 'POST', 'text/plain');
  assert.equal((await f.hub(invalidType, {}, new URL(invalidType.url))).status, 415);
  const noArgs = f.request('/api/tools/execute', { name: 'hub_list_topics' });
  await assert.rejects(() => f.hub(noArgs, {}, new URL(noArgs.url)), e => e.status === 400);
});
test('MCP discovery and execution use the same registry', async () => {
  const f = fixtures();
  const rpc = async payload => {
    const req = f.request('/mcp', payload);
    const response = await f.mcp(req, {});
    assert.equal(response.status, 200);
    return response.json();
  };
  const list = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.ok(list.result.tools.some(t => t.name === 'hub_sha256' && t.annotations.readOnlyHint));
  const execution = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'hub_text_statistics', arguments: { text: 'two words' } } });
  assert.equal(execution.result.isError, false);
  assert.equal(JSON.parse(execution.result.content[0].text).result.words, 2);
  const blocked = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'hub_text_statistics', arguments: { text: 'ok', command: 'rm' } } });
  assert.equal(blocked.error.code, -32602);
});

test('Cloudflare Worker exposes the real read-only REST routes and Page origin CORS', async () => {
  const env = { DB: {}, ADMIN_KEY: 'a'.repeat(64) };
  const headers = { Origin: 'https://k410sh4.github.io' };
  const catalog = await worker.fetch(new Request(ORIGIN + '/api/tools', { headers }), env);
  assert.equal(catalog.status, 200);
  assert.equal(catalog.headers.get('access-control-allow-origin'), headers.Origin);
  assert.equal((await catalog.json()).tools.length, 5);
  const execute = await worker.fetch(new Request(ORIGIN + '/api/tools/execute', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'hub_text_statistics', arguments: { text: 'hello world' } })
  }), env);
  assert.equal(execute.status, 200);
  assert.equal((await execute.json()).result.words, 2);
  const invalid = await worker.fetch(new Request(ORIGIN + '/api/tools/execute', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'hub_execute_shell', arguments: {} })
  }), env);
  assert.equal(invalid.status, 404);
});
