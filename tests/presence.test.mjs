import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoard, ensureSchema } from '../functions/_board.mjs';
import { handleRequest } from '../functions/http.mjs';
import { openBoardDb } from '../scripts/sqlite-d1.mjs';

const ADA = 'a'.repeat(32);
const BEA = 'b'.repeat(32);
const CAM = 'c'.repeat(32);

async function open() {
  const db = openBoardDb();
  await ensureSchema(db);
  return { db, api: createBoard(db) };
}

test('a check-in counts people heard from in the last minute', async () => {
  const { db, api } = await open();
  const first = await api.here('', ADA);
  assert.equal(first.body.online, 1);
  const second = await api.here('', BEA);
  assert.equal(second.body.online, 2);
  const again = await api.here('', ADA);
  assert.equal(again.body.online, 2);

  await db.prepare('UPDATE presence SET seen_at = ? WHERE visitor_id = ?')
    .bind(Date.now() - 120000, ADA).run();
  const later = await api.here('', BEA);
  assert.equal(later.body.online, 1);
  assert.equal((await api.here('', 'nope')).status, 400);
});

test('a note reaches one account or one browser', async () => {
  const { api } = await open();
  const ada = await api.register('Ada', 'copper');
  const named = await api.leaveNote({ name: 'Ada', text: 'Your copper is ready.' });
  assert.equal(named.status, 200);

  const hers = await api.here(ada.token, ADA);
  assert.equal(hers.body.note.text, 'Your copper is ready.');
  const stranger = await api.here('', BEA);
  assert.equal(stranger.body.note, null);

  const direct = await api.leaveNote({ visitor: CAM, text: 'The lake road is clear.' });
  assert.equal(direct.status, 200);
  const cam = await api.here('', CAM);
  assert.equal(cam.body.note.text, 'The lake road is clear.');
  assert.equal((await api.here(ada.token, ADA)).body.note.text, 'Your copper is ready.');

  assert.equal((await api.leaveNote({ text: 'nobody' })).status, 400);
  assert.equal((await api.leaveNote({ name: 'Missing', text: 'hi' })).status, 404);
});

test('leaving a note needs the private key', async () => {
  const { db } = await open();
  const body = JSON.stringify({ name: 'Ada', text: 'Hello' });
  const locked = await handleRequest(
    new Request('https://cashforcopper.us/api/note', { method: 'POST', body }),
    db,
    {}
  );
  assert.equal(locked.status, 503);

  const wrong = await handleRequest(
    new Request('https://cashforcopper.us/api/note', {
      method: 'POST',
      headers: { 'x-c4c-note-key': 'nope' },
      body
    }),
    db,
    { C4C_NOTE_KEY: 'right-key' }
  );
  assert.equal(wrong.status, 401);

  await createBoard(db).register('Ada', 'copper');
  const ok = await handleRequest(
    new Request('https://cashforcopper.us/api/note', {
      method: 'POST',
      headers: { 'x-c4c-note-key': 'right-key', origin: 'https://cashforcopper.us' },
      body
    }),
    db,
    { C4C_NOTE_KEY: 'right-key' }
  );
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
});
