/*
 * Contract settlement.
 *
 * settle_contract() is granted to service_role only, on purpose: a client that
 * can settle its own contract can also declare a losing contract a winner. So
 * settlement has to run somewhere the user cannot influence, which is this
 * script, on a machine you control, on a timer.
 *
 * It reads the contracts that are open and past expiry, quotes each one from
 * Binance's public REST API, and hands the prices to settle_expired(), which
 * does the win/loss decision, the payout and the ledger entry in one
 * transaction. This process never computes a payout itself.
 *
 * The price feed is Binance's /api/v3/ticker/price, which needs no API key, no
 * account and no rate-limit header beyond the default 1200 weight/min. Prices
 * are spot, last trade, and are not the venue the user trades on.
 *
 * ---------------------------------------------------------------------------
 * Usage
 * ---------------------------------------------------------------------------
 *   PowerShell:
 *     $env:SUPABASE_URL="https://xxxx.supabase.co"
 *     $env:SUPABASE_SERVICE_KEY="eyJ..."
 *     node scripts/settle.mjs
 *
 *   Scheduled, e.g. Windows Task Scheduler every 10 seconds is too often; every
 *   30-60 seconds is right, since the shortest contract is 60s. Linux/macOS
 *   cron:  * * * * * node /path/to/scripts/settle.mjs
 *
 * Neither variable is read from config.js. config.js ships to every visitor,
 * and the service key in a public file is a full bypass of row level security.
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
  if (opts.noContent) return null;
  return text ? JSON.parse(text) : null;
}

/*
 * Which contracts are waiting, and which Binance pair settles each one.
 *
 * The join to products is what turns a product_id into something quotable. A
 * product with no price_symbol, or one that is inactive, is reported and left
 * alone rather than settled at a guessed price: settling on a wrong price pays
 * out real money to the wrong side, so an unknown pair must block, not guess.
 */
async function findDueContracts() {
  const rows = await rest(
    'contracts' +
      '?select=id,product_id,coin,side,amount,entry_price,expires_at,' +
      'products!inner(id,price_symbol,symbol,is_active)' +
      '&status=eq.open&expires_at=lte.' + nowIso() +
      '&order=expires_at.asc&limit=500'
  );

  const blocked = [];
  const byProduct = new Map();

  for (const c of rows || []) {
    const p = c.products;
    if (!p || !p.price_symbol || !p.is_active) {
      blocked.push(c);
      continue;
    }
    // Last price wins for the whole batch: every contract on a product settles
    // against one quote, so two contracts opened a second apart cannot be
    // settled at two different prices.
    if (!byProduct.has(p.id)) byProduct.set(p.id, { priceSymbol: p.price_symbol, productId: p.id });
  }

  return { rows: rows || [], prices: [...byProduct.values()], blocked };
}

function nowIso() {
  return new Date().toISOString();
}

/*
 * Last trade price per pair, in one request.
 *
 * /ticker/price accepts a symbols array, so this is a single call regardless of
 * how many products need settling. Binance 400s on an unknown symbol, which is
 * handled by falling back to per-symbol calls so one bad pair cannot stop the
 * rest from settling.
 */
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
      if (!r.ok) {
        console.warn('  ! no price for ' + sym + ' (HTTP ' + r.status + ') — will retry next run');
        continue;
      }
      const t = await r.json();
      const n = Number(t.price);
      if (Number.isFinite(n) && n > 0) out[sym] = n;
    } catch (e) {
      console.warn('  ! price fetch failed for ' + sym + ': ' + e.message);
    }
  }
  return out;
}

async function main() {
  const { rows, prices, blocked } = await findDueContracts();

  if (blocked.length) {
    const ids = [...new Set(blocked.map((c) => (c.products && c.products.symbol) || c.product_id))];
    console.warn('!! ' + blocked.length + ' contract(s) reference a product with no price_symbol or an inactive product: ' + ids.join(', '));
    console.warn('   Set products.price_symbol (or reactivate the product) — they cannot be settled yet.');
  }

  if (!rows.length) {
    console.log('nothing due at ' + nowIso());
    return;
  }

  const quotes = await fetchPrices(prices.map((p) => p.priceSymbol));

  // settle_expired takes {"<product_id>": price}, matching its
  // `p_prices ->> c.product_id::text` lookup.
  const priceMap = {};
  for (const p of prices) {
    if (quotes[p.priceSymbol] != null) priceMap[String(p.productId)] = quotes[p.priceSymbol];
  }

  const unquotable = prices.filter((p) => quotes[p.priceSymbol] == null);
  if (unquotable.length) {
    console.warn('!! no price for: ' + unquotable.map((p) => p.priceSymbol).join(', '));
    console.warn('   Their contracts stay open and retry on the next run. Nothing is settled on a guess.');
  }

  if (!Object.keys(priceMap).length) {
    console.warn('no quotable products among ' + rows.length + ' due contract(s); exiting without settling');
    return;
  }

  const settled = await rest('rpc/settle_expired', {
    method: 'POST',
    body: { p_prices: priceMap }
  });

  console.log(
    new Date().toISOString() +
    '  due=' + rows.length +
    '  priced=' + Object.keys(priceMap).length + '/' + prices.length +
    '  settled=' + settled
  );
}

main().catch((e) => {
  console.error('settlement failed: ' + e.message);
  // Non-zero so a scheduler surfaces the failure instead of silently going quiet.
  process.exit(1);
});
