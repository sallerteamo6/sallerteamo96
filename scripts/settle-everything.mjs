/*
 * Settlement runner: trades and AI Quant plans, unattended.
 *
 * Both need money to move on their own, in a place the member cannot reach.
 * Neither needs a human and neither needs a browser:
 *
 *   - A trade's stake left the wallet when the order was placed. The payout has
 *     to come back, and it must not depend on the member still having the tab
 *     open. Closing the countdown now only closes the window; the order keeps
 *     running here.
 *
 *   - An AI Quant plan draws its rate and its per-day amounts once, when the
 *     member opens it, and stores them on the row. Settling a day is then
 *     arithmetic the database can do on its own, and the principal comes back
 *     with the final day.
 *
 * Prices. A trade's outcome is decided by comparing the exit price with the entry
 * price, so something has to supply the exit price. This quotes Binance's public
 * /api/v3/ticker/price, the same no-key, no-account feed scripts/settle.mjs has
 * always used, and hands the quotes to the database, which does the arithmetic.
 * This process never computes a payout.
 *
 * A market Binance does not serve is reported and left open, never guessed at:
 * settling on a wrong price pays real money to the wrong side. The metals and
 * forex products carry a sentinel price_symbol for exactly this reason, so they
 * settle through the trade page's countdown instead and are listed as unquotable
 * here.
 *
 * Safe to run twice, twice at once, or every second. Contract rows are locked
 * with skip locked and both settlers are idempotent: a day or an order already
 * paid is skipped rather than paid twice. The interval affects how promptly
 * something is paid, never how much.
 *
 * ---------------------------------------------------------------------------
 * Usage
 *   PowerShell:
 *     $env:SUPABASE_URL="https://xxxx.supabase.co"
 *     $env:SUPABASE_SERVICE_KEY="eyJ..."
 *     node scripts/settle-everything.mjs
 *
 *   Scheduled, every minute is reasonable:
 *     Windows Task Scheduler, or a loop:
 *       while ($true) { node scripts/settle-everything.mjs; Start-Sleep 60 }
 *     Linux/macOS cron:
 *       * * * * * node /path/to/scripts/settle-everything.mjs
 *
 *   Neither variable is read from config.js. config.js ships to every visitor,
 *   and the service key in a public file is a full bypass of row level security.
 * ---------------------------------------------------------------------------
 */

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const BINANCE = process.env.BINANCE_API || 'https://api.binance.com/api/v3';

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

/* Last trade price per pair, in one request. /ticker/price accepts a symbols
   array, so this is a single call regardless of how many products need settling.
   Binance 400s on an unknown symbol, which is handled by falling back to
   per-symbol calls so one bad pair cannot stop the rest. */
async function fetchPrices(priceSymbols) {
  const out = {};
  if (!priceSymbols.length) return out;
  const query = encodeURIComponent(JSON.stringify(priceSymbols));
  const res = await fetch(BINANCE + '/ticker/price?symbols=' + query);
  if (res.ok) {
    for (const t of await res.json()) {
      const n = Number(t.price);
      if (Number.isFinite(n) && n > 0) out[t.symbol] = n;
    }
    return out;
  }
  for (const sym of priceSymbols) {
    try {
      const r = await fetch(BINANCE + '/ticker/price?symbol=' + encodeURIComponent(sym));
      if (!r.ok) continue;
      const t = await r.json();
      const n = Number(t.price);
      if (Number.isFinite(n) && n > 0) out[sym] = n;
    } catch (e) { /* reported below as unquotable */ }
  }
  return out;
}

async function main() {
  const when = new Date().toISOString();
  let problems = 0;

  // ---- trades ------------------------------------------------------------
  // The join is what turns a product_id into something quotable.
  const due = await rest(
    'contracts' +
      '?select=id,product_id,products!inner(id,price_symbol,symbol,is_active)' +
      '&status=eq.open&expires_at=lte.' + when +
      '&order=expires_at.asc&limit=500'
  );
  const wanted = [];
  const seenPair = new Set();
  for (const c of due || []) {
    const p = c.products;
    if (!p || !p.price_symbol || p.is_active === false) continue;
    if (seenPair.has(p.id)) continue;   // one quote per product settles them all
    seenPair.add(p.id);
    wanted.push({ productId: p.id, pair: p.price_symbol, symbol: p.symbol });
  }
  const unquotable = wanted.filter(w => /^(METAL_|FX_)/.test(w.pair));
  if (unquotable.length) {
    console.log('   ' + unquotable.length + ' market(s) have no exchange quote (' +
      unquotable.map(w => w.symbol).join(', ') +
      ') - they settle through the trade page countdown instead');
  }
  const quotes = await fetchPrices(wanted.filter(w => !/^(METAL_|FX_)/.test(w.pair)).map(w => w.pair));
  const priceMap = {};
  for (const w of wanted) {
    const q = quotes[w.pair];
    if (q != null) priceMap[String(w.productId)] = q;
    else if (!/^(METAL_|FX_)/.test(w.pair)) console.log('   ! no price for ' + w.pair + ' - will retry next run');
  }
  if ((due || []).length) {
    if (!Object.keys(priceMap).length) {
      console.log('   ' + (due || []).length + ' contract(s) due but none quotable this run; leaving them open');
    } else {
      const settled = await rest('rpc/settle_due_contracts', { method: 'POST', body: { p_prices: priceMap } });
      const won = (settled || []).filter(s => s.status === 'won').length;
      const paid = (settled || []).reduce((a, s) => a + (Number(s.payout) || 0), 0);
      console.log('   trades due=' + (due || []).length + ' settled=' + (settled || []).length +
        ' won=' + won + ' paid=' + paid.toFixed(8));
    }
  } else {
    console.log('   no trades due');
  }

  // ---- AI Quant plans ---------------------------------------------------
  const inv = await rest('rpc/settle_due_investments', { method: 'POST', body: {} });
  if (!(inv || []).length) {
    console.log('   no investment days due');
  } else {
    let paid = 0, matured = 0, days = 0;
    for (const r of inv) {
      paid += Number(r.paid) || 0;
      days += Number(r.days_paid) || 0;
      if (r.matured) matured++;
    }
    console.log('   investments settled=' + inv.length + ' days=' + days +
      ' paid=' + paid.toFixed(8) + ' matured=' + matured);
    for (const r of inv.filter(x => x.matured)) {
      console.log('     matured investment ' + r.id + ': profit and principal returned');
    }
  }

  // A market left unquotable is expected for metals and forex, not a fault, so
  // it does not fail the run. Anything else that went wrong is reported by the
  // catch below with a non-zero exit.
  if (problems) console.log('   ' + problems + ' problem(s)');
  console.log('done ' + new Date().toISOString());
}

main().catch((e) => {
  console.error('settlement failed: ' + e.message);
  // Non-zero so a scheduler surfaces the failure instead of silently going quiet.
  process.exit(1);
});
