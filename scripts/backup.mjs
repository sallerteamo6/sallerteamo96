// Full backup of a Supabase project to a single JSON file. Read-only.
//
// Usage:
//   $env:SUPABASE_URL = 'https://xxxx.supabase.co'
//   $env:SUPABASE_SERVICE_KEY = 'eyJ...'
//   node scripts/backup.mjs [outfile.json]
//
// Table names and columns are discovered from PostgREST's OpenAPI document
// rather than hardcoded, so a table added after this script was written is
// still captured.
//
// Exits non-zero if any table cannot be read, so a partial backup can never be
// mistaken for a complete one. Restore with scripts/restore.mjs.

import { readFileSync, writeFileSync } from 'node:fs';

const url = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/*$/, '').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_KEY || '';

if (!url || !key) {
  console.error('Set both environment variables first:');
  console.error("  $env:SUPABASE_URL = 'https://xxxx.supabase.co'");
  console.error("  $env:SUPABASE_SERVICE_KEY = 'eyJ...'");
  process.exit(1);
}

const req = (path, extra = {}) => fetch(`${url}/rest/v1/${path}`, {
  headers: { apikey: key, Authorization: 'Bearer ' + key, ...extra },
});

const specRes = await req('/', { Accept: 'application/openapi+json' });
if (!specRes.ok) {
  console.error(`Could not read the schema: HTTP ${specRes.status}`);
  process.exit(1);
}
const TABLES = Object.keys((await specRes.json()).definitions || {})
  .filter((d) => !d.startsWith('pg_'))
  .sort();
console.log(`Discovered ${TABLES.length} tables\n`);

async function getAll(table) {
  const rows = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const res = await req(`${table}?select=*&limit=${page}&offset=${offset}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${table}: ${(await res.text()).slice(0, 200)}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < page) break;
  }
  return rows;
}

const data = {};
const counts = {};
let failed = false;

for (const t of TABLES) {
  try {
    const rows = await getAll(t);
    data[t] = rows;
    counts[t] = rows.length;
    console.log(`  ${t.padEnd(24)} ${rows.length}`);
  } catch (e) {
    console.error(`  ${t.padEnd(24)} FAILED: ${e.message}`);
    data[t] = null;
    counts[t] = null;
    failed = true;
  }
}

if (failed) {
  console.error('\nABORT: at least one table could not be read. This backup is incomplete.');
  process.exit(1);
}

const stamp = new Date().toISOString();
const dump = {
  _meta: {
    created_at: stamp,
    source: url,
    tool: 'backup.mjs',
    note: 'Full dump. Contains real user data and session material: store it somewhere private and never commit it.',
    row_counts: counts,
    total_rows: Object.values(counts).reduce((a, b) => a + b, 0),
  },
  data,
};

const out = process.argv[2] || `backup-${stamp.slice(0, 10)}.json`;
writeFileSync(out, JSON.stringify(dump, null, 2));
console.log(`\nWrote ${out}  (${dump._meta.total_rows} rows total)`);
