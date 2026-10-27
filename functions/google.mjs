// Google Identity Services ID tokens. The client id is public.
// The signature is checked here so a stolen cookie is the only session.

const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

let certCache = { exp: 0, keys: [] };

export function validClientId(value) {
  return /^[0-9]+-[0-9A-Za-z_-]+\.apps\.googleusercontent\.com$/.test(String(value || ''));
}

function b64urlToBytes(value) {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const text = atob(b64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}

function readJson(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function googleCerts(fetchFn, force) {
  const now = Date.now();
  if (!force && certCache.keys.length && certCache.exp > now) return certCache.keys;
  const response = await fetchFn(CERTS_URL);
  if (!response.ok) return certCache.keys;
  const data = await response.json();
  const cacheControl = typeof response.headers?.get === 'function'
    ? response.headers.get('cache-control') || ''
    : '';
  const match = /max-age=(\d+)/.exec(cacheControl);
  const maxAge = match ? Number(match[1]) : 3600;
  certCache = { exp: now + maxAge * 1000, keys: data.keys || [] };
  return certCache.keys;
}

function audienceOk(payload, clientId) {
  const aud = payload.aud;
  if (aud === clientId) return true;
  return Array.isArray(aud) && aud.includes(clientId);
}

function payloadOk(payload, clientId, nowSec) {
  if (!payload || typeof payload.sub !== 'string' || !payload.sub) return false;
  if (!audienceOk(payload, clientId)) return false;
  if (!ISSUERS.has(payload.iss)) return false;
  if (typeof payload.exp !== 'number' || payload.exp < nowSec - 60) return false;
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec + 60) return false;
  if (payload.email && payload.email_verified !== true && payload.email_verified !== 'true') return false;
  return true;
}

async function signatureOk(token, keys) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const header = readJson(b64urlToBytes(parts[0]));
    if (!header || header.alg !== 'RS256' || !header.kid) return null;
    const jwk = keys.find((key) => key && key.kid === header.kid);
    if (!jwk) return null;
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return null;
    return readJson(b64urlToBytes(parts[1]));
  } catch (_) {
    return null;
  }
}

export async function verifyGoogleIdToken(token, clientId, options = {}) {
  if (!validClientId(clientId) || !token) return null;
  const nowSec = options.now ?? Math.floor(Date.now() / 1000);
  const keys = options.keys || await googleCerts(options.fetchFn || fetch, false);
  let payload = await signatureOk(token, keys);
  if (!payload && !options.keys) {
    const fresh = await googleCerts(options.fetchFn || fetch, true);
    payload = await signatureOk(token, fresh);
  }
  if (!payloadOk(payload, clientId, nowSec)) return null;
  return payload;
}
