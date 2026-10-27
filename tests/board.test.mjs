import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoard, ensureSchema, googleBoardName, normalizeName } from '../functions/_board.mjs';
import { handleRequest } from '../functions/http.mjs';
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

test('google sign-in keeps one player and a readable name', async () => {
  assert.equal(googleBoardName({ name: 'Andrew Van Gilder', given_name: 'Andrew' }), 'Andrew');
  assert.equal(googleBoardName({ name: 'Ada Lovelace' }), 'Ada Lovelace');
  assert.equal(googleBoardName({ email: 'a.b@example.com' }), 'a b');
  assert.equal(googleBoardName({}), 'Player');

  const db = openBoardDb();
  await ensureSchema(db);
  await ensureSchema(db);
  const api = createBoard(db);
  await api.register('Andrew', 'copper');

  const created = await api.signInGoogle({ sub: '1001', name: 'Andrew Van Gilder', given_name: 'Andrew' });
  assert.equal(created.status, 200);
  assert.equal(created.body.name, 'Andrew 2');
  const posted = await api.postBest(created.token, { netWorth: 1200, weeks: 3 });
  assert.equal(posted.body.improved, true);

  const again = await api.signInGoogle({ sub: '1001', name: 'Andrew Van Gilder' });
  assert.equal(again.body.name, 'Andrew 2');
  assert.equal(again.body.best, 1200);

  const password = await api.login('Andrew 2', 'copper');
  assert.equal(password.status, 401);

  const clientId = '1000000000-cash.apps.googleusercontent.com';
  const missing = await handleRequest(
    new Request('https://cashforcopper.us/api/google-config'),
    db,
    {}
  );
  assert.deepEqual(await missing.json(), { clientId: null });

  const config = await handleRequest(
    new Request('https://cashforcopper.us/api/google-config'),
    db,
    { GOOGLE_CLIENT_ID: clientId }
  );
  assert.deepEqual(await config.json(), { clientId });

  const signed = await handleRequest(
    new Request('https://cashforcopper.us/api/google', {
      method: 'POST',
      headers: { origin: 'https://cashforcopper.us', 'content-type': 'application/json' },
      body: JSON.stringify({ credential: 'token' })
    }),
    db,
    { GOOGLE_CLIENT_ID: clientId },
    { verifyGoogleIdToken: async () => ({ sub: '2002', name: 'Bea' }) }
  );
  assert.equal(signed.status, 200);
  assert.equal((await signed.json()).name, 'Bea');
  assert.match(signed.headers.get('set-cookie'), /c4c_session=/);

  const rejected = await handleRequest(
    new Request('https://cashforcopper.us/api/google', {
      method: 'POST',
      headers: { origin: 'https://cashforcopper.us', 'content-type': 'application/json' },
      body: JSON.stringify({ credential: 'nope' })
    }),
    db,
    { GOOGLE_CLIENT_ID: clientId },
    { verifyGoogleIdToken: async () => null }
  );
  assert.equal(rejected.status, 401);
});

test('a password can differ from the name', async () => {
  const api = await board();
  const created = await api.register('Nora', 'river');
  assert.equal(created.status, 200);
  assert.equal((await api.login('Nora', 'Nora')).status, 401);
  assert.equal((await api.login('Nora', 'river')).status, 200);
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
