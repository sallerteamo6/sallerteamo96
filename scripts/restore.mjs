// Restore a backup produced by the backup tool back into a Supabase project.
//
// Usage:
//   $env:SUPABASE_URL = 'https://xxxx.supabase.co'
//   $env:SUPABASE_SERVICE_KEY = 'eyJ...'
//   node scripts/restore.mjs supabase/pre-reset-backup-2026-09-26.json
//   node scripts/restore.mjs <file> --dry-run     # report only, write nothing
//
// Uses upsert (ON CONFLICT DO UPDATE) so re-running is safe and does not
// duplicate rows.

import { readFileSync } from 'node:fs';

const url = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/*$/, '').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_KEY || '';
const dryRun = process.argv.includes('--dry-run');
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));

if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.');
  process.exit(1);
}
if (!file) {
  console.error('Usage: node scripts/restore.mjs <backup.json> [--dry-run]');
  process.exit(1);
}

const dump = JSON.parse(readFileSync(file, 'utf8'));
if (!dump.data) {
  console.error('Not a backup file (missing "data").');
  process.exit(1);
}

// Insertion order: children before parents where foreign keys exist.
const ORDER = [
  'coin_addresses', 'users', 'balances', 'verifications', 'profit_mode',
  'chat_greeted', 'chat_messages', 'txns', 'loans', 'trades', 'orders',
  'aiorders', 'app_meta', 'app_config', 'backups',
];

async function upsert(table, rows) {
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${table}: ${(await res.text()).slice(0, 300)}`);
}

const present = ORDER.filter((t) => Array.isArray(dump.data[t]) && dump.data[t].length);

console.log(`Restore source : ${file}`);
console.log(`Backup taken   : ${dump._meta?.created_at ?? 'unknown'}`);
console.log(`Original host  : ${dump._meta?.source ?? 'unknown'}`);
console.log(`Target host    : ${url}`);
console.log(`Mode           : ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}\n`);

if (dryRun) {
  for (const t of present) console.log(`  would write ${String(dump.data[t].length).padStart(4)} rows -> ${t}`);
  console.log('\nDry run complete. Re-run without --dry-run to apply.');
  process.exit(0);
}

for (const t of present) {
  const rows = dump.data[t];
  const BATCH = 500;
  try {
    for (let i = 0; i < rows.length; i += BATCH) {
      await upsert(t, rows.slice(i, i + BATCH));
    }
    console.log(`  restored ${String(rows.length).padStart(4)} rows -> ${t}`);
  } catch (e) {
    console.error(`  FAILED ${t}: ${e.message}`);
    process.exit(1);
  }
}

console.log('\nRestore complete.');
