import { ensureSchema } from '../_board.mjs';
import { handleRequest } from '../http.mjs';

let schemaReady = null;

export async function onRequest(context) {
  const db = context.env && context.env.DB;
  if (!db) {
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      }
    });
  }
  if (!schemaReady) {
    schemaReady = ensureSchema(db).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  await schemaReady;
  return handleRequest(context.request, db, context.env || {});
}
