import test from 'node:test';
import assert from 'node:assert/strict';
import { writeWithEvent, visibleEventWindow } from '../cloudflare/publication-integrity.mjs';

function d1Stub(visibleIds = []) {
  const records = { batches: [], lookupIds: [] };
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            sql, args,
            async all() {
              records.lookupIds = args;
              return { results: visibleIds.map(id => ({ id })) };
            }
          };
        }
      };
    },
    async batch(statements) {
      records.batches.push(statements);
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
    }
  };
  return { db, records };
}

test('topic or reply publication and event use the same transactional D1 batch', async () => {
  const { db, records } = d1Stub();
  const statement = { sql: 'INSERT INTO topics ...', args: ['topic-a'] };
  await writeWithEvent(db, statement, 'topic.created',
    { topicId: 'topic-a', title: 'A valid title' }, '2026-11-02T12:00:00.000Z');
  assert.equal(records.batches.length, 1);
  assert.equal(records.batches[0].length, 2);
  assert.equal(records.batches[0][0], statement);
  assert.match(records.batches[0][1].sql, /INSERT INTO events/);
  assert.deepEqual(records.batches[0][1].args, [
    'topic.created', JSON.stringify({ topicId: 'topic-a', title: 'A valid title' }),
    '2026-11-02T12:00:00.000Z'
  ]);
});

test('publication refuses missing or incomplete transactional results', async () => {
  const { db } = d1Stub();
  db.batch = async () => [{ meta: { changes: 1 } }, { meta: { changes: 0 } }];
  await assert.rejects(writeWithEvent(db, {}, 'topic.created', {}, '2026-11-02'), /exactly once/);
  db.batch = async () => { throw Error('simulated D1 event failure'); };
  await assert.rejects(writeWithEvent(db, {}, 'topic.created', {}, '2026-11-02'), /D1 event failure/);
});

test('event feed hides moderated topic metadata and advances across hidden rows', async () => {
  const { db, records } = d1Stub(['visible-topic']);
  const rows = [
    { seq: 10, type: 'topic.created', at: '2026-11-02T00:00:00Z',
      payload: JSON.stringify({ topicId: 'hidden-topic', title: 'Sensitive title' }) },
    { seq: 11, type: 'topic.created', at: '2026-11-02T00:01:00Z',
      payload: JSON.stringify({ topicId: 'visible-topic', title: 'Safe title' }) },
    { seq: 12, type: 'other.event', at: '2026-11-02T00:02:00Z',
      payload: JSON.stringify({ status: 'ok', seq: 9999 }) }
  ];
  const window = await visibleEventWindow(db, rows);
  assert.deepEqual(records.lookupIds, ['hidden-topic', 'visible-topic']);
  assert.deepEqual(window.events.map(entry => entry.seq), [11, 12]);
  assert.equal(window.events[0].title, 'Safe title');
  assert.equal(window.events[1].seq, 12);
  assert.equal(window.nextAfter, 12);
  assert.ok(!JSON.stringify(window).includes('Sensitive title'));
});

test('empty event feed does not issue unnecessary topic queries', async () => {
  const { db } = d1Stub();
  db.prepare = () => { throw Error('unexpected query'); };
  assert.deepEqual(await visibleEventWindow(db, []), { events: [], nextAfter: null });
});
