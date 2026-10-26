// Attach the leaderboard D1 database before a Pages deploy.
// If Cloudflare cannot create it, the games still deploy and the board stays offline.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tomlPath = fileURLToPath(new URL('../wrangler.toml', import.meta.url));
const DB_NAME = 'cashforcopper-board';

function wrangler(args) {
  return spawnSync('npx', ['wrangler', ...args], { cwd: root, encoding: 'utf8' });
}

function readList(stdout) {
  const start = String(stdout || '').indexOf('[');
  if (start < 0) return [];
  try {
    const parsed = JSON.parse(stdout.slice(start));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function writeBinding(id) {
  const toml = fs.readFileSync(tomlPath, 'utf8')
    .replace(/\n*\[\[d1_databases\]\][\s\S]*$/, '')
    .trimEnd();
  fs.writeFileSync(tomlPath, `${toml}

[[d1_databases]]
binding = "DB"
database_name = "${DB_NAME}"
database_id = "${id}"
`);
}

let id = '';
const listed = wrangler(['d1', 'list', '--json']);
if (listed.status === 0) {
  const found = readList(listed.stdout).find((row) => row.name === DB_NAME);
  id = found && (found.uuid || found.database_id || '');
}

if (!id) {
  const created = wrangler(['d1', 'create', DB_NAME, '--location', 'enam']);
  const blob = `${created.stdout || ''}\n${created.stderr || ''}`;
  const match = blob.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (created.status === 0 && match) id = match[0];
  if (!id) {
    console.error('Leaderboard database was not attached. The games will still deploy.');
    process.exit(0);
  }
}

writeBinding(id);
console.log('Leaderboard database ready.');
