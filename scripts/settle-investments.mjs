/*
 * Investment settlement.
 *
 * AI Quant plans pay out on their own. A plan's rate and per-day amounts were
 * drawn once when the member opened it and stored on the row, so settling a day
 * needs no external price feed and no human: it is arithmetic the database can do
 * on its own. This script asks it to, once a minute.
 *
 * settle_due_investments() pays every investment with a full day owed and returns
 * the principal on the day its term completes. It is service_role only, which is
 * why it lives here rather than in the browser: the money has to move somewhere
 * the member cannot reach, or the whole point of the ledger is lost.
 *
 * It is safe to run twice, or twice at once, or every second: rows are locked
 * with skip locked, settled_days only moves forward, and a day already paid is
 * skipped rather than paid twice. The interval only affects how promptly a day is
 * paid, never how much.
 *
 * ---------------------------------------------------------------------------
 * Usage
 *   PowerShell:
 *     $env:SUPABASE_URL="https://xxxx.supabase.co"
 *     $env:SUPABASE_SERVICE_KEY="eyJ..."
 *     node scripts/settle-investments.mjs
 *
 *   Scheduled, every minute is reasonable:
 *     Windows Task Scheduler, or a loop:
 *       while ($true) { node scripts/settle-investments.mjs; Start-Sleep 60 }
 *     Linux/macOS cron, every minute:
 *       * * * * * node /path/to/scripts/settle-investments.mjs
 *
 *   Neither variable is read from config.js. config.js ships to every visitor,
 *   and the service key in a public file is a full bypass of row level security.
 * ---------------------------------------------------------------------------
 */

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

if (!URL_ || !KEY) {
  console.error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.\n' +
    'Both must be set in the environment. Never hard-code them here.'
  );
  process.exit(1);
}

const base = URL_.replace(/\/+$/, '');
const headers = {
  apikey: KEY,
  Authorization: 'Bearer ' + KEY,
  'Content-Type': 'application/json'
};

async function rest(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(base + '/rest/v1/' + path, init);
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + path + ': ' + text.slice(0, 400));
  return text ? JSON.parse(text) : null;
}

async function main() {
  const rows = await rest('rpc/settle_due_investments', { method: 'POST', body: {} });
  const settled = rows || [];
  if (!settled.length) {
    console.log(new Date().toISOString() + '  nothing due');
    return;
  }

  let paid = 0, matured = 0, days = 0;
  for (const r of settled) {
    paid += Number(r.paid) || 0;
    days += Number(r.days_paid) || 0;
    if (r.matured) matured++;
  }
  console.log(
    new Date().toISOString() +
    '  investments=' + settled.length +
    '  days=' + days +
    '  paid=' + paid.toFixed(8) +
    '  matured=' + matured
  );
  for (const r of settled.filter(x => x.matured)) {
    console.log('  matured investment ' + r.id + ': profit and principal returned');
  }
}

main().catch((e) => {
  console.error('investment settlement failed: ' + e.message);
  // Non-zero so a scheduler surfaces the failure instead of silently going quiet.
  process.exit(1);
});
