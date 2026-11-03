import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.mjs';

function setup(t) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of fs.readdirSync(new URL('../cloudflare/migrations/', import.meta.url)).sort())
    sqlite.exec(fs.readFileSync(new URL('../cloudflare/migrations/' + name, import.meta.url), 'utf8'));
  const DB = {
    prepare(query) { return { bind(...args) {
      const q = sqlite.prepare(query);
      return {
        async first() { return q.get(...args) || null; },
        async all() { return { results: q.all(...args) }; },
        async run() { return { meta: { changes: Number(q.run(...args).changes) } }; }
      };
    } }; },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const statement of statements) out.push(await statement.run());
        sqlite.exec('COMMIT');
        return out;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  t.after(() => sqlite.close());
  const env = { DB, ADMIN_KEY: 'z'.repeat(64), GUEST_MODERATION_KEY: 'y'.repeat(64) };
  const post = async (path, payload) => worker.fetch(new Request('https://ai-forum.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.10' },
    body: JSON.stringify(payload)
  }), env);
  const count = table => sqlite.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
  return { sqlite, post, count };
}

test('public topic and quota entry roll back if its event insert fails', async t => {
  const h = setup(t);
  h.sqlite.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'event outage'); END;");
  const response = await h.post('/api/open/posts', {
    kind: 'topic', agent: 'Public Tester', model: 'Manual',
    title: 'Atomic event publication', content: 'Public text testing event transaction behavior.',
    acceptPolicy: true
  });
  assert.equal(response.status, 500);
  // Migrations seed the welcome topic; only a newly published record may vanish.
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM topics WHERE id<>'welcome'").get().n, 0);
  assert.equal(h.count('open_actions'), 0);
  assert.equal(h.count('events'), 0);
});

test('structured analysis and its ordinary topic roll back if event write fails', async t => {
  const h = setup(t);
  h.sqlite.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'event outage'); END;");
  const response = await h.post('/api/analyses', {
    kind: 'audit', title: 'Atomicity audit of discussion events',
    subject: 'Publication transaction',
    summary: 'We need publication and delivery events to have identical commit outcomes.',
    findings: 'The former implementation separated durable topic writes from event insertion.',
    proposal: 'Place the topic, analysis, rate-limit action and event into the same transactional batch.',
    agent: 'Public Auditor', model: 'Manual', acceptPolicy: true
  });
  assert.equal(response.status, 500);
  // Migrations seed the welcome topic; only a newly published record may vanish.
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM topics WHERE id<>'welcome'").get().n, 0);
  assert.equal(h.count('analyses'), 0);
  assert.equal(h.count('open_actions'), 0);
  assert.equal(h.count('events'), 0);
});

test('failed event insert can be retried once without ghost posts or spent quota', async t => {
  const h = setup(t);
  h.sqlite.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'event outage'); END;");
  const body = {
    kind: 'topic', agent: 'Auditor de integração', model: 'Manual',
    title: 'Reprocessamento com evento atômico',
    content: 'O primeiro envio deverá falhar sem alterar banco ou consumir cota; o segundo deverá criar uma única publicação.',
    acceptPolicy: true
  };
  const first = await h.post('/api/open/posts', body);
  assert.equal(first.status, 500);
  assert.equal(h.count('open_actions'), 0);
  assert.equal(h.count('events'), 0);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM topics WHERE id<>'welcome'").get().n, 0);
  h.sqlite.exec('DROP TRIGGER reject_event');
  const second = await h.post('/api/open/posts', body);
  assert.equal(second.status, 201, await second.text());
  assert.equal(h.count('open_actions'), 1);
  assert.equal(h.count('events'), 1);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM topics WHERE id<>'welcome'").get().n, 1);
  const duplicate = await h.post('/api/open/posts', body);
  assert.equal(duplicate.status, 409);
  assert.equal(h.count('events'), 1);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM topics WHERE id<>'welcome'").get().n, 1);
});
