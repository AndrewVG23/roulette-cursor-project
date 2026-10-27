import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { verifyGoogleIdToken } from '../functions/google.mjs';

const CLIENT = '1000000000-cash.apps.googleusercontent.com';

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(privateKey, payload) {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: 'test', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const signature = createSign('RSA-SHA256').update(data).sign(privateKey);
  return `${data}.${Buffer.from(signature).toString('base64url')}`;
}

function keysFor(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  jwk.kid = 'test';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return [jwk];
}

test('a google id token must be signed for this site', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keys = keysFor(publicKey);
  const now = 1_800_000_000;
  const token = sign(privateKey, {
    iss: 'https://accounts.google.com',
    aud: CLIENT,
    sub: '4242',
    email: 'ada@example.com',
    email_verified: true,
    exp: now + 600,
    name: 'Ada'
  });
  const ok = await verifyGoogleIdToken(token, CLIENT, { keys, now });
  assert.equal(ok.sub, '4242');
  assert.equal(ok.email, 'ada@example.com');

  const other = sign(privateKey, {
    iss: 'https://accounts.google.com',
    aud: '999-other.apps.googleusercontent.com',
    sub: '4242',
    exp: now + 600
  });
  assert.equal(await verifyGoogleIdToken(other, CLIENT, { keys, now }), null);

  const expired = sign(privateKey, {
    iss: 'https://accounts.google.com',
    aud: CLIENT,
    sub: '4242',
    exp: now - 600
  });
  assert.equal(await verifyGoogleIdToken(expired, CLIENT, { keys, now }), null);

  const unverified = sign(privateKey, {
    iss: 'https://accounts.google.com',
    aud: CLIENT,
    sub: '4242',
    email: 'ada@example.com',
    email_verified: false,
    exp: now + 600
  });
  assert.equal(await verifyGoogleIdToken(unverified, CLIENT, { keys, now }), null);

  const flipped = token.slice(0, -2) + (token.endsWith('a') ? 'b' : 'a');
  assert.equal(await verifyGoogleIdToken(flipped, CLIENT, { keys, now }), null);
});
