import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const content=fs.readFileSync(new URL('../content.js',import.meta.url),'utf8');
const background=fs.readFileSync(new URL('../background.js',import.meta.url),'utf8');
const dashboard=fs.readFileSync(new URL('../dashboard.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../dashboard.html',import.meta.url),'utf8');

test('reinjection guard checks and sets exactly the same name',()=>{
  assert.match(content,/if\(window!==window\.top \|\| globalThis\.__AFB_REBUILT_240__\)return;/);
  assert.match(content,/globalThis\.__AFB_REBUILT_240__=true;/);
  assert.doesNotMatch(content,/globalThis\.__AFB_REBUILT_224__=true;/);
});
test('opening provider windows never sends prompts or touches editor',()=>{
  const openBlock=background.split('async function openProviders(sender, mode=')[1]?.split('async function readyForContent(')[0];
  assert.ok(openBlock);
  assert.doesNotMatch(openBlock,/AFB_START|sendMessage|executeScript|insertText|setComposer/);
});
test('pending draft replacement requires session consent and an explicit user-visible option',()=>{
  assert.match(background,/message\.consentPrompt!==true/);
  assert.match(background,/replacePending:message\.replacePending===true/);
  assert.match(dashboard,/replacePending:\$\('replacePending'\)\.checked/);
  assert.match(html,/id="replacePending" type="checkbox" checked/);
  assert.match(html,/texto não enviado no editor selecionado será substituído/i);
  assert.match(content,/if\(pending&&!replacePending\)throw Error/);
  assert.match(content,/await setComposer\(el,message\.prompt,message\.replacePending===true\)/);
  assert.doesNotMatch(content,/Editor já contém texto\. Limpe-o antes de iniciar\./);
});
test('send is at most one click; uncertain sends require manual verification',()=>{
  assert.match(content,/top\.btn\.click\(\);return top\.evidence;/);
  assert.match(content,/if\(!verification\.confirmed&&!verification\.cleared\)/);
  assert.match(content,/error\.code='SEND_UNCONFIRMED'/);
  assert.match(content,/report\(e\?\.code==='SEND_UNCONFIRMED'\?'envio-incerto'/);
  assert.match(background,/envio-incerto/);
  assert.doesNotMatch(content,/top\.btn\.click\(\);\s*top\.btn\.click\(\)/);
});
test('editor recovery affects only the composer and verifies text equality before click',()=>{
  assert.match(content,/range\.selectNodeContents\(el\)/);
  assert.match(content,/replacement\.selectNodeContents\(el\)/);
  assert.match(content,/if\(!equivalent\(editorValue\(el\),job\.prompt\)\)throw Error/);
  assert.match(content,/for\(let attempt=0;attempt<2;attempt\+\+\)/);
});
