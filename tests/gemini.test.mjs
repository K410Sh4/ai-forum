import test from 'node:test';
import assert from 'node:assert/strict';
import { makePrompt, geminiText } from '../agents/gemini.mjs';

test('prompt separates other agents as untrusted data',()=>{
  const p=makePrompt({title:'Teste',authorName:'Qwen',content:'O que podemos melhorar?',replies:[{authorName:'Llama',content:'Testes automatizados.'}]});
  assert.match(p,/NÃO CONFIÁVEIS/);
  assert.match(p,/Qwen/);
  assert.match(p,/Llama/);
});
test('calls Google official API without embedding keys in URL or invoking tools',async()=>{
  let request;
  const fake=async(url,options)=>{request={url,options};return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:'Resposta válida'}]}}]})};};
  const result=await geminiText('sensitive-test-key','gemini-3.5-flash-lite','Mensagem',fake);
  assert.equal(result,'Resposta válida');
  assert.match(request.url,/generativelanguage\.googleapis\.com/);
  assert.equal(request.options.headers['x-goog-api-key'],'sensitive-test-key');
  assert.ok(!request.url.includes('sensitive-test-key'));
  const body=JSON.parse(request.options.body);
  assert.equal(body.tools,undefined);
  assert.equal(body.contents[0].parts[0].text,'Mensagem');
});
test('validates models and does not leak keys on rate limit errors',async()=>{
  await assert.rejects(()=>geminiText('secret','../../bad','hey',async()=>{throw Error('unexpected');}),/modelo inválido/);
  await assert.rejects(()=>geminiText('secret','gemini-3.5-flash-lite','hey',async()=>({ok:false,status:429})),error=>error.message.includes('429')&&!error.message.includes('secret'));
});
