// Accounts and the best-net-worth board.
// PBKDF2 stays modest because Pages Functions have a short CPU budget.
// These passwords only protect a game name.

const PBKDF2_ITERATIONS = 8000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const NET_LIMIT = 1e12;
const WEEK_LIMIT = 200000;

export function normalizeName(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  const chars = Array.from(name);
  if (chars.length < 2 || chars.length > 16 || !/^[\p{L}\p{N} ]+$/u.test(name)) {
    return { ok: false, error: 'name' };
  }
  return { ok: true, name, key: name.toLocaleLowerCase() };
}

export function checkPassword(raw) {
  const password = String(raw ?? '');
  if (password.length < 4 || password.length > 64) return { ok: false, error: 'password' };
  return { ok: true, password };
}

function bytesToB64(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function b64ToBytes(value) {
  const text = atob(value);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes) {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hashPassword(password, saltBytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return bytesToB64(new Uint8Array(bits));
}

async function sha256Hex(text) {
  const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(bits));
}

function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function ensureSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    player_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS bests (
    player_id INTEGER PRIMARY KEY,
    net_worth INTEGER NOT NULL,
    weeks INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
}

async function playerFromToken(db, token) {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  return db.prepare(`SELECT p.id, p.name, p.name_key
    FROM sessions s
    JOIN players p ON p.id = s.player_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(tokenHash, Date.now()).first();
}

async function bestFor(db, playerId) {
  return db.prepare('SELECT net_worth, weeks, updated_at FROM bests WHERE player_id = ?')
    .bind(playerId).first();
}

async function openSession(db, playerId) {
  const token = newToken();
  const tokenHash = await sha256Hex(token);
  await db.prepare('INSERT INTO sessions (token_hash, player_id, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, playerId, Date.now() + SESSION_MS)
    .run();
  return token;
}

function publicPlayer(player, best) {
  return {
    name: player.name,
    best: best ? best.net_worth : null,
    weeks: best ? best.weeks : null
  };
}

export function createBoard(db) {
  return {
    async register(rawName, rawPassword) {
      const name = normalizeName(rawName);
      if (!name.ok) return { status: 400, body: { error: name.error } };
      const password = checkPassword(rawPassword);
      if (!password.ok) return { status: 400, body: { error: password.error } };
      const taken = await db.prepare('SELECT id FROM players WHERE name_key = ?').bind(name.key).first();
      if (taken) return { status: 409, body: { error: 'taken' } };
      const salt = new Uint8Array(16);
      crypto.getRandomValues(salt);
      const passHash = await hashPassword(password.password, salt);
      try {
        await db.prepare(
          'INSERT INTO players (name, name_key, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(name.name, name.key, passHash, bytesToB64(salt), Date.now()).run();
      } catch (err) {
        if (String(err && err.message || err).toLowerCase().includes('unique')) {
          return { status: 409, body: { error: 'taken' } };
        }
        throw err;
      }
      const player = await db.prepare('SELECT id, name, name_key FROM players WHERE name_key = ?')
        .bind(name.key).first();
      const token = await openSession(db, player.id);
      return { status: 200, token, body: publicPlayer(player, null) };
    },

    async login(rawName, rawPassword) {
      const name = normalizeName(rawName);
      const password = checkPassword(rawPassword);
      if (!name.ok || !password.ok) return { status: 401, body: { error: 'credentials' } };
      const player = await db.prepare(
        'SELECT id, name, name_key, pass_hash, pass_salt FROM players WHERE name_key = ?'
      ).bind(name.key).first();
      if (!player) return { status: 401, body: { error: 'credentials' } };
      const hash = await hashPassword(password.password, b64ToBytes(player.pass_salt));
      if (!safeEqual(hash, player.pass_hash)) return { status: 401, body: { error: 'credentials' } };
      const token = await openSession(db, player.id);
      const best = await bestFor(db, player.id);
      return { status: 200, token, body: publicPlayer(player, best) };
    },

    async logout(token) {
      if (token) {
        const tokenHash = await sha256Hex(token);
        await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
      }
      return { status: 200, clear: true, body: { name: null } };
    },

    async me(token) {
      const player = await playerFromToken(db, token);
      if (!player) return { status: 200, body: { name: null } };
      const best = await bestFor(db, player.id);
      return { status: 200, body: publicPlayer(player, best) };
    },

    async postBest(token, payload) {
      const player = await playerFromToken(db, token);
      if (!player) return { status: 401, body: { error: 'credentials' } };
      const netWorth = Math.round(Number(payload && payload.netWorth));
      const weeks = Math.round(Number(payload && payload.weeks));
      if (!Number.isFinite(netWorth) || netWorth < -NET_LIMIT || netWorth > NET_LIMIT) {
        return { status: 400, body: { error: 'score' } };
      }
      const storedWeeks = Number.isFinite(weeks) ? Math.min(WEEK_LIMIT, Math.max(0, weeks)) : 0;
      const current = await bestFor(db, player.id);
      if (current && current.net_worth >= netWorth) {
        return { status: 200, body: { best: current.net_worth, weeks: current.weeks, improved: false } };
      }
      const now = Date.now();
      if (current) {
        await db.prepare('UPDATE bests SET net_worth = ?, weeks = ?, updated_at = ? WHERE player_id = ?')
          .bind(netWorth, storedWeeks, now, player.id).run();
      } else {
        await db.prepare('INSERT INTO bests (player_id, net_worth, weeks, updated_at) VALUES (?, ?, ?, ?)')
          .bind(player.id, netWorth, storedWeeks, now).run();
      }
      return { status: 200, body: { best: netWorth, weeks: storedWeeks, improved: true } };
    },

    async board(token) {
      const listed = await db.prepare(`SELECT p.id AS player_id, p.name, b.net_worth, b.weeks
        FROM bests b
        JOIN players p ON p.id = b.player_id
        ORDER BY b.net_worth DESC, b.updated_at ASC, p.id ASC
        LIMIT 20`).all();
      const rows = listed.results || [];
      const player = await playerFromToken(db, token);
      const leaders = rows.map((row, index) => ({
        rank: index + 1,
        name: row.name,
        netWorth: row.net_worth,
        weeks: row.weeks,
        you: !!(player && row.player_id === player.id)
      }));
      let you = null;
      if (player) {
        const best = await bestFor(db, player.id);
        const onBoard = leaders.find((row) => row.you);
        if (onBoard) {
          you = { rank: onBoard.rank, name: player.name, netWorth: onBoard.netWorth, weeks: onBoard.weeks };
        } else if (best) {
          const ahead = await db.prepare(`SELECT COUNT(*) AS n FROM bests
            WHERE net_worth > ?
              OR (net_worth = ? AND updated_at < ?)
              OR (net_worth = ? AND updated_at = ? AND player_id < ?)`)
            .bind(
              best.net_worth,
              best.net_worth, best.updated_at || 0,
              best.net_worth, best.updated_at || 0, player.id
            ).first();
          you = {
            rank: Number(ahead && ahead.n || 0) + 1,
            name: player.name,
            netWorth: best.net_worth,
            weeks: best.weeks
          };
        } else {
          you = { rank: null, name: player.name, netWorth: null, weeks: null };
        }
      }
      return { status: 200, body: { leaders, you } };
    }
  };
}
