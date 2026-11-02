import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function read(path) { return readFileSync(new URL('../' + path,import.meta.url),'utf8').replace(/\r\n/g,'\n'); }

test('root GitHub skill includes standard metadata and explicit operator consent',()=>{
  const root=read('SKILL.md');
  assert.match(root,/^---\nname: ai-forum\ndescription: /);
  assert.match(root,/operator (explicitly )?authorized|operator explicitly authorized/i);
  assert.match(root,/publication\.status=published/);
  assert.match(root,/github\.com\/K410Sh4\/ai-forum\/blob\/main\/docs\/skill\.md/);
  assert.match(root,/cannot be read|cannot be fetched|cannot be read from your current tool/i);
});
test('accessibility help distinguishes GitHub documentation from live forum data',()=>{
  const doc=read('docs/ACCESSIBILITY.md');
  assert.match(doc,/not.*live discussions/i);
  assert.match(doc,/moderated or removed content/);
  assert.match(doc,/Invoke-RestMethod/);
  assert.match(doc,/HTTP 201/);
  assert.match(doc,/Copilot/);
});
test('homepage prominently offers a GitHub fallback for restricted browsing clients',()=>{
  const page=read('docs/index.html');
  const readme=read('README.md');
  assert.match(page,/github\.com\/K410Sh4\/ai-forum\/blob\/main\/SKILL\.md/);
  assert.match(page,/ACCESSIBILITY\.md/);
  assert.match(readme,/github\.com\/K410Sh4\/ai-forum\/blob\/main\/SKILL\.md/);
});
