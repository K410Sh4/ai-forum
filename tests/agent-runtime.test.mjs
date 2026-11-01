import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { boundedInt, recordPublishedReply, loadLegacyAgentState, saveLegacyAgentState } from '../agents/agent-runtime.mjs';

test('legacy Ollama local post quotas do not become NaN or unbounded on invalid environment values', () => {
  assert.equal(boundedInt(undefined,5,1,12),5);
  assert.equal(boundedInt('invalid',5,1,12),5);
  assert.equal(boundedInt('NaN',5,1,12),5);
  assert.equal(boundedInt('Infinity',5,1,12),5);
  assert.equal(boundedInt('0',5,1,12),1);
  assert.equal(boundedInt('-100',5,1,12),1);
  assert.equal(boundedInt('99',5,1,12),12);
  assert.equal(boundedInt('3.5',5,1,12),5);
  assert.equal(boundedInt('7',5,1,12),7);
  assert.equal(boundedInt('abc',90,30,3600),90);
  assert.throws(()=>boundedInt('1',0,10,1),/Invalid runtime bounds/);
});

test('legacy bot records the seen fingerprint only after a confirmed server reply', async () => {
  const state={seen:{},sent:[]};
  const deliver=async fn=>{
    await fn();
    recordPublishedReply(state,'topic-1','topic-1:reply-1',12345);
  };
  await assert.rejects(deliver(async()=>{ throw Error('HTTP 502 after unknown delivery'); }),/HTTP 502/);
  assert.deepEqual(state,{seen:{},sent:[]});
  await deliver(async()=>({reply:{id:'reply-2'}}));
  assert.deepEqual(state,{seen:{'topic-1':'topic-1:reply-1'},sent:[12345]});
});

test('a corrupted publication state never silently resets seen or sent journal', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aif-agent-audit-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'agent.json');
  assert.deepEqual(loadLegacyAgentState(file),{seen:{},sent:[]});
  fs.writeFileSync(file,JSON.stringify({seen:{topic:'reply'},sent:[100,200]}));
  assert.deepEqual(loadLegacyAgentState(file),{seen:{topic:'reply'},sent:[100,200]});
  fs.writeFileSync(file,'{unparseable');
  assert.throws(()=>loadLegacyAgentState(file),/unreadable; do not reset publication history/);
  fs.writeFileSync(file,JSON.stringify({seen:{topic:'reply'}}));
  assert.throws(()=>loadLegacyAgentState(file),/Invalid legacy Ollama state/);
});

test('atomic local journal save preserves the recorded topics across a fresh read',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'aif-agent-save-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'agent-state.json');
  const state={seen:{t1:'t1:r1'},sent:[123],startedAt:456};
  saveLegacyAgentState(file,state);
  assert.deepEqual(loadLegacyAgentState(file),state);
  assert.equal(fs.readdirSync(directory).length,1,'no temporary file left behind');
  state.seen.t2='t2:r2';
  saveLegacyAgentState(file,state);
  assert.deepEqual(loadLegacyAgentState(file),state);
});
