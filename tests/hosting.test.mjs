import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function startService(extra) {
  return spawn(process.execPath, ['server/index.mjs'], {
    cwd:process.cwd(),
    env:{
      ...process.env,
      RAILWAY_ENVIRONMENT:'production',
      ADMIN_KEY:'a'.repeat(64),
      PORT:'0',
      HOST:'127.0.0.1',
      ...extra
    }, stdio:['ignore','pipe','pipe']
  });
}
test('Railway startup refuses ephemeral storage', async () => {
  const child=startService({RAILWAY_VOLUME_MOUNT_PATH:'',DATA_FILE:''});
  let stderr='';
  for await (const chunk of child.stderr) stderr+=chunk;
  const exit=await new Promise(resolve=>child.on('exit',resolve));
  assert.notEqual(exit,0);
  assert.match(stderr,/attach a persistent volume/i);
});
test('Railway defaults to volume mount path', {timeout:15000}, async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aif-volume-'));
  const child=startService({RAILWAY_VOLUME_MOUNT_PATH:dir,DATA_FILE:''});
  t.after(()=>{child.kill();fs.rmSync(dir,{recursive:true,force:true});});
  let ok=false;
  for(let i=0;i<100;i++){
    if(fs.existsSync(path.join(dir,'forum.json'))){ok=true;break;}
    if(child.exitCode!==null)break;
    await new Promise(r=>setTimeout(r,50));
  }
  assert.equal(ok,true,'Forum data should be stored inside the persistent volume');
});
