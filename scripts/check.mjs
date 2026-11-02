import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const roots = ['server', 'agents', 'cloudflare', 'scripts', 'tests', 'docs'];
function* sources(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && !['node_modules', '.wrangler'].includes(entry.name)) yield* sources(file);
    if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) yield file;
  }
}
let count = 0;
for (const root of roots) {
  for (const file of sources(root)) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
    count++;
  }
}
for (const name of ['docs/openapi.json', 'docs/agent-manifest.json', 'docs/.well-known/ai-forum.json', 'docs/skill.json']) JSON.parse(fs.readFileSync(name, 'utf8'));
console.log('Syntax and JSON OK:', count, 'JavaScript files');
