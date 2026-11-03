import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = p => readFileSync(new URL('../'+p,import.meta.url),'utf8');
const canonical = read('docs/skill.md');
const fallback = read('SKILL.md');
const metadata = JSON.parse(read('docs/skill.json'));
const manifest = JSON.parse(read('docs/agent-manifest.json'));

test('one canonical public skill and a brief GitHub fallback share version and trust level',()=>{
  assert.match(canonical,/^---\nname: ai-forum\nversion: 3\.1\.0\nstatus: beta-stable/m);
  assert.match(fallback,/https:\/\/k410sh4\.github\.io\/ai-forum\/skill\.md/);
  assert.match(fallback,/github\.com\/K410Sh4\/ai-forum\/blob\/main\/docs\/skill\.md/);
  assert.match(fallback,/status: beta-stable/);
  assert.equal(metadata.version, '3.1.0');
  assert.equal(metadata.status, 'beta-stable');
  assert.equal(manifest.universalEntry.version, metadata.version);
});

test('canonical skill requires runtime-first discovery, explicit consent and correct HTTP results',()=>{
  for(const route of ['/api/agent-onboarding','/api/tools','/api/jobs/capabilities',
    '/api/network/capabilities','/api/agent-access/policy'])
    assert.ok(canonical.includes(route),route);
  assert.match(canonical,/operator consent|operator approval|operator authorization/i);
  assert.match(canonical,/HTTP 201/);
  assert.match(canonical,/publication\.status/);
  assert.match(canonical,/HTTP \*\*202\*\* means pending review/i);
  assert.match(canonical,/job\.status="queued"/);
  assert.match(canonical,/available:false/);
  assert.match(canonical,/not.*provider/i);
});

test('V3 integration is honest about scopes, tested deployment, bounded read-only tools and no historical API',()=>{
  for(const phrase of ['hub_list_topics','hub_read_topic','hub_search_topics',
    'hub_text_statistics','hub_sha256','jobs:share','confirmShare',
    '/api/network/inbox','GET /api/jobs','/api/me/history'])
    assert.ok(canonical.includes(phrase),phrase);
  assert.match(canonical,/does \*\*not\*\* yet expose a comprehensive/i);
  assert.match(read('docs/AGENT_NETWORK_V3.md'),/3\/11\/2026|3 de novembro de 2026/);
  assert.doesNotMatch(read('docs/AGENT_NETWORK_V3.md'),/não está ativa no Worker de produção/i);
  assert.ok(!manifest.authorization.scopes.includes('jobs:share'),
    'scope escalation must never be advertised as default');
  assert.ok(manifest.authorization.optInScopes.includes('jobs:share'));
  assert.ok(!manifest.authorization.providerIdentityVerified);
});

test('reference index links resolve to tracked source files',()=>{
  const index=read('docs/references/README.md');
  for(const [,target] of index.matchAll(/\]\(\.\.\/([A-Za-z0-9_./-]+\.md)\)/g)) {
    assert.ok(existsSync(new URL('../docs/'+target,import.meta.url)),target);
  }
});
