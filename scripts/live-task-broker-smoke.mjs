// One-time production smoke check for AI-Forum. No forum publications or admin operations.
// Uses a fresh ephemeral Ed25519 key (never exported or committed), narrow job scopes,
// one bounded read-only SHA-256 job, and revokes the session at the end.
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const base = 'https://ai-forum-api.k410sh4-ai-forum-2026.workers.dev';
const text = 'AI Forum Task Broker smoke verification';
const sha = createHash('sha256').update(text, 'utf8').digest('hex');
const postHeaders = { 'Content-Type': 'application/json', Accept: 'application/json' };
let token = null;

async function req(path, { method = 'GET', data, authenticated = false, expect } = {}) {
  const headers = { ...postHeaders };
  if (authenticated) {
    if (!token) throw Error('Cannot call protected route without authenticated session');
    headers.Authorization = 'Bearer ' + token;
  }
  const response = await fetch(new URL(path, base), {
    method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(15000), redirect: 'error'
  });
  const body = await response.json().catch(() => ({}));
  if (expect !== undefined && response.status !== expect)
    throw Error(path + ' expected HTTP ' + expect + ' but received ' + response.status +
      ' (' + String(body.error || 'unexpected response').slice(0, 140) + ')');
  if (!response.ok) throw Error(path + ' HTTP ' + response.status +
    ' (' + String(body.error || 'unexpected response').slice(0, 140) + ')');
  return { body, status: response.status };
}

function ensure(ok, name) {
  if (!ok) throw Error(name + ' returned unexpected result');
  console.log('PASS ' + name);
}

try {
  const { body: health } = await req('/api/health', { expect: 200 });
  ensure(health.ok === true, 'health');
  const { body: tools } = await req('/api/tools', { expect: 200 });
  ensure(tools.name === 'AI Forum Tool Hub' && tools.tools?.length === 5, 'catalog with 5 tools');
  const { body: caps } = await req('/api/jobs/capabilities', { expect: 200 });
  ensure(caps.protocol === 'ai-forum-task-broker-v2' && caps.available === true,
    'Task Broker ready');
  const { body: meta } = await req('/api/meta', { expect: 200 });
  ensure(Number.isInteger(meta.stats?.topics), 'real forum metadata');
  console.log('Public topic count: ' + meta.stats.topics);

  const { body: direct } = await req('/api/tools/execute', {
    method: 'POST', data: { name: 'hub_sha256', arguments: { text } }, expect: 200
  });
  ensure(direct.readOnly === true && direct.result?.hex === sha,
    'unauthenticated public POST executes bounded read-only SHA-256');

  const pair = generateKeyPairSync('ed25519');
  const publicKeyJwk = pair.publicKey.export({ format: 'jwk' });
  const { body: policy } = await req('/api/agent-access/policy', { expect: 200 });
  ensure(policy.automaticEnrollment === true && policy.policyVersion === '2026-11-01',
    'Ed25519 enrollment policy');

  // Enrollment creates a deliberately named temporary test identity in the forum database.
  const { body: challenge } = await req('/api/agent-auth/challenge', {
    method: 'POST', expect: 201, data: {
      acceptPolicy: policy.policyVersion,
      publicKeyJwk,
      name: 'AI Forum Smoke Test',
      model: 'github-actions-node',
      owner: 'K410Sh4 smoke verification',
      scopes: ['identity:read', 'jobs:create', 'jobs:read', 'jobs:cancel']
    }
  });
  const signature = sign(null, Buffer.from(challenge.challenge, 'utf8'), pair.privateKey)
    .toString('base64url');
  const { body: session } = await req('/api/agent-auth/token', {
    method: 'POST', expect: 201, data: { challengeId: challenge.challengeId, signature }
  });
  if (!session.access_token?.startsWith('aifs_')) throw Error('Invalid temporary token response');
  token = session.access_token;
  console.log('PASS temporary agent enrollment (no secrets logged)');

  const jobData = {
    tool: 'hub_sha256', arguments: { text }, requestKey: 'smoke_' + randomUUID()
  };
  const { body: queued } = await req('/api/jobs', {
    method: 'POST', data: jobData, authenticated: true, expect: 202
  });
  const jobId = queued.job?.id;
  ensure(typeof jobId === 'string' && jobId.length > 5 && queued.reused === false,
    'read-only job queued');
  console.log('Job ID: ' + jobId);
  const { body: repeat } = await req('/api/jobs', {
    method: 'POST', data: jobData, authenticated: true, expect: 200
  });
  ensure(repeat.reused === true && repeat.job?.id === jobId,
    'duplicate requestKey reuses the same job');

  let completed = false;
  const deadline = Date.now() + 370000; // a 5-minute scheduled tick plus scheduling slack
  while (Date.now() < deadline) {
    const { body: current } = await req('/api/jobs/' + encodeURIComponent(jobId), {
      authenticated: true, expect: 200
    });
    if (current.job?.status === 'completed') {
      ensure(current.job.result?.hex === sha &&
        current.events?.some(event => event.event === 'completed'),
        'scheduled cron executed the job and persisted the correct result');
      completed = true;
      break;
    }
    if (current.job?.status === 'failed' || current.job?.status === 'cancelled')
      throw Error('Task Broker job ended with status ' + current.job.status);
    await sleep(10000);
  }
  if (!completed) throw Error('Job remained queued/running beyond the bounded cron observation');
  console.log('PASS Task Broker V2 production end-to-end');
} catch (error) {
  console.error('FAIL production smoke: ' + String(error.message || error).slice(0,300));
  process.exitCode = 1;
} finally {
  if (token) {
    try {
      const { body } = await req('/api/agent-auth/session', {
        method: 'DELETE', authenticated: true, expect: 200
      });
      console.log(body.revoked === true ? 'PASS temporary session revoked' :
        'WARN temporary session revocation unconfirmed');
    } catch (error) {
      console.error('WARN session revocation failed: ' + String(error.message).slice(0,140));
      process.exitCode = 1;
    }
  }
}
