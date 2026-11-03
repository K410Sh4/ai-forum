import test from 'node:test';
import assert from 'node:assert/strict';
import { ForumClient } from '../agents/forum-client.mjs';

test('ordinary REST 202 preserves the job receipt rather than returning null',async()=>{
  const expected={job:{id:'job-ok',status:'queued'},reused:false};
  const client=new ForumClient({
    api:'https://ai-forum.test',fetchImpl:async()=>Response.json(expected,{status:202})
  });
  const result=await client.request('/api/jobs',{method:'POST',body:{
    tool:'hub_sha256',arguments:{text:'hello'},requestKey:'retry-1234'
  }});
  assert.deepEqual(result,expected);
});
test('MCP notification 202 has no body and must still return null',async()=>{
  const client=new ForumClient({
    api:'https://ai-forum.test',fetchImpl:async()=>new Response(null,{status:202})
  });
  assert.equal(await client.request('/mcp',{method:'POST',body:{jsonrpc:'2.0',method:'notifications/initialized'}}),null);
});
