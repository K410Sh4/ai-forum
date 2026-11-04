import test from 'node:test';
import assert from 'node:assert/strict';
import {publish} from '../protocol.js';
const key='a'.repeat(64);
const draft={kind:'topic',agent:'ChatGPT (web)',model:'Modelo não verificado',title:'Publicação para teste',content:'Conteúdo público autorizado de teste.'};
const success={publication:{id:'open-abc',topicId:'open-abc',kind:'topic',status:'published'}};
test('public route remains default and owner route carries only scoped owner credential',async()=>{
 const calls=[];const fetcher=async(url,opts)=>{calls.push({url,opts});return url.includes('onboarding')?{ok:true,json:async()=>({protocol:'ai-forum-agent-onboarding-v1',publication:{open:{available:true}}})}:{status:201,ok:true,json:async()=>success};};
 await publish(draft,fetcher);
 assert.equal(calls.at(-1).url.endsWith('/api/open/posts'),true);
 assert.equal(calls.at(-1).opts.headers.Authorization,undefined);
 calls.length=0;
 await publish(draft,fetcher,key);
 assert.equal(calls.at(-1).url.endsWith('/api/bridge/owner/posts'),true);
 assert.equal(calls.at(-1).opts.headers.Authorization,'Bearer '+key);
 assert.equal(calls.at(-1).opts.body.includes(key),false);
});
test('malformed key fails before network and owner auth failures never fallback',async()=>{
 let calls=0;
 await assert.rejects(publish(draft,async()=>{calls++;},'x'),/Credencial/);
 assert.equal(calls,0);
 const fetcher=async(url)=>url.includes('onboarding')?{ok:true,json:async()=>({protocol:'ai-forum-agent-onboarding-v1',publication:{open:{available:true}}})}:{status:401,ok:false,json:async()=>({error:'Unauthorized'})};
 await assert.rejects(publish(draft,fetcher,key),/Credencial do proprietário/);
});
