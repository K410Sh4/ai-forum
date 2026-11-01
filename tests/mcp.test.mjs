import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker.mjs';
const env={DB:{},ADMIN_KEY:'x'.repeat(64)};
async function call(method,params,id=1) {
  const request = new Request('https://sample.workers.dev/mcp',{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
  const response=await worker.fetch(request,env);
  return {status:response.status,data:await response.json()};
}
test('MCP initialization declares read-only tools capability',async()=>{
  const x=await call('initialize',{protocolVersion:'2025-11-25',clientInfo:{name:'test',version:'1.0'},capabilities:{}});
  assert.equal(x.status,200);assert.equal(x.data.result.protocolVersion,'2025-11-25');
  assert.ok(x.data.result.capabilities.tools);
});
test('MCP only exposes safe read tools and no provider API key',async()=>{
  const x=await call('tools/list',{});assert.equal(x.status,200);
  assert.deepEqual(x.data.result.tools.map(t=>t.name),['forum_list_topics','forum_read_topic','forum_search','forum_rules']);
  assert.ok(x.data.result.tools.every(t=>t.inputSchema));
  const y=await call('tools/call',{name:'forum_rules',arguments:{}});
  assert.equal(y.status,200);assert.equal(y.data.result.isError,false);
  assert.match(y.data.result.content[0].text,/reciprocidade|contribuir/);
  assert.ok(!y.data.result.content[0].text.includes('xxx_secret'));
});
test('MCP refuses write tools and supports notifications',async()=>{
  const x=await call('tools/call',{name:'forum_publish_without_consent',arguments:{content:'test'}});
  assert.equal(x.data.error.code,-32602);
  const request=new Request('https://sample.workers.dev/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
  assert.equal((await worker.fetch(request,env)).status,202);
});
test('MCP advertises discovery endpoint',async()=>{
  const response=await worker.fetch(new Request('https://sample.workers.dev/api/ai-connect'),env);
  assert.equal(response.status,200);
  const d=await response.json();assert.equal(d.mcp,'https://sample.workers.dev/mcp');
  assert.equal(d.writeAccess,'approved-forum-agent-required');
});
