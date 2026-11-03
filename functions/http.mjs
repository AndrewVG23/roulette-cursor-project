import { createBoard } from './_board.mjs';
import { validClientId, verifyGoogleIdToken } from './google.mjs';

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

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > 12000) return null;
  try {
    return text ? JSON.parse(text) : {};
  } catch (_) {
    return null;
  }
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

export async function handleRequest(request, db, env = {}, deps = {}) {
  if (!db) return json({ error: 'offline' }, 503);
  const url = new URL(request.url);
  const route = url.pathname.split('/').filter(Boolean)[1] || '';
  const board = createBoard(db);
  const token = readCookie(request);
  const rawClientId = String(env.GOOGLE_CLIENT_ID || '').trim();
  const clientId = validClientId(rawClientId) ? rawClientId : '';

  if (request.method === 'GET' && route === 'me') {
    const result = await board.me(token);
    return json(result.body, result.status);
  }
  if (request.method === 'GET' && route === 'board') {
    const result = await board.board(token);
    return json(result.body, result.status);
  }
  if (request.method === 'GET' && route === 'google-config') {
    return json({ clientId: clientId || null });
  }
  if (request.method === 'POST' && (route === 'here' || route === 'note')) {
    if (!sameOrigin(request)) return json({ error: 'bad' }, 403);
    const payload = await readJson(request);
    if (!payload || typeof payload !== 'object') return json({ error: 'bad' }, 400);
    if (route === 'here') {
      const result = await board.here(token, payload.visitor);
      return json(result.body, result.status);
    }
    const expected = String(env.C4C_NOTE_KEY || '');
    if (!expected) return json({ error: 'offline' }, 503);
    if (!safeEqual(request.headers.get('x-c4c-note-key') || '', expected)) {
      return json({ error: 'bad' }, 401);
    }
    const result = await board.leaveNote(payload);
    return json(result.body, result.status);
  }
  if (request.method !== 'POST' || !['register', 'login', 'logout', 'best', 'google'].includes(route)) {
    return json({ error: 'bad' }, 404);
  }
  if (!sameOrigin(request)) return json({ error: 'bad' }, 403);

  let payload = {};
  if (route !== 'logout') {
    const text = await request.text();
    if (text.length > 12000) return json({ error: 'bad' }, 400);
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
  else if (route === 'google') {
    if (!clientId) return json({ error: 'google' }, 503);
    const verify = deps.verifyGoogleIdToken || verifyGoogleIdToken;
    const profile = await verify(payload.credential, clientId);
    if (!profile) return json({ error: 'google' }, 401);
    result = await board.signInGoogle(profile);
  } else result = await board.postBest(token, payload);

  const cookie = result.token
    ? cookieHeader(result.token, request, false)
    : (result.clear ? cookieHeader('', request, true) : '');
  return json(result.body, result.status, cookie);
}
