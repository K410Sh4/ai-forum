import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PROVIDERS,STATUS,providerInfo,phaseFor,summarizeSession,sanitizedPreview} from '../dashboard-model.js';
const read=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');

test('Operations Board preserves five known providers without claiming model versions or quotas',()=>{
  assert.deepEqual(PROVIDERS.map(x=>x.name),['ChatGPT','Grok','Gemini','Copilot','Meta AI']);
  assert.equal(phaseFor(null,{discarded:true}).label,'Indisponível');
  assert.equal(phaseFor(null,{frozen:false}).label,'Disponível');
  assert.equal(phaseFor({status:'limite-uso'}).tone,'warning');
  assert.equal(phaseFor({status:'publicado'}).tone,'success');
  assert.equal(providerInfo('Other').glyph,'?');
  assert.equal(STATUS['publicacao-incerta'].tone,'warning');
});
test('publication count requires a receipt and counts manual review separately',()=>{
  const session={id:'test',running:false,endedAt:1,entries:{
    1:{status:'publicado',receipt:{id:'open-1',topicId:'open-1'},provider:'ChatGPT'},
    2:{status:'publicado',receipt:null,provider:'Grok'},
    3:{status:'validado',provider:'Gemini'},
    4:{status:'limite-uso',provider:'Copilot'},
    5:{status:'gerando',provider:'Meta AI'}
  }};
  assert.deepEqual(summarizeSession(session),{total:5,published:1,validated:3,issues:1,pending:1,finished:4,percent:80});
  const preview=sanitizedPreview(session);
  assert.deepEqual(preview.publicacoes,[{provedor:'ChatGPT',id:'open-1'}]);
  assert.equal(preview.pendentesDeRevisao,1);
  assert.equal(preview.publicacoesConfirmadas,1);
});
test('JSON preview strips captured content, credentials and private properties',()=>{
  const session={id:'s',running:true,token:'do-not-expose',ownerKey:'secret',entries:{
    1:{provider:'ChatGPT',status:'publicado',receipt:{id:'open-1',topicId:'open-1',url:'https://example.test'},draft:{title:'private title',content:'private content'}}
  }};
  const result=JSON.stringify(sanitizedPreview(session));
  for(const secret of ['do-not-expose','secret','private content','private title','example.test'])assert.equal(result.includes(secret),false);
});
test('dashboard markup binds every required action to a unique ID',()=>{
  const html=read('dashboard.html');
  const ids=['liveIndicator','timer','openProviders','start','stop','reload','inspect','tabs','count','sessionStatus','objective','separateWindows','consentPrompt','consentPublish','replacePending','ownerMode','ownerKey','entries','resultCount','metricSelected','metricValidated','metricIssues','metricPending','metricPublished','progressBar','activityFeed','jsonPreview','operations','configuration','results','insights'];
  for(const id of ids){
    const occurrences=[...html.matchAll(new RegExp('id="'+id+'"','g'))];
    assert.equal(occurrences.length,1,'expected one '+id);
  }
  assert.match(html,/id="consentPublish" type="checkbox"/);
  assert.match(html,/id="consentPrompt" type="checkbox"/);
  assert.match(html,/id="separateWindows" type="checkbox" checked/);
  assert.match(html,/id="replacePending" type="checkbox" checked/);
  assert.match(html,/script src="\.\/dashboard\.js" type="module"/);
});
test('dashboard uses live Chrome storage events and avoids unsafe HTML injection',()=>{
  const js=read('dashboard.js');
  assert.match(js,/watchBridgeActivity\(/);
  assert.match(js,/AFB_OPEN_PROVIDERS/);
  assert.match(js,/AFB_START_SESSION/);
  assert.match(js,/AFB_STOP_SESSION/);
  assert.match(js,/AFB_APPROVE/);
  assert.match(js,/AFB_INSPECT/);
  assert.match(js,/chrome\.windows\.update/);
  assert.doesNotMatch(js,/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/);
});
