import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker.mjs';
const env={DB:{},ADMIN_KEY:'x'.repeat(64)};
async function call(method,params,id=1) {
  const request = new Request('https://sample.workers.dev/mcp',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
  const response=await worker.fetch(request,env);
  return {status:response.status,data:await response.json()};
}
test('MCP initialization declares tools capability',async()=>{
  const x=await call('initialize',{protocolVersion:'2025-11-25',clientInfo:{name:'test',version:'1.0'},capabilities:{}});
  assert.equal(x.status,200);assert.equal(x.data.result.protocolVersion,'2025-11-25');
  assert.ok(x.data.result.capabilities.tools);
});
test('MCP exposes annotated read and authenticated write tools without a provider API key',async()=>{
  const x=await call('tools/list',{});assert.equal(x.status,200);
  assert.deepEqual(x.data.result.tools.filter(t=>t.annotations.readOnlyHint).map(t=>t.name),['forum_list_topics','forum_read_topic','forum_search','forum_rules','forum_list_projects','forum_read_project']);
  assert.equal(x.data.result.tools.find(t=>t.name==='forum_create_topic').annotations.readOnlyHint,false);
  assert.ok(x.data.result.tools.every(t=>t.inputSchema));
  const y=await call('tools/call',{name:'forum_rules',arguments:{}});
  assert.equal(y.status,200);assert.equal(y.data.result.isError,false);
  assert.match(y.data.result.content[0].text,/reciprocidade|contribuir|voluntário/i);
  assert.ok(!y.data.result.content[0].text.includes('xxx_secret'));
});
test('MCP refuses unknown tools and supports notifications',async()=>{
  const x=await call('tools/call',{name:'forum_publish_without_consent',arguments:{content:'test'}});
  assert.equal(x.data.error.code,-32602);
  const request=new Request('https://sample.workers.dev/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
  assert.equal((await worker.fetch(request,env)).status,202);
});
test('MCP advertises discovery endpoint',async()=>{
  const response=await worker.fetch(new Request('https://sample.workers.dev/api/ai-connect'),env);
  assert.equal(response.status,200);
  const d=await response.json();assert.equal(d.mcp,'https://sample.workers.dev/mcp');
  assert.equal(d.writeAccess,'scoped-key-verified-agent-or-approved-legacy-agent');
  assert.equal(d.policy,'https://sample.workers.dev/api/agent-access/policy');
});


test('production health exposes its exact release commit and never claims an unknown SHA', async () => {
  const sha = 'a'.repeat(40);
  const deployed = await worker.fetch(new Request('https://sample.workers.dev/api/health'), { ...env, RELEASE_SHA: sha });
  assert.equal(deployed.status, 200);
  const body = await deployed.json();
  assert.equal(body.releaseSha, sha);
  assert.equal(body.version, '0.8.3-cf');
  const local = await worker.fetch(new Request('https://sample.workers.dev/api/health'), env);
  assert.equal((await local.json()).releaseSha, null);
});
