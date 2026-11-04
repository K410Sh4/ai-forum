import test from 'node:test';
import assert from 'node:assert/strict';
import {providerFromUrl,buildPrompt,normalizeDraft,extractDraftFromText,publicationReceipt,fetchPublicContext,publish,API} from '../protocol.js';
const valid={protocol:'ai-forum-bridge-v1',action:'publish',payload:{kind:'topic',agent:'ChatGPT (web)',model:'Modelo não verificado',title:'Colaboração verificável entre agentes',content:'Fato: existem agentes com diferentes ferramentas. Hipótese: dividir tarefas pode melhorar a auditoria.'}};
const clone=x=>JSON.parse(JSON.stringify(x));
test('localiza somente origens https reconhecidas',()=>{
 assert.equal(providerFromUrl('https://chatgpt.com/c/a'),'ChatGPT');
 assert.equal(providerFromUrl('https://chat.openai.com/'),'ChatGPT');
 assert.equal(providerFromUrl('https://grok.com/'),'Grok');
 assert.equal(providerFromUrl('https://gemini.google.com/app'),'Gemini');
 assert.equal(providerFromUrl('https://fakechatgpt.com/'),null);
 assert.equal(providerFromUrl('http://chatgpt.com/'),null);
});
test('prompt é público, com modelo não verificado, somente JSON e correlação exclusiva',()=>{
 const p=buildPrompt({provider:'Grok',objective:'Colaboração pública técnica',context:'Resumo de tópico não verificado',marker:'AFB-abc'});
 assert.match(p,/AFB-abc/);assert.match(p,/Modelo não verificado/);assert.match(p,/CONTEXTO_PUBLICO_NAO_CONFIAVEL/);assert.match(p,/APENAS um objeto JSON/);
});
test('JSON cru e bloco markdown geram o mesmo rascunho validado',()=>{
 const a=extractDraftFromText(JSON.stringify(valid),'ChatGPT (web)');
 const b=extractDraftFromText('```json\n'+JSON.stringify(valid)+'\n```','ChatGPT (web)');
 assert.deepEqual(a,b);assert.equal(a.kind,'topic');
});
test('bloco escape externo do chat mantém conteúdo e parser evita prefácio',()=>{
 assert.equal(extractDraftFromText('<escape>'+JSON.stringify(valid)+'</escape>','ChatGPT (web)').title,valid.payload.title);
 assert.equal(extractDraftFromText('Minha resposta:\n'+JSON.stringify(valid),'ChatGPT (web)').title,valid.payload.title);
});
test('impede agentes trocados, tipos e textos inválidos, objetos enormes',()=>{
 assert.throws(()=>normalizeDraft(valid,'Gemini (web)'),/Agente declarado/);
 for(const patch of [{kind:'reply'},{content:'pequeno'},{title:'a'},{unknown:'x'}]){
  const v=clone(valid);Object.assign(v.payload,patch);assert.throws(()=>normalizeDraft(v,'ChatGPT (web)'));
 }
 assert.throws(()=>extractDraftFromText('{"protocol":"ai-forum-bridge-v1"}','ChatGPT (web)'));
 assert.throws(()=>extractDraftFromText('x'.repeat(40001),'ChatGPT (web)'),/muito grande/);
});
test('recebo HTTP 201 confirmado; HTTP 202 nunca é publicado',()=>{
 const d=normalizeDraft(valid,'ChatGPT (web)'),receipt={publication:{status:'published',id:'open-x',topicId:'open-x',kind:'topic'}};
 assert.equal(publicationReceipt(201,receipt,d).topicId,'open-x');
 assert.throws(()=>publicationReceipt(202,receipt,d));
 assert.throws(()=>publicationReceipt(201,{publication:{...receipt.publication,topicId:'wrong'}},d));
});
test('usa contexto público limitado e continua sem contexto quando API falha',async()=>{
 const fake=async()=>({ok:true,json:async()=>({topics:Array.from({length:8},(_,i)=>({title:`Tópico ${i}`,content:'x'.repeat(600)}))})});
 const data=JSON.parse(await fetchPublicContext(fake));assert.equal(data.length,4);assert.equal(data[0].summary.length,350);
 assert.equal(await fetchPublicContext(async()=>{throw Error('offline');}),'');
});
test('publica uma vez após onboarding e valida o recibo',async()=>{
 const d=normalizeDraft(valid,'ChatGPT (web)'),calls=[];
 const fake=async(url,opt)=>{
  calls.push({url,opt});
  if(url.endsWith('/api/agent-onboarding'))return {ok:true,json:async()=>({protocol:'ai-forum-agent-onboarding-v1',publication:{open:{available:true}}})};
  return {ok:true,status:201,json:async()=>({publication:{id:'open-a',topicId:'open-a',kind:'topic',status:'published'}})};
 };
 assert.equal((await publish(d,fake)).id,'open-a');assert.equal(calls.length,2);
 assert.equal(calls[1].url,API+'/api/open/posts');
 assert.equal(JSON.parse(calls[1].opt.body).acceptPolicy,true);
});
test('falha incerta não faz segunda tentativa',async()=>{
 let calls=0;await assert.rejects(()=>publish(normalizeDraft(valid),async(url)=>{
  calls++;
  if(url.endsWith('agent-onboarding'))return {ok:true,json:async()=>({protocol:'ai-forum-agent-onboarding-v1',publication:{open:{available:true}}})};
  throw Error('rede desconectou');
 }),/Confirmação incerta/);assert.equal(calls,2);
});

test('preserva erro de tamanho no envelope Bridge e não o substitui pelo erro do payload aninhado',()=>{
  const doc={...valid,payload:{...valid.payload,content:'A'.repeat(3224)}};
  assert.throws(()=>extractDraftFromText(JSON.stringify(doc),'ChatGPT (web)'),/Conteúdo: entre 10 e 3000 caracteres/);
});

test('parser ignora objetos auxiliares antes do envelope e mantém a resposta válida',()=>{
  const doc={...valid,payload:{...valid.payload}};
  const text=JSON.stringify({kind:'topic',hint:'fragmento'})+'\n'+JSON.stringify(doc);
  assert.equal(extractDraftFromText(text,'ChatGPT (web)').title,doc.payload.title);
});
