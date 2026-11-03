// Deterministic dependency-free ZIP builder (stored entries, no executable build hooks).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const source=path.join(ROOT,'extensions/ai-forum-bridge');
export function bridgeFiles(){
  const files=new Map();
  for(const name of fs.readdirSync(source).sort()){
    if(!/^[a-zA-Z0-9_.-]+$/.test(name)||!fs.statSync(path.join(source,name)).isFile())throw Error('Unexpected extension entry: '+name);
    let content=fs.readFileSync(path.join(source,name));
    if(name.endsWith('.js'))content=Buffer.from(content.toString('utf8')
      .replaceAll('../../docs/chat-bridge.js','./shared/chat-bridge.js')
      .replaceAll('../../cloudflare/tool-hub.mjs','./shared/tool-hub.mjs'));
    files.set(name,content);
  }
  files.set('shared/chat-bridge.js',fs.readFileSync(path.join(ROOT,'docs/chat-bridge.js')));
  files.set('shared/tool-hub.mjs',fs.readFileSync(path.join(ROOT,'cloudflare/tool-hub.mjs')));
  return new Map([...files.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0));
}
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
export function zipFiles(files){
  const local=[],central=[];let offset=0;
  for(const [filename,content] of files){
    const name=Buffer.from(filename);const crc=crc32(content);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);
    header.writeUInt16LE(0x21,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(content.length,18);header.writeUInt32LE(content.length,22);header.writeUInt16LE(name.length,26);
    local.push(header,name,content);
    const dir=Buffer.alloc(46);dir.writeUInt32LE(0x02014b50);dir.writeUInt16LE(20,4);dir.writeUInt16LE(20,6);dir.writeUInt16LE(0x800,8);
    dir.writeUInt16LE(0x21,14);dir.writeUInt32LE(crc,16);dir.writeUInt32LE(content.length,20);dir.writeUInt32LE(content.length,24);dir.writeUInt16LE(name.length,28);dir.writeUInt32LE(offset,42);
    central.push(dir,name);offset+=header.length+name.length+content.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.size,8);end.writeUInt16LE(files.size,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
export function packageBridge(){
  const files=bridgeFiles();const manifest=JSON.parse(files.get('manifest.json'));
  const name='AI-Forum-Bridge-v'+manifest.version+'.zip';const bytes=zipFiles(files);
  return {name,bytes,sha256:createHash('sha256').update(bytes).digest('hex'),files};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=packageBridge(),directory=path.join(ROOT,'docs/downloads');
  const target=path.join(directory,result.name),checksum=path.join(directory,result.name+'.sha256');
  if(process.argv.includes('--check')){
    if(!fs.existsSync(target)||!fs.readFileSync(target).equals(result.bytes))throw Error('Extension ZIP is stale. Run npm run bridge:package.');
    if(fs.readFileSync(checksum,'utf8')!==result.sha256+'  '+result.name+'\n')throw Error('Extension checksum is stale.');
    console.log('Extension package matches source:',result.name);
  }else{fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(target,result.bytes);fs.writeFileSync(checksum,result.sha256+'  '+result.name+'\n');console.log(target+'\nSHA-256 '+result.sha256);}
}
