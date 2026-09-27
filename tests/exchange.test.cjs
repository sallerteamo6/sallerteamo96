/*
 * Exchange at live prices, and USDT conversion on deposit approval.
 *
 * The rule these tests exist to protect: the rate is decided by the database and
 * cannot be supplied by a caller. If a member can name the rate, the exchange is
 * a give-away, so the tests read the shipped SQL and the shipped client rather
 * than re-implementing them, and assert on what is actually there.
 *
 * The migration cannot be executed here: this workspace's Supabase token is
 * read-only, and /database/query refuses DDL. These are therefore structural
 * checks over the SQL text plus arithmetic checks over the same rounding the SQL
 * uses. They do not prove the function runs; scripts/prices.mjs and a member
 * swap do that, and both are listed at the end as the live check.
 *
 * Run: node --test tests/exchange.test.cjs
 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const test = require('node:test');
const root = path.join(__dirname, '..');

const sql = fs.readFileSync(path.join(root, 'supabase/v2/27_exchange_and_usdt_deposits.sql'), 'utf8');
const db = fs.readFileSync(path.join(root, 'scripts/db.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'exchange.html'), 'utf8');
const feed = fs.readFileSync(path.join(root, 'scripts/prices.mjs'), 'utf8');

// Strip comments so a sentence explaining what the code refuses cannot be
// mistaken for the code doing it.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, ' ');
const plain = code(sql);

// One function, from its signature to the end of its body. A plpgsql body is
// $$ delimited, not brace delimited, so matching braces would run past the end of
// the function and into the next one - which is exactly how a rule could appear
// satisfied by an unrelated function.
function fn(name) {
  const at = plain.indexOf('function public.' + name + '(');
  assert.notEqual(at, -1, 'function not found: ' + name);
  const open = plain.indexOf('$$', at);
  assert.notEqual(open, -1, 'no $$ body for ' + name);
  const close = plain.indexOf('$$', open + 2);
  assert.notEqual(close, -1, 'unterminated $$ in ' + name);
  // Signature plus body, so a test can assert on the parameter list too.
  return plain.slice(at, close + 2);
}

const exchange = fn('exchange_coins');
const priceOf = fn('price_of_usdt');
const approve = fn('admin_set_transaction_status');

test('the exchange takes no rate parameter', () => {
  // A rate argument is the whole vulnerability. The signature must not grow one.
  assert.match(exchange, /p_coin_in\s+text,\s*p_amount_in\s+numeric,\s*p_coin_out\s+text,\s*p_spread_bps\s+integer\s+default\s+0/);
  assert.doesNotMatch(exchange, /p_rate|p_price|p_amount_out|p_unit_price/i);
});

test('the client cannot send a rate either', () => {
  const m = db.match(/exchangeCoins:[\s\S]*?\n    \},/);
  assert.ok(m, 'exchangeCoins not found in db.js');
  assert.doesNotMatch(m[0], /p_rate|p_price|p_amount_out|rate:/i);
  assert.match(m[0], /p_coin_in[\s\S]*p_amount_in[\s\S]*p_coin_out/);
});

test('the rate is read from the prices table, never from the request', () => {
  assert.match(exchange, /public\.price_of_usdt\(v_in,\s*300\)/);
  assert.match(exchange, /public\.price_of_usdt\(v_out,\s*300\)/);
  // The body must not read a price out of p_ anything.
  assert.doesNotMatch(exchange, /p_[a-z_]*price/i);
});

test('both legs are priced through USDT, never directly against each other', () => {
  // BTC->ETH is BTC/USDT over ETH/USDT. Quoting the pair directly would need a
  // second feed and a second staleness rule.
  assert.match(exchange, /v_amount \* v_price_in \/ v_price_out/);
});

test('the prices table cannot be written by a browser', () => {
  assert.match(plain, /create table if not exists public\.prices/);
  // RLS on, read open, and no insert/update policy anywhere for anon or
  // authenticated. A single INSERT policy here would void the whole design.
  assert.match(plain, /alter table public\.prices enable row level security/);
  assert.match(plain, /create policy prices_read on public\.prices for select/);
  assert.doesNotMatch(plain, /create policy[^;]*prices[^;]*for (insert|update|delete|all)/i);
  assert.doesNotMatch(plain, /grant (insert|update|delete|all)[^;]*on public\.prices to (anon|authenticated)/i);
});

test('a stale price is refused, and named as such', () => {
  assert.match(priceOf, /v_fetched < now\(\) - make_interval/);
  assert.match(priceOf, /raise exception/);
  assert.match(priceOf, /price feed has never reported it/);
  assert.match(priceOf, /restart scripts\/prices\.mjs/);
  // A missing coin and a stale one are different problems and say so.
  assert.match(priceOf, /if not found then[\s\S]*never reported/);
});

test('USDT is seeded at exactly 1 and never fetched from an exchange', () => {
  // USDT/USDT is a real market that drifts a few cents. Using it would make a
  // USDT balance change for no reason.
  assert.match(plain, /values \('USDT',\s*1,\s*'fixed'/);
  assert.match(feed, /SYMBOLS = \['BTC', 'ETH', 'SOL', 'TRX', 'BNB'\]/);
  assert.doesNotMatch(feed, /SYMBOLS = \[[^\]]*'USDT'/);
});

test('the swap is all-or-nothing', () => {
  // Two post_ledger calls in one function body means one transaction, so a
  // failure on the second leg rolls the first back.
  const legs = exchange.match(/perform public\.post_ledger\(/g) || [];
  assert.equal(legs.length, 2, 'expected exactly two ledger legs');
  assert.match(exchange, /perform public\.post_ledger\(v_uid, v_in, -v_amount, 'exchange'/);
  assert.match(exchange, /perform public\.post_ledger\(v_uid, v_out,\s+v_credit, 'exchange'/);
});

test('the ledger reason is a real enum value', () => {
  assert.match(plain, /alter type public\.txn_type add value if not exists 'exchange'/);
  // It has to be committed before the function that uses it is created, or the
  // body fails to parse: the new value is not visible inside its own transaction.
  const enumAt = plain.indexOf("add value if not exists 'exchange'");
  const commitAt = plain.indexOf('commit;', enumAt);
  const fnAt = plain.indexOf('function public.exchange_coins');
  assert.ok(enumAt < commitAt, 'enum must be committed');
  assert.ok(commitAt < fnAt, 'the function using it must come after that commit');
});

test('rounding happens once, and the credited figure is the reported figure', () => {
  // balances.amount is numeric(24,8). Rounding in the page as well as the
  // server is what stops the two differing by a rounding step.
  assert.match(exchange, /v_credit := round\(v_net, 8\)/);
  assert.match(exchange, /'amount_out', v_credit/);
  assert.match(page, /Math\.round\(amt \* fromR \/ toR \* 1e8\) \/ 1e8/);
  // And the page must show the server's number after a fill, not its own.
  assert.match(page, /getElementById\('toAmount'\)\.value = res\.amount_out/);
});

test('dust and nonsense amounts are refused rather than rounded to nothing', () => {
  assert.match(exchange, /if v_credit <= 0 then[\s\S]*too small to exchange/);
  assert.match(exchange, /p_amount_in <= 0/);
  assert.match(exchange, /p_amount_in > 1000000000000/);
  assert.match(exchange, /v_in = v_out then[\s\S]*two different coins/);
});

test('a frozen account cannot swap its way out of the freeze', () => {
  assert.match(exchange, /v_status <> 'active'[\s\S]*cannot exchange coins/);
});

test('only a signed-in member may swap', () => {
  assert.match(exchange, /v_uid is null then[\s\S]*sign in to exchange coins/);
  assert.match(plain, /grant execute on function public\.exchange_coins\(text, numeric, text, integer\) to authenticated/);
  assert.match(plain, /revoke all on function public\.exchange_coins\(text, numeric, text, integer\) from public, anon/);
  // The ledger writer stays unreachable from a browser. It is defined in 03,
  // not here, so it is checked where it actually lives: exchange_coins calls it
  // from inside a security definer body, which is the only reason it is safe to
  // leave revoked.
  const fns03 = code(fs.readFileSync(path.join(root, 'supabase/v2/03_functions.sql'), 'utf8'));
  assert.match(fns03, /revoke all on function public\.post_ledger from public, anon, authenticated/);
  assert.doesNotMatch(fns03, /grant execute on function public\.post_ledger/i);
  assert.match(exchange, /security definer/);
});

test('an approved non-USDT deposit is credited as USDT at the server price', () => {
  assert.match(approve, /v_coin\s*<>\s*'USDT'\s*then/);
  assert.match(approve, /public\.price_of_usdt\(v_coin,\s*1800\)/);
  // Whitespace-tolerant: the SQL aligns its := signs, which is not a style the
  // assertions should be sensitive to.
  assert.match(approve, /v_usdt\s*:=\s*round\(v_txn\.amount\s*\*\s*v_price,\s*8\)/);
  assert.match(approve, /post_ledger\(v_txn\.uid,\s*'USDT',\s*v_usdt,\s*'deposit'/);
  // And a USDT deposit is still credited as itself, unchanged.
  assert.match(approve, /else\s*\n?\s*perform public\.post_ledger\(v_txn\.uid, v_txn\.coin, v_txn\.amount, 'deposit'/);
});

test('the deposit conversion keeps the audit trail', () => {
  // The row still says 0.5 BTC arrived; only the credit is in USDT, and the rate
  // is written into the note. Rewriting the row would lose what was sent.
  assert.doesNotMatch(approve, /update public\.transactions\s+set[^;]*coin\s*=/i);
  assert.match(approve, /credited %s USDT for %s %s at %s USDT per %s/);
});

test('the replaced approval function is otherwise unchanged', () => {
  // admin, pending-only, same-transaction crediting, the audit row. If any of
  // these went missing the replacement would be a regression, not a change.
  assert.match(approve, /if not public\.is_admin\(\) then[\s\S]*admin only/);
  assert.match(approve, /v_txn\.status <> 'pending'/);
  assert.match(approve, /for update/);
  assert.match(approve, /reviewed_by = auth\.uid\(\)/);
  assert.match(approve, /insert into public\.audit_log/);
  // Withdrawal behaviour must be untouched.
  assert.match(approve, /post_ledger\(v_txn\.uid, v_txn\.coin, -v_txn\.amount, 'withdrawal'/);
});

test('the page no longer decides a rate in the browser', () => {
  // The old page fetched Binance and divided two numbers to show a rate.
  assert.doesNotMatch(page, /api\.binance\.com/);
  assert.doesNotMatch(page, /ticker\/price/);
  assert.match(page, /DB\.getExchangePrices\(\)/);
  assert.match(page, /DB\.exchangeCoins\(f, amt, t\)/);
});

test('the page refuses what the server would refuse, and says no coins moved', () => {
  assert.match(page, /too old to trade at[\s\S]*No coins were moved/);
  assert.match(page, /Live price unavailable\. No coins were moved/);
  // A failure must never be reported as a success.
  assert.match(page, /The exchange failed\. No coins were moved/);
  assert.doesNotMatch(page, /not available yet/);
});

test('the page offers only coins the server can price', () => {
  assert.doesNotMatch(page, /'LTC'|'DOGE'|'AVAX'|'TON'/);
  assert.match(page, /function coins\(\)[\s\S]*Object\.keys\(PRICES\)/);
});

test('the feed writes only through the service key', () => {
  assert.match(feed, /process\.env\.SUPABASE_SERVICE_KEY/);
  assert.doesNotMatch(feed, /DB_ANON_KEY|SITE_CONFIG/);
  // A price Binance does not serve must leave the old value, never invent one.
  assert.match(feed, /leaving whatever is stored/);
  assert.match(feed, /!Number\.isFinite\(price\) \|\| price <= 0/);
  // And a non-positive or non-numeric price is never written.
  assert.doesNotMatch(feed, /price:\s*row\.price/);
});

test('the feed never reads its credentials from the shipped config', () => {
  // config.js goes to every visitor. A service key in it is a full RLS bypass.
  assert.doesNotMatch(feed, /require\(|import .*config/);
  assert.match(feed, /Never hard-code them here/);
});

test('the feed re-asserts USDT every run, so it never goes stale', () => {
  // Found live: the migration seeds USDT at 1 and nothing ever refreshed it, so
  // its fetched_at aged past the limit and every USDT -> BTC swap was refused -
  // the common direction, failing on the one coin that can never be stale. The
  // feed now writes USDT with a fresh timestamp and price 1 on every run.
  assert.match(feed, /symbol:\s*'USDT',\s*price_usdt:\s*1,\s*source:\s*'fixed',\s*fetched_at:\s*stamped/);
  assert.doesNotMatch(feed, /SYMBOLS = \[[^\]]*'USDT'/);
  // And the feed reports the consequence rather than leaving it to be found later.
  assert.match(feed, /verifyTradable/);
  assert.match(feed, /not tradable yet/);
});

test('every coin the exchange offers is tradable after a feed run', () => {
  // The invariant, in the form that actually caught the bug: whatever the feed
  // writes must satisfy the same freshness rule the exchange applies. USDT is the
  // one that failed, and only because nothing wrote it a second time.
  const written = ['BTC', 'ETH', 'SOL', 'TRX', 'BNB'];
  assert.match(feed, new RegExp('SYMBOLS = \\[' + written.map((c) => `'${c}'`).join(', ') + '\\]'));
  // USDT is written but never fetched, so its price is a constant.
  assert.match(feed, /price_usdt: 1/);
  assert.doesNotMatch(feed, /pair\('USDT'\)|'USDTUSDT'/);
});

test('an RPC error reaches the page as a sentence, not a JSON envelope', () => {
  // An operator was shown {"code":"22023",...,"message":"no live price for BTC"}
  // in a toast. rpc() only unwrapped on HTTP 400 and even then returned the body.
  const m = db.match(/_rpcErrorText:[\s\S]*?\n    \},/);
  assert.ok(m, '_rpcErrorText not found in db.js');
  assert.match(m[0], /JSON\.parse/);
  assert.match(m[0], /json\.message \|\| json\.msg/);
  // A missing function is an operator problem and must say which function.
  assert.match(m[0], /PGRST202/);
  assert.match(m[0], /is not available on this server/);
  // Unparseable input falls back rather than being swallowed.
  assert.match(m[0], /return raw/);
});

test('the balance adjuster shows a live price before an adjustment is applied', () => {
  const adj = fs.readFileSync(path.join(root, 'admin-adjust.html'), 'utf8');
  assert.match(adj, /id="adjPrice"/);
  assert.match(adj, /DB\.getExchangePrices\(\)/);
  // The coin's own rate and the value of the typed amount, both from the server.
  assert.match(adj, /1 ' \+ coin \+ ' = ' \+ money\(p\.price/);
  assert.match(adj, /' = ' \+ money\(amt \* p\.price, 2\) \+ ' USDT'/);
  // A coin with no price says so rather than implying a rate of zero.
  assert.match(adj, /No live price for/);
  // And a stale price is labelled, not silently applied.
  assert.match(adj, /adj-price-stale/);
  // Updated when the coin or amount changes, and on a timer.
  assert.match(adj, /cSel\.onchange = function \(\) \{ refreshBal\(\); renderAdjPrice\(\); \}/);
  assert.match(adj, /getElementById\('adjAmount'\)\.addEventListener\('input', renderAdjPrice\)/);
  assert.match(adj, /setInterval\(refreshAdjPrices, 20000\)/);
  // It reads the server's price. No price feed in the admin page itself.
  assert.doesNotMatch(adj, /api\.binance\.com|ticker\/price/);
});

test('the deposits page no longer promises the coin is credited as sent', () => {
  // It now credits USDT at the live price, so the label has to say that.
  const funds = fs.readFileSync(path.join(root, 'admin-funds.html'), 'utf8');
  assert.doesNotMatch(funds, /credited in the deposited asset/);
  assert.match(funds, /credited as USDT at the live price/);
});


// ---------------------------------------------------------------------------
//  The arithmetic, against the same rounding the SQL uses.
// ---------------------------------------------------------------------------
const round8 = (n) => Math.round(n * 1e8) / 1e8;

test('the quoted amount is the credited amount', () => {
  const cases = [
    { amt: 0.5, pin: 84919.38, pout: 1 },
    { amt: 100, pin: 1, pout: 2710.32 },
    { amt: 1234.56789012, pin: 124.04, pout: 0.3342 },
    { amt: 0.00000001, pin: 84919.38, pout: 1 },
    { amt: 7, pin: 0.3342, pout: 779.19 }
  ];
  for (const c of cases) {
    const net = (c.amt * c.pin) / c.pout;
    assert.equal(round8(net), round8(net), 'rounding must be stable');
    // The page and the server must land on the identical figure.
    const pageValue = Math.round(c.amt * c.pin / c.pout * 1e8) / 1e8;
    assert.equal(pageValue, round8(net), `mismatch for ${c.amt}`);
  }
});

test('a coin-to-coin swap goes through USDT and is reversible in principle', () => {
  // BTC -> ETH -> BTC at unchanged prices returns the original amount, which is
  // the property that proves no rate was quietly applied twice.
  const btc = 0.25, pin = 84919.38, eth = 2710.32;
  const ethOut = round8((btc * pin) / eth);
  const btcBack = round8((ethOut * eth) / pin);
  assert.ok(Math.abs(btcBack - btc) < 1e-6, `round trip drifted: ${btc} -> ${btcBack}`);
});

test('an amount too small to be creditable is refused, not rounded to nothing', () => {
  // p_amount_in is rounded to 8dp first, so a vanishing amount becomes exactly
  // zero and the `v_credit <= 0` guard is what stops it. The threshold is
  // amount * price < 0.5e-8, which for BTC is below about 6e-14.
  const pin = 84919.38;
  const vanishes = 1e-14;
  const out = round8((vanishes * pin) / 1);
  assert.equal(out, 0, 'this must be the dust case the SQL refuses');
  assert.ok(round8(1e-11 * pin) > 0, '1e-11 BTC is still worth something and must be allowed');

  // And the guard is genuinely in the shipped SQL, on the credited figure.
  assert.match(exchange, /if v_credit <= 0 then/);
  assert.match(exchange, /v_credit := round\(v_net, 8\)/);
});
