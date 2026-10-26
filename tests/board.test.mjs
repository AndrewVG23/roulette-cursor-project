import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoard, ensureSchema, normalizeName } from '../functions/_board.mjs';
import { openBoardDb } from '../scripts/sqlite-d1.mjs';

async function board() {
  const db = openBoardDb();
  await ensureSchema(db);
  return createBoard(db);
}

test('names are short and readable', () => {
  assert.equal(normalizeName('  Ada   B ').name, 'Ada B');
  assert.equal(normalizeName('ada').key, 'ada');
  assert.equal(normalizeName('A').ok, false);
  assert.equal(normalizeName('nope<script>').ok, false);
  assert.equal(normalizeName('x'.repeat(17)).ok, false);
});

test('an account keeps its best net worth', async () => {
  const api = await board();
  const created = await api.register('Ada', 'copper');
  assert.equal(created.status, 200);
  assert.equal(created.body.name, 'Ada');

  const taken = await api.register('ada', 'other');
  assert.equal(taken.status, 409);

  const low = await api.postBest(created.token, { netWorth: -9900, weeks: 0 });
  assert.equal(low.body.best, -9900);
  const high = await api.postBest(created.token, { netWorth: 2400, weeks: 30 });
  assert.equal(high.body.improved, true);
  const drop = await api.postBest(created.token, { netWorth: 100, weeks: 40 });
  assert.equal(drop.body.best, 2400);
  assert.equal(drop.body.improved, false);

  const wrong = await api.login('Ada', 'nope');
  assert.equal(wrong.status, 401);
  const again = await api.login('Ada', 'copper');
  assert.equal(again.body.best, 2400);

  const listed = await api.board(again.token);
  assert.equal(listed.body.leaders[0].name, 'Ada');
  assert.equal(listed.body.leaders[0].netWorth, 2400);
  assert.equal(listed.body.leaders[0].you, true);
  assert.equal(listed.body.you.rank, 1);

  await api.logout(again.token);
  const me = await api.me(again.token);
  assert.equal(me.body.name, null);
});

test('the richer purse ranks first', async () => {
  const api = await board();
  const ada = await api.register('Ada', 'copper');
  const bea = await api.register('Bea', 'copper');
  await api.postBest(ada.token, { netWorth: 500, weeks: 4 });
  await api.postBest(bea.token, { netWorth: 8000, weeks: 12 });
  const listed = await api.board('');
  assert.deepEqual(listed.body.leaders.map((row) => row.name), ['Bea', 'Ada']);
  assert.equal(listed.body.you, null);
});
