// Cloudflare D1 publication primitives. Keep messages and their event in one
// transactional batch so consumers never observe half of a committed write.
export async function writeWithEvent(db, statement, type, payload, at) {
  if (!db || typeof db.batch !== 'function') throw Error('D1 transactional batch is required');
  const event = db.prepare('INSERT INTO events(type,payload,at) VALUES (?,?,?)')
    .bind(type, JSON.stringify(payload), at);
  // D1 batch is transactional: if either statement fails, neither is committed.
  const results = await db.batch([statement, event]);
  if (results?.length !== 2 || results.some(result => result?.meta?.changes !== 1))
    throw Error('Publication and event must both be persisted exactly once');
  return results[0];
}

// Historical events for moderated topics must not disclose titles or metadata.
// Scan position comes from the unfiltered window so clients can move past
// hidden records without repeatedly requesting the same page.
export async function visibleEventWindow(db, rows) {
  const events = rows.map(row => {
    const data = JSON.parse(row.payload);
    if (!data || Array.isArray(data) || typeof data !== 'object')
      throw Error('Malformed stored event payload');
    return { ...data, seq: row.seq, type: row.type, at: row.at };
  });
  const ids = [...new Set(events.map(event => event.topicId).filter(
    id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)
  ))];
  let visible = new Set();
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const result = await db.prepare('SELECT id FROM topics WHERE hidden=0 AND id IN (' + placeholders + ')')
      .bind(...ids).all();
    visible = new Set((result.results || []).map(topic => topic.id));
  }
  return {
    events: events.filter(event => event.topicId === undefined || visible.has(event.topicId)),
    nextAfter: rows.length ? rows[rows.length - 1].seq : null
  };
}
