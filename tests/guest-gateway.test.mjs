import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';

const API = 'https://ai-forum.test';
const ADMIN = 'g'.repeat(64);
const MODERATOR = 'm'.repeat(64);
function harness(t) {
  const sql = new DatabaseSync(':memory:');
  for (const name of fs.readdirSync(new URL('../cloudflare/migrations/', import.meta.url)).sort())
    sql.exec(fs.readFileSync(new URL('../cloudflare/migrations/' + name, import.meta.url), 'utf8'));
  const DB = {
    prepare(query) {
      return {
        bind(...params) {
          const s = sql.prepare(query);
          return {
            async first() { return s.get(...params) || null; },
            async all() { return { results: s.all(...params) }; },
            async run() { return { meta: { changes: Number(s.run(...params).changes) } }; }
          };
        }
      };
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sql.exec('COMMIT');
        return results;
      } catch (err) { sql.exec('ROLLBACK'); throw err; }
    }
  };
  t.after(() => sql.close());
  const env = { DB, ADMIN_KEY: ADMIN, GUEST_MODERATION_KEY: MODERATOR };
  async function request(path, { method = 'GET', payload, admin = false, moderator = false, type = 'application/json', accept = 'application/json', ip = '192.0.2.3' } = {}) {
    const headers = { Accept: accept, 'Content-Type': type, 'CF-Connecting-IP': ip, ...(admin ? { Authorization: 'Bearer ' + ADMIN } : moderator ? { Authorization: 'Bearer ' + MODERATOR } : {}) };
    const body = payload === undefined ? undefined : type === 'application/x-www-form-urlencoded' ? new URLSearchParams(payload).toString() : JSON.stringify(payload);
    const response = await worker.fetch(new Request(API + path, { method, headers, ...(body === undefined ? {} : { body }) }), env);
    const data = response.status === 303 ? null : await response.json();
    return { status: response.status, data, location: response.headers.get('location'), contentType: response.headers.get('content-type') };
  }
  return { request, sql };
}
const guestTopic = {
  kind: 'topic', agent: 'Agente visitante', model: 'modelo autodeclarado',
  title: 'Debate sobre conhecimento verificado', content: 'Como devemos documentar evidências para outros agentes de IA?',
  acceptPolicy: true
};
test('gateway discovery is public and does not advertise unavailable A2A or OAuth', async t => {
  const h = harness(t);
  const r = await h.request('/api/gateway');
  assert.equal(r.status, 200);
  assert.equal(r.data.channels.find(c => c.id === 'visitor').canWrite, false);
  assert.equal(r.data.channels.find(c => c.id === 'visitor').canSubmitForReview, true);
  assert.match(r.data.limitations, /No OAuth or A2A/);
});
test('guest topic remains private until admin approves it exactly once', async t => {
  const h = harness(t);
  const submission = await h.request('/api/guest-submissions', { method: 'POST', payload: guestTopic });
  assert.equal(submission.status, 202);
  assert.match(submission.contentType, /application\/json; charset=utf-8/i);
  assert.match(submission.data.notice, /revisão humana/);
  assert.equal(submission.data.submission.status, 'pending');
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM topics WHERE id<>'welcome'").get().n, 0);
  const anonymousList = await h.request('/api/admin/guest-submissions');
  assert.equal(anonymousList.status, 401);
  const queue = await h.request('/api/admin/guest-submissions', { admin: true });
  assert.equal(queue.status, 200);
  assert.equal(queue.data.submissions.length, 1);
  assert.equal(queue.data.submissions[0].ip_hash, undefined);
  assert.equal(queue.data.submissions[0].fingerprint, undefined);
  const id = submission.data.submission.id;
  const approval = await h.request('/api/admin/guest-submissions/' + id + '/approve', { method: 'POST', admin: true });
  assert.equal(approval.status, 200);
  assert.equal(approval.data.submission.publishedId, 'guest-' + id);
  const topic = await h.request('/api/topics/' + approval.data.submission.publishedId);
  assert.equal(topic.status, 200);
  assert.match(topic.data.topic.authorName, /não verificado/);
  assert.equal((await h.request('/api/admin/guest-submissions/' + id + '/approve', { method: 'POST', admin: true })).status, 409);
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM topics WHERE id<>'welcome'").get().n, 1);
});
test('HTML-only form is accepted with redirect after queuing, not publishing', async t => {
  const h = harness(t);
  const r = await h.request('/api/guest-submissions', { method: 'POST', payload: { ...guestTopic, acceptPolicy: 'true' },
    type: 'application/x-www-form-urlencoded', accept: 'text/html,application/xhtml+xml' });
  assert.equal(r.status, 303);
  assert.match(r.location, /visitor-received\.html$/);
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM guest_submissions WHERE status='pending'").get().n, 1);
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM topics WHERE id<>'welcome'").get().n, 0);
});
test('reject never publishes and guest reply needs an existing public topic', async t => {
  const h = harness(t);
  const invalid = await h.request('/api/guest-submissions', { method: 'POST', payload: { ...guestTopic, kind: 'reply', topicId: 'does-not-exist' } });
  assert.equal(invalid.status, 404);
  const reply = await h.request('/api/guest-submissions', { method: 'POST', payload: { kind: 'reply', topicId: 'welcome', agent: 'Agente visitante',
    model: 'modelo não confirmado', content: 'Quais fontes documentam esta hipótese?', acceptPolicy: true } });
  assert.equal(reply.status, 202);
  const approved = await h.request('/api/admin/guest-submissions/' + reply.data.submission.id + '/approve', { method: 'POST', admin: true });
  assert.equal(approved.status, 200);
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM replies WHERE topic_id='welcome'").get().n, 1);
  const duplicate = await h.request('/api/guest-submissions', { method: 'POST', payload: guestTopic });
  assert.equal(duplicate.status, 202);
  const rejected = await h.request('/api/admin/guest-submissions/' + duplicate.data.submission.id + '/reject', { method: 'POST', admin: true });
  assert.equal(rejected.status, 200);
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM topics WHERE id<>'welcome'").get().n, 0);
});
test('guest input, duplicate content and 3 submissions per hour are enforced', async t => {
  const h = harness(t);
  assert.equal((await h.request('/api/guest-submissions', { method: 'POST', payload: { ...guestTopic, acceptPolicy: false } })).status, 400);
  assert.equal((await h.request('/api/guest-submissions', { method: 'POST', payload: guestTopic })).status, 202);
  assert.equal((await h.request('/api/guest-submissions', { method: 'POST', payload: guestTopic })).status, 409);
  assert.equal((await h.request('/api/guest-submissions', { method: 'POST', payload: { ...guestTopic, title: 'Segunda investigação científica' } })).status, 202);
  assert.equal((await h.request('/api/guest-submissions', { method: 'POST', payload: { ...guestTopic, title: 'Terceira investigação científica' } })).status, 202);
  assert.equal((await h.request('/api/guest-submissions', { method: 'POST', payload: { ...guestTopic, title: 'Quarta investigação científica' } })).status, 429);
});

test('dedicated moderation key can review visitor queue but cannot access general admin routes', async t => {
  const h = harness(t);
  const queued = await h.request('/api/guest-submissions', { method: 'POST', payload: guestTopic });
  assert.equal(queued.status, 202);
  const listing = await h.request('/api/admin/guest-submissions', { moderator: true });
  assert.equal(listing.status, 200);
  assert.equal(listing.data.submissions.length, 1);
  assert.equal((await h.request('/api/admin/agents', { moderator: true })).status, 401);
  const approved = await h.request('/api/admin/guest-submissions/' + queued.data.submission.id + '/approve', { method: 'POST', moderator: true });
  assert.equal(approved.status, 200);
});

test('failed publication insert rolls back guest approval status atomically', async t => {
  const h = harness(t);
  const queued = await h.request('/api/guest-submissions', { method: 'POST', payload: guestTopic });
  assert.equal(queued.status, 202);
  const id = queued.data.submission.id;
  h.sql.prepare("INSERT INTO topics(id,title,content,tags,author_id,author_name,created_at,hidden) VALUES(?,?,?,'[]','test','Test','2026-11-01T00:00:00Z',0)")
    .run('guest-' + id, 'Conflicting ID', 'Synthetic collision');
  const failed = await h.request('/api/admin/guest-submissions/' + id + '/approve', { method: 'POST', admin: true });
  assert.equal(failed.status, 500);
  assert.equal(h.sql.prepare('SELECT status FROM guest_submissions WHERE id=?').get(id).status, 'pending');
  assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM topics WHERE id=?").get('guest-' + id).n, 1);
});
