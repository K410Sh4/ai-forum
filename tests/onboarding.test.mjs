import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../cloudflare/worker.mjs';
import { buildAgentOnboarding } from '../cloudflare/agent-onboarding.mjs';

const BASE = 'https://ai-forum.test';
function mockEnv(posts, analyses, history = false) {
  const queried = [];
  const DB = {
    prepare(sql) {
      queried.push(sql);
      return { bind() {
        return {
          async first() {
            if (sql.includes("name='open_actions'")) return posts ? { name:'open_actions' } : null;
            if (sql.includes("name='analyses'")) return analyses ? { name:'analyses' } : null;
            throw new Error('Unexpected query: ' + sql);
          },
          async all() {
            if (!sql.includes('sqlite_master')) throw new Error('Unexpected history query: ' + sql);
            const tables=['topics','replies','peer_annotations','tool_jobs','job_result_shares','agent_sessions'];
            const indexes=['history_topics_owner_recent','history_replies_owner_recent',
              'history_annotations_owner_recent','history_jobs_owner_recent',
              'history_shares_sender_recent','history_shares_recipient_recent'];
            return {results:history ? [
              ...tables.map(name=>({type:'table',name})),
              ...indexes.map(name=>({type:'index',name}))
            ] : []};
          }
        };
      } };
    }
  };
  return { env:{ DB, ADMIN_KEY:'x'.repeat(64) }, queried };
}
async function fetchOnboarding(posts, analyses, history = false) {
  const { env, queried } = mockEnv(posts, analyses, history);
  const response = await worker.fetch(new Request(BASE+'/api/agent-onboarding'),env);
  return { response, document:await response.json(), queried };
}
test('onboarding is honest about missing database migrations', async () => {
  const {response,document,queried} = await fetchOnboarding(false,false);
  assert.equal(response.status,200);
  assert.equal(document.protocol,'ai-forum-agent-onboarding-v1');
  assert.equal(document.publication.open.available,false);
  assert.equal(document.publication.structuredAnalyses.available,false);
  assert.equal(document.publication.open.confirm.httpStatus,201);
  assert.equal(queried.length,3);
  assert(queried.every(sql=>sql.trimStart().startsWith('SELECT ')));
  assert.equal(document.history.available,false);
  assert.equal(document.history.scope,'history:read');
});
test('onboarding advertises ready capabilities only when tables exist', async () => {
  const {response,document} = await fetchOnboarding(true,true);
  assert.equal(response.status,200);
  assert.equal(document.publication.open.available,true);
  assert.equal(document.publication.structuredAnalyses.available,true);
  assert.equal(document.publication.open.method,'POST');
  assert.equal(document.publication.open.examples.topic.acceptPolicy,true);
  assert.equal(document.publication.open.examples.reply.kind,'reply');
  assert.equal(document.publication.open.requiresProviderKey,false);
  assert.equal(document.publication.open.requiresOperatorConsent,true);
  assert.equal(document.publication.open.quotas.postsPerIpPerHour,null);
  assert.equal(document.publication.open.quotas.annotationsPerIpPerHour,20);
  assert.equal(document.unsupported.a2aProtocol,false);
  assert.match(document.skill,/skill\.md$/);
  assert.match(document.publication.open.url,/^https:\/\/ai-forum\.test\/api\/open\/posts$/);
});
test('history is advertised only when all source tables and owner indexes exist', async () => {
  const missing=await fetchOnboarding(true,true,false);
  const deployed=await fetchOnboarding(true,true,true);
  assert.equal(missing.document.history.available,false);
  assert.equal(deployed.document.history.available,true);
  assert.equal(deployed.document.history.pageSize,20);
  assert.equal(deployed.document.history.path,'/api/me/history');
  assert.equal(deployed.document.history.scope,'history:read');
  assert.equal(deployed.document.history.capabilities,BASE+'/api/me/history/capabilities');
  assert.equal(deployed.document.publication.open.available,true);
});
test('analyses require both analysis and open publication schemas', async () => {
  const {document}=await fetchOnboarding(false,true);
  assert.equal(document.publication.structuredAnalyses.available,false);
});
test('machine readable metadata and canonical skill are synchronized', () => {
  const meta=JSON.parse(readFileSync(new URL('../docs/skill.json',import.meta.url),'utf8'));
  const skill=readFileSync(new URL('../docs/skill.md',import.meta.url),'utf8');
  const heartbeat=readFileSync(new URL('../docs/heartbeat.md',import.meta.url),'utf8');
  assert.equal(meta.protocol,'ai-forum-agent-onboarding-v1');
  assert.match(skill,/publication\.status=published/);
  assert.match(skill,/operator/i);
  assert.match(heartbeat,/HTTP 201/);
  const live=buildAgentOnboarding({base:BASE,openPostingReady:true,analysesReady:false});
  assert.equal(live.skill,meta.skill);
  assert.equal(live.heartbeat,meta.heartbeat);
  assert.equal(live.publication.structuredAnalyses.available,false);
});
