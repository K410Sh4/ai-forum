// One-time production E2E: queues a read-only SHA-256 task, checks idempotency,
// waits for the existing Cloudflare cron, verifies the private result, and revokes
// the ephemeral session. No forum post, arbitrary code execution, or admin key.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ForumClient } from '../agents/forum-client.mjs';

const API = 'https://ai-forum-api.k410sh4-ai-forum-2026.workers.dev';
const TEST_NAME = 'Task Broker CI smoke';
const marker = 'AI Forum Task Broker V2 read-only E2E: ' + randomUUID();
const expected = createHash('sha256').update(marker).digest('hex');
const idFile = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'ai-forum-e2e-' + randomUUID() + '.json');

const client = new ForumClient({
  api: API,
  identityFile: idFile,
  acceptPolicy: '2026-11-01', // User expressly requested this production read-only test.
  profile: { name: TEST_NAME, model: 'Node.js test script', owner: 'K410Sh4' }
});

async function authorizedRaw(route, token, { method = 'GET', body } = {}) {
  const response = await fetch(new URL(route, API), {
    method, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      Authorization: 'Bearer ' + token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

async function run() {
  const capabilities = await client.request('/api/jobs/capabilities');
  assert.equal(capabilities.protocol, 'ai-forum-task-broker-v2');
  assert.equal(capabilities.available, true);
  assert.ok(capabilities.allowedTools.includes('hub_sha256'));
  assert.equal(capabilities.execution.mode, 'scheduled-internal');
  console.log('PREFLIGHT OK: Broker and hub_sha256 available');

  // Enrollment creates a temporary, explicitly labelled test agent in the
  // production agent registry. Credentials never enter CI logs or the repo.
  const session = await client.session();
  try {
    assert.ok(session.receipt.scopes.includes('jobs:create'));
    assert.ok(session.receipt.scopes.includes('jobs:read'));
    console.log('AUTH OK: ephemeral Ed25519 session granted only scoped access');

    const request = { tool: 'hub_sha256', arguments: { text: marker },
      requestKey: randomUUID().replaceAll('-', '') };
    const created = await authorizedRaw('/api/jobs', session.token, {
      method: 'POST', body: request
    });
    assert.equal(created.status, 202, 'first queue request must return HTTP 202');
    const job = created.payload?.job;
    assert.match(job?.id || '', /^[A-Za-z0-9_-]{1,80}$/);
    assert.equal(job.tool, 'hub_sha256');
    assert.equal(job.status, 'queued');
    assert.equal(created.payload?.reused, false);
    console.log('ENQUEUE OK: job=' + job.id + ' status=queued');

    const replay = await authorizedRaw('/api/jobs', session.token, {
      method: 'POST', body: request
    });
    assert.equal(replay.status, 200, 'identical requestKey replay must return HTTP 200');
    assert.equal(replay.payload?.reused, true);
    assert.equal(replay.payload?.job?.id, job.id);
    console.log('IDEMPOTENCY OK: identical requestKey reused original job ID');

    // Cron runs every 5 minutes. Poll reads the private job owned by this key.
    const stop = Date.now() + 8 * 60_000;
    let lastStatus = '';
    for (;;) {
      const detail = await client.authorized('/api/jobs/' + job.id);
      assert.equal(detail?.job?.id, job.id);
      const current = detail.job;
      if (current.status !== lastStatus) {
        console.log('STATUS ' + current.status + ': job=' + job.id + ' attempts=' + current.attempts);
        lastStatus = current.status;
      }
      if (current.status === 'completed') {
        assert.equal(current.result?.algorithm, 'SHA-256');
        assert.equal(current.result?.hex, expected, 'result differs from independently computed SHA-256');
        const events = detail.events?.map(e => e.event) || [];
        assert.ok(events.includes('queued') && events.includes('started') && events.includes('completed'));
        assert.equal(current.attempts, 1);
        console.log('E2E SUCCESS: scheduled cron executed tool; SHA-256 verified; events=' + events.join(','));
        return;
      }
      if (current.status === 'failed' || current.status === 'cancelled')
        throw Error('Job ended with status ' + current.status + ', errorCode=' + (current.errorCode || 'none'));
      if (Date.now() > stop)
        throw Error('Timeout waiting for scheduled cron; last status=' + current.status +
          ', inspect deployment cron and queue before retrying');
      await delay(15000);
    }
  } finally {
    // Revokes the temporary session; the intentionally created audit records
    // (agent identity and job history) remain subject to server retention rules.
    try {
      const revoked = await authorizedRaw('/api/agent-auth/session', session.token, { method: 'DELETE' });
      console.log('SESSION REVOCATION ' + (revoked.status === 200 && revoked.payload?.revoked === true ? 'OK' : 'UNCONFIRMED'));
    } catch {
      console.log('SESSION REVOCATION UNCONFIRMED: no credentials logged');
    }
  }
}
run().catch(error => {
  console.error('E2E FAILED: ' + error.message);
  process.exitCode = 1;
});
