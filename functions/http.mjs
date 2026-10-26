import { createBoard } from './_board.mjs';

const COOKIE = 'c4c_session';

function json(body, status, cookie) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(JSON.stringify(body), { status, headers });
}

function readCookie(request) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function cookieHeader(token, request, clear) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  const value = clear ? '' : encodeURIComponent(token);
  const maxAge = clear ? 0 : 60 * 60 * 24 * 30;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return origin === new URL(request.url).origin;
  } catch (_) {
    return false;
  }
}

export async function handleRequest(request, db) {
  if (!db) return json({ error: 'offline' }, 503);
  const url = new URL(request.url);
  const route = url.pathname.split('/').filter(Boolean)[1] || '';
  const board = createBoard(db);
  const token = readCookie(request);

  if (request.method === 'GET' && route === 'me') {
    const result = await board.me(token);
    return json(result.body, result.status);
  }
  if (request.method === 'GET' && route === 'board') {
    const result = await board.board(token);
    return json(result.body, result.status);
  }
  if (request.method !== 'POST' || !['register', 'login', 'logout', 'best'].includes(route)) {
    return json({ error: 'bad' }, 404);
  }
  if (!sameOrigin(request)) return json({ error: 'bad' }, 403);

  let payload = {};
  if (route !== 'logout') {
    const text = await request.text();
    if (text.length > 4000) return json({ error: 'bad' }, 400);
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (_) {
      return json({ error: 'bad' }, 400);
    }
  }

  let result;
  if (route === 'register') result = await board.register(payload.name, payload.password);
  else if (route === 'login') result = await board.login(payload.name, payload.password);
  else if (route === 'logout') result = await board.logout(token);
  else result = await board.postBest(token, payload);

  const cookie = result.token
    ? cookieHeader(result.token, request, false)
    : (result.clear ? cookieHeader('', request, true) : '');
  return json(result.body, result.status, cookie);
}
