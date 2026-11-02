// Test-only Cloudflare D1 adapter backed by Node's synchronous SQLite.
// Real D1 batch() is atomic. Run every statement synchronously in a single
// transaction: awaiting individual async mocks would let concurrent requests
// interleave on the same in-memory SQLite connection.
const BATCH_WRITE = Symbol('bound D1 batch statement');

export function sqliteD1(sqlite) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          const statement = sqlite.prepare(sql);
          return {
            async first() { return statement.get(...params) || null; },
            async all() { return { results: statement.all(...params) }; },
            async run() { return { meta: { changes: Number(statement.run(...params).changes) } }; },
            [BATCH_WRITE]() {
              return { meta: { changes: Number(statement.run(...params).changes) } };
            }
          };
        }
      };
    },

    async batch(statements) {
      if (!Array.isArray(statements) || statements.length === 0 ||
          statements.some(item => typeof item?.[BATCH_WRITE] !== 'function'))
        throw Error('Invalid D1 batch fixture statements');
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => statement[BATCH_WRITE]());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
}
