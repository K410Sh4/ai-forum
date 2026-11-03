import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const yml=readFileSync(new URL('../.github/workflows/mobile-cloudflare-release.yml',import.meta.url),'utf8');
const doc=readFileSync(new URL('../docs/DEPLOY_MOBILE.md',import.meta.url),'utf8');

test('mobile release is manual, owner-confirmed, main-only, serial and uses minimal token rights',()=>{
  assert.match(yml,/^on:\s*\n\s*workflow_dispatch:/m);
  assert.doesNotMatch(yml,/^\s+(push|pull_request|schedule):/m);
  assert.match(yml,/github\.ref == 'refs\/heads\/main'/);
  assert.match(yml,/github\.actor == 'K410Sh4'/);
  assert.match(yml,/inputs\.confirmation == 'DEPLOY'/);
  assert.match(yml,/inputs\.backup_acknowledgement == true/);
  assert.match(yml,/cancel-in-progress: false/);
  assert.match(yml,/permissions:\s*\n\s+contents: read/);
  assert.match(yml,/environment: cloudflare-production/);
  assert.doesNotMatch(yml,/permissions:[\s\S]*?contents:\s*write/);
});
test('mobile release uploads only encrypted validated backup before any remote migration or deploy',()=>{
  const exportPos=yml.indexOf('wrangler d1 export');
  const encryptPos=yml.indexOf('openssl enc -aes-256-cbc');
  const verifyPos=yml.indexOf('cmp -s "$plaintext" "$verification"');
  const artifactPos=yml.indexOf('actions/upload-artifact@v4');
  const migratePos=yml.indexOf('wrangler d1 migrations apply');
  const deployPos=yml.indexOf('wrangler deploy');
  assert.ok(exportPos>0&&exportPos<encryptPos&&encryptPos<verifyPos&&verifyPos<artifactPos);
  assert.ok(artifactPos<migratePos&&migratePos<deployPos);
  assert.match(yml,/retention-days: 30/);
  assert.match(yml,/if-no-files-found: error/);
  assert.match(yml,/D1_BACKUP_PASSPHRASE: \$\{\{ secrets\.D1_BACKUP_PASSPHRASE \}\}/);
  assert.match(yml,/--agent-history/);
  assert.match(yml,/ai-forum-consultative-reputation-v4/);
  assert.ok(!/\b(upload-artifact|tar|zip)\b[^\n]*(?:\.sql\b(?!\.enc))/.test(yml),'plaintext SQL must never be an artifact');
});
test('mobile release documentation is upfront about secret setup, retention and no automatic rollback',()=>{
  for(const s of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','D1_BACKUP_PASSPHRASE','30 dias',
    'DEPLOY','cloudflare-production','não reverte automaticamente']){
    assert.ok(doc.includes(s),'missing docs '+s);
  }
});
