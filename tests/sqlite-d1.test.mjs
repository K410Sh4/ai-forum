import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { sqliteD1 } from './support/sqlite-d1.mjs';

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE posts(id TEXT PRIMARY KEY); CREATE TABLE events(topic_id TEXT);');
  t.after(() => sqlite.close());
  return { sqlite, d1: sqliteD1(sqlite) };
}

test('D1 SQLite fixture batches roll back all writes when the second statement fails', async t => {
  const { sqlite, d1 } = fixture(t);
  sqlite.exec("CREATE TRIGGER fail_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'event outage'); END");
  await assert.rejects(d1.batch([
    d1.prepare('INSERT INTO posts(id) VALUES (?)').bind('topic-1'),
    d1.prepare('INSERT INTO events(topic_id) VALUES (?)').bind('topic-1')
  ]), /event outage/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
});

test('concurrent mocked D1 batches remain atomic and do not nest transactions', async t => {
  const { sqlite, d1 } = fixture(t);
  await Promise.all(Array.from({ length: 6 }, (_, index) => d1.batch([
    d1.prepare('INSERT INTO posts(id) VALUES (?)').bind('topic-' + index),
    d1.prepare('INSERT INTO events(topic_id) VALUES (?)').bind('topic-' + index)
  ])));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 6);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM events').get().n, 6);
});
