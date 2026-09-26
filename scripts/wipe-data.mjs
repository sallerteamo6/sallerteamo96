// DESTRUCTIVE: wipe user/business data from a Supabase project.
//
// Usage:
//   $env:SUPABASE_URL = 'https://xxxx.supabase.co'
//   $env:SUPABASE_SERVICE_KEY = 'eyJ...'
//   node scripts/wipe-data.mjs --dry-run     # report only
//   node scripts/wipe-data.mjs --confirm     # actually delete
//
// Credentials come from the environment only. The service_role key bypasses
// RLS entirely, so it is never read from a file in the repository.
//
// Table names come from PostgREST's OpenAPI document rather than being
// hardcoded, so the same script works against both the v1 and v2 layouts, and
// deletes use a "not.is.null" filter on a NOT NULL column, which matches every
// row regardless of that column's type.
//
// Keeps coin_addresses. Everything else is emptied. Every step is verified
// afterwards and the script exits non-zero if any table is not empty.
//
// Take a backup first:  node scripts/backup.mjs

import { readFileSync } from 'node:fs';

const url = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/*$/, '').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_KEY || '';
const confirm = process.argv.includes('--confirm');
const dryRun = !confirm;

if (!url || !key) {
  console.error('Set both environment variables first:');
  console.error("  $env:SUPABASE_URL = 'https://xxxx.supabase.co'");
  console.error("  $env:SUPABASE_SERVICE_KEY = 'eyJ...'");
  process.exit(1);
}

// Discovered from the live schema, so unknown tables are handled too.
const KEEP = ['coin_addresses'];

async function req(path, method, extra = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: 'Bearer ' + key, ...extra },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

// Discover a NOT NULL column per table so the delete filter is always valid.
let specCache = null;
async function getSpec() {
  if (!specCache) specCache = await (await req('/', 'GET', { Accept: 'application/openapi+json' })).json();
  return specCache;
}

const count = async (t) => Number((await req(`${t}?select=*`, 'HEAD', { Prefer: 'count=exact' }))
  .headers.get('content-range')?.split('/')[1] ?? -1);

console.log(`Target : ${url}`);
console.log(`Mode   : ${dryRun ? 'DRY RUN (nothing will be deleted)' : 'LIVE — DELETING DATA'}\n`);

const spec = await getSpec();
const known = new Set(Object.keys(spec.definitions || {}).filter((d) => !d.startsWith('pg_')));
// Everything present except the tables we keep. Deriving the list means a table
// added after this script was written is still wiped rather than silently
// surviving with its rows intact.
const WIPE = [...known].filter((t) => !KEEP.includes(t)).sort();

const before = {};
for (const t of WIPE) {
  if (!known.has(t)) { before[t] = 'n/a'; continue; }
  before[t] = await count(t);
}
for (const t of KEEP) before[t] = await count(t);
console.log('Row counts before:');
for (const t of WIPE) {
  if (before[t] === 'n/a') { console.log(`  WIPE  ${t.padEnd(16)} table not present`); continue; }
  console.log(`  WIPE  ${t.padEnd(16)} ${before[t]}`);
}
for (const t of KEEP) console.log(`  keep  ${t.padEnd(16)} ${before[t]}`);

if (dryRun) {
  console.log('\nDry run complete. Re-run with --confirm to delete.');
  process.exit(0);
}

console.log('\nDeleting...');
for (const t of WIPE) {
  if (!known.has(t) || before[t] === 0) { console.log(`  skip  ${t}`); continue; }
  const col = await (async () => {
    const props = spec.definitions[t].properties;
    const nn = Object.entries(props).filter(([, p]) => p.nullable === false).map(([c]) => c);
    return nn[0] || Object.keys(props)[0];
  })();
  await req(`${t}?${col}=not.is.null`, 'DELETE', { Prefer: 'return=minimal' });
  console.log(`  wipe  ${t} (filter ${col}=not.is.null)`);
}

console.log('\nVerifying...');
let bad = 0;
for (const t of WIPE) {
  if (!known.has(t)) continue;
  const c = await count(t);
  if (c !== 0) bad++;
  console.log(`  ${c === 0 ? 'OK  ' : 'FAIL'} ${t.padEnd(16)} ${c} rows`);
}
for (const t of KEEP) {
  const c = await count(t);
  if (c !== before[t]) bad++;
  console.log(`  ${c === before[t] ? 'OK  ' : 'FAIL'} ${t.padEnd(16)} ${c} rows (preserved)`);
}

console.log(bad === 0
  ? '\nWipe complete and verified.'
  : `\n${bad} check(s) FAILED.`);
process.exit(bad === 0 ? 0 : 1);
