/*
 * Live price feed: keeps public.prices current so the exchange and the USDT
 * conversion on deposit approval have a rate to work from.
 *
 * WHY THIS EXISTS
 *   An exchange that takes its rate from the browser is a give-away: a member
 *   posts one bitcoin and a rate of a million and is paid a million USDT. So the
 *   rate lives in the database, this process is the only thing that writes it,
 *   and no request from a member can influence it. That is the same arrangement
 *   trading has always used, except that the quote is stored rather than passed
 *   in with each call, so a member's request never carries a price at all.
 *
 *   public.price_of_usdt() refuses a price older than the caller's limit, so if
 *   this process stops, the exchange and the deposit conversion stop with it and
 *   say so. They never fall back to an old number. Check it is alive with:
 *
 *     select symbol, price_usdt, fetched_at, now() - fetched_at as age
 *       from public.prices order by symbol;
 *
 * PRICE SOURCE
 *   Binance's public /api/v3/ticker/price: no API key, no account, no limits
 *   worth worrying about at this rate. The metals and forex markets are not on
 *   it and are not coins anyone can hold here, so they are not in this list.
 *   Set BINANCE_API to use a mirror if the host is unreachable.
 *
 * A coin Binance does not serve is reported and its previous price is left in
 * place. It is never given an invented value: a wrong price here pays real money
 * to the wrong side, and a stale-but-real price at least fails the freshness
 * check instead of trading.
 *
 * ---------------------------------------------------------------------------
 * Usage
 *   PowerShell:
 *     $env:SUPABASE_URL="https://xxxx.supabase.co"
 *     $env:SUPABASE_SERVICE_KEY="eyJ..."
 *     node scripts/prices.mjs              # one refresh, then exit
 *     node scripts/prices.mjs --watch      # every 30s, for a long-lived box
 *
 *   Scheduled, every minute is reasonable:
 *     Windows Task Scheduler, or a loop:
 *       while ($true) { node scripts/prices.mjs; Start-Sleep 60 }
 *     Linux/macOS cron:
 *       * * * * * node /path/to/scripts/prices.mjs
 *
 *   --watch is for a machine that stays up. A scheduled one-shot is safer: there
 *   is no long-lived process to keep alive and nothing to go stale silently.
 *
 *   Neither variable is read from config.js. config.js ships to every visitor,
 *   and the service key in a public file is a full bypass of row level security.
 * ---------------------------------------------------------------------------
 */

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const BINANCE = process.env.BINANCE_API || 'https://api.binance.com/api/v3';
const WATCH = process.argv.includes('--watch');
const INTERVAL_MS = 30_000;

if (!URL_ || !KEY) {
  console.error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.\n' +
    'Both must be set in the environment. Never hard-code them here.'
  );
  process.exit(2);
}

/*
 * Every coin a member can actually hold. Kept as a list rather than derived from
 * coin_addresses on purpose: that table is what the site shows as a deposit
 * address, and a row appearing there must not silently start being priced.
 */
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'TRX', 'BNB'];

/* Coin -> Binance pair. Every one of these is quoted in USDT. */
const pair = (s) => s + 'USDT';

async function fetchPrices() {
  // /ticker/price takes a symbols array, so this is one call whatever the count.
  const url = `${BINANCE}/ticker/price?symbols=${encodeURIComponent(JSON.stringify(SYMBOLS.map(pair)))}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`binance ${res.status} ${(await res.text()).slice(0, 120)}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('binance did not return a price list');

  const out = [];
  for (const s of SYMBOLS) {
    const row = rows.find((r) => r.symbol === pair(s));
    const price = row && Number(row.price);
    if (!Number.isFinite(price) || price <= 0) {
      // Left stale on purpose. The freshness check will refuse it, which is the
      // safe failure. Writing 0 or 1 here would price a member's coins wrongly.
      console.warn(`  ! no price for ${s} from binance - leaving whatever is stored`);
      continue;
    }
    out.push({ symbol: s, price });
  }
  return out;
}

async function save(rows) {
  // USDT goes in with every run, at exactly 1, with a fresh timestamp.
  //
  // It is not fetched: USDT/USDT is a real market on Binance that moves a few
  // cents, and using it would make a USDT balance drift for no reason. But it
  // still has to be written every run, because price_of_usdt and
  // list_live_prices judge freshness from fetched_at. Leaving USDT's row to the
  // migration's insert meant its age grew forever, and after five minutes every
  // USDT -> BTC swap was refused - the common direction, failing on the coin
  // that can never be stale. Re-asserting 1 on each run means fetched_at records
  // when the feed last confirmed it, which is the thing being checked.
  const stamped = new Date().toISOString();
  const values = [
    ...rows.map((r) => ({ symbol: r.symbol, price_usdt: r.price, source: 'binance', fetched_at: stamped })),
    { symbol: 'USDT', price_usdt: 1, source: 'fixed', fetched_at: stamped }
  ];

  // Upsert through PostgREST with the service key, which bypasses RLS. The table
  // grants no insert or update to anon or authenticated, so this is the only
  // path that can write it.
  const res = await fetch(`${URL_.replace(/\/+$/, '')}/rest/v1/prices?on_conflict=symbol`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(values)
  });
  if (!res.ok) throw new Error(`save failed ${res.status} ${(await res.text()).slice(0, 200)}`);
  return values.length;
}

/*
 * Did every coin the exchange offers end up tradable? A price that was written
 * but is already past the limit, or a coin missing entirely, is invisible from
 * the feed's own output and shows up much later as a refused swap. Cheap to check
 * here, so it is checked here.
 */
async function verifyTradable() {
  const res = await fetch(`${URL_.replace(/\/+$/, '')}/rest/v1/rpc/list_live_prices`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_max_age_sec: 300 })
  });
  if (!res.ok) return null;
  const rows = await res.json();
  const stale = (rows || []).filter((r) => !r.tradable).map((r) => r.symbol);
  return { total: (rows || []).length, stale };
}

async function once() {
  const prices = await fetchPrices();
  const n = await save(prices);
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`${stamp}  wrote ${n} prices (${prices.length} from binance + USDT at 1)`);
  for (const p of prices) console.log(`  ${p.symbol.padEnd(5)} ${p.price}`);
  console.log(`  ${'USDT'.padEnd(5)} 1  (fixed)`);

  const check = await verifyTradable().catch(() => null);
  if (check) {
    if (check.stale.length) {
      // Not fatal: the next run fixes it, and nothing has been quoted at a bad
      // price in the meantime. But it is the difference between a working
      // exchange and a refused one, so it is said out loud.
      console.warn(`  ! not tradable yet: ${check.stale.join(', ')}`);
    } else {
      console.log(`  all ${check.total} coins tradable`);
    }
  }
  return n;
}

async function main() {
  try {
    await once();
  } catch (e) {
    // A failed refresh is not fatal in --watch: the next tick tries again, and in
    // the meantime the freshness check refuses swaps rather than using a stale
    // price. It is fatal for a one-shot, so a scheduler reports the failure.
    if (!WATCH) {
      console.error('price refresh failed: ' + (e && e.message));
      process.exit(1);
    }
    console.error('price refresh failed, retrying: ' + (e && e.message));
  }

  if (!WATCH) return;
  setInterval(async () => {
    try { await once(); } catch (e) { console.error('price refresh failed: ' + (e && e.message)); }
  }, INTERVAL_MS);
}

main();
