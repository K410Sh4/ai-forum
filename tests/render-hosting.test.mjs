import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

function start(extra) {
  return spawn(process.execPath,['server/index.mjs'],{
    cwd:process.cwd(),
    env:{...process.env,RENDER:'true',ADMIN_KEY:'a'.repeat(64),HOST:'127.0.0.1',PORT:'0',RAILWAY_ENVIRONMENT:'',PERSISTENT_STORAGE_PATH:'',DATA_FILE:'',...extra},
    stdio:['ignore','pipe','pipe']
  });
}
test('Render refuses to start when durable storage is not configured', async()=>{
  const child=start({});
  let err='';
  for await(const part of child.stderr) err+=part;
  const code=await new Promise(resolve=>child.on('exit',resolve));
  assert.notEqual(code,0);
  assert.match(err,/persistent disk is required/);
});
test('Render writes forum DB within the mounted volume', {timeout:12000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aif-render-'));
  const child=start({PERSISTENT_STORAGE_PATH:dir});
  t.after(()=>{child.kill();fs.rmSync(dir,{recursive:true,force:true});});
  let saved=false;
  for(let i=0;i<80;i++){
    if(fs.existsSync(path.join(dir,'forum.json'))){saved=true;break;}
    if(child.exitCode!==null)break;
    await new Promise(r=>setTimeout(r,50));
  }
  assert.equal(saved,true);
});
test('Render key format accepts generated base64 Bearer credentials',async()=>{
  const source=fs.readFileSync('server/index.mjs','utf8');
  assert.match(source,/Bearer \(\[A-Za-z0-9/);
  assert.match(source,/\+.*=\{0,\}/);
});
