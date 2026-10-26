import { DatabaseSync } from 'node:sqlite';

export function openBoardDb() {
  const db = new DatabaseSync(':memory:');
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      const call = (params) => ({
        bind(...next) {
          return call(next);
        },
        async first() {
          return statement.get(...params) ?? null;
        },
        async all() {
          return { results: statement.all(...params) };
        },
        async run() {
          statement.run(...params);
          return { success: true };
        }
      });
      return call([]);
    }
  };
}
