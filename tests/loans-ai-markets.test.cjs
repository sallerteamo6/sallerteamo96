/*
 * Loans, markets, AI Quant and the admin search box.
 *
 * These are the four bugs reported after the settlement work:
 *   1. a loan row showed the raw uuid instead of who applied
 *   2. Confirm Order answered {"code":"22023","message":"unknown market"}
 *   3. AI Quant never started, never appeared in history or on the admin list
 *   4. the admin search box filled itself with the operator's own gmail address,
 *      which filtered the list down to one user and looked like the rest had
 *      disappeared
 */
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const dbjs = fs.readFileSync(path.join(root, 'scripts/db.js'), 'utf8');
const trade = fs.readFileSync(path.join(root, 'trade.html'), 'utf8');
const ai = fs.readFileSync(path.join(root, 'ai.html'), 'utf8');
const adminLoans = fs.readFileSync(path.join(root, 'admin-loans.html'), 'utf8');
const adminQuants = fs.readFileSync(path.join(root, 'admin-quants.html'), 'utf8');
const adminUsers = fs.readFileSync(path.join(root, 'admin-users.html'), 'utf8');
const sql = fs.readFileSync(path.join(root, 'supabase', 'v2', '17_profit_mode_and_settlement.sql'), 'utf8');
function fn(source, name, indent = '  ') {
  const m = new RegExp('^' + indent + '(?:async )?function ' + name + '\\(', 'm').exec(source);
  assert.ok(m, name);
  return source.slice(m.index, source.indexOf('\n' + indent + '}', m.index) + indent.length + 2);
}

(async () => {
  // ---- 1. A loan row identifies the member, not the uuid -----------------
  const USERS = {
    'e488bbf9-ac1c-4386-9cba-d35d077810db': { account: 'hassan.abid124000@gmail.com', email: 'hassan.abid124000@gmail.com', uid_code: '044512' },
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': { account: 'admintap.test@example.com', email: 'admintap.test@example.com', uid_code: '043520' }
  };
  const ctx = {
    console, Promise, Math, Date, JSON, parseFloat, parseInt, String, Object, Array, RegExp, Number, isFinite,
    DB: { _cache: { investmentProducts: [{ id: 2, code: 'AIQ_7', name: 'AI Quant 7-Day' }] }, ENABLED: true },
    _notifyChange() {}, _tradeIdMap: {},
    accountByUid(uid) { return USERS[String(uid)] || null; },
    isUserAdmin(uid) { return String(uid) === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; },
    getUserId: () => 'e488bbf9-ac1c-4386-9cba-d35d077810db',
    getBalance: () => 1000, fmtPrice: n => String(n)
  };
  vm.createContext(ctx);
  for (const n of ['userIdentity', 'ownerAccount', 'ownerMemberNo', 'aiProductById', 'normAiStatus', 'dbLoanToApp', 'dbAiOrderToApp']) {
    vm.runInContext(fn(app, n), ctx);
  }

  const who = ctx.userIdentity('e488bbf9-ac1c-4386-9cba-d35d077810db');
  assert.equal(who.account, 'hassan.abid124000@gmail.com');
  assert.equal(who.label, 'hassan.abid124000@gmail.com');
  assert.equal(who.memberNo, '044512');
  assert.equal(who.initials, 'H');
  assert.notEqual(who.account, who.uid, 'the uuid must not be the displayed identity');
  assert.equal(ctx.userIdentity('nope').memberNo, 'nope'.slice(0, 8), 'falls back to a short uuid when the profile is missing');

  // The v2 loans table has no account column at all, which is what produced the
  // raw uuid in the screenshot.
  const loan = ctx.dbLoanToApp({ id: 3, uid: 'e488bbf9-ac1c-4386-9cba-d35d077810db', principal: '2000', days: 7, rate: '1', interest: '20', status: 'approved' });
  assert.equal(loan.account, 'hassan.abid124000@gmail.com');
  assert.equal(loan.memberNo, '044512');
  assert.equal(loan.amount, 2000);
  assert.ok(!/e488bbf9/.test(loan.account), 'a loan row must not carry the uuid as its account');

  // The admin page renders the resolved identity, and the uid only as a member number.
  assert.match(adminLoans, /function loanUserCell\(l\)/);
  assert.match(adminLoans, /TrustApp\.userIdentity\(l\.uid\)/);
  assert.match(adminLoans, /UID #' \+ esc\(who\.memberNo\)/);
  assert.ok(!/esc\(l\.uid \|\| ''\)/.test(adminLoans), 'admin-loans must not print a raw uid');
  // The admin list has to load the users table for the lookup to resolve.
  assert.match(dbjs, /if \(\/admin-users\/|if \(\/funds\//);
  assert.match(dbjs, /'users','loans','balances'/);

  // ---- 2. "unknown market" is prevented, and explained --------------------
  assert.match(trade, /function marketCheck\(\)/);
  assert.match(trade, /if \(badMarket\) \{ toast\('error', badMarket\); return; \}/);
  assert.match(trade, /Available markets: /);
  assert.ok(/var badMarket = marketCheck\(\);[\s\S]{0,200}addBalance/.test(trade) === false,
    'the market check must run before anything touches the balance');
  // The check must not fire while the reference table is still loading, or it
  // would refuse a valid order in the first second after the page opens.
  assert.match(trade, /DB\.hasTable && DB\.hasTable\('products'\)/);
  assert.match(trade, /if \(!loaded\) return null;/);
  // The trade page has to load products for that check to be meaningful.
  assert.match(dbjs, /trade\|orders\|admin-feed\/\.test\(path\)\) return \['users','balances','contracts','products'\]/);
  // And the server now names the markets it does have.
  assert.match(sql, /raise exception 'unknown market %, available: %'/);
  assert.match(sql, /raise exception 'unknown duration % for market %, available: %'/);

  // The actual reported error was `unknown market ETHUSDT`. The home page links
  // to trade.html?s=ETH%2FUSDT, and the whole pair was being sent as the symbol,
  // so it reached open_trade as ETHUSDT and matched no products row.
  const msCtx = { String };
  vm.createContext(msCtx);
  vm.runInContext(fn(app, 'marketSymbol'), msCtx);
  assert.equal(msCtx.marketSymbol('ETH/USDT'), 'ETH', 'a paired symbol must reduce to its base');
  assert.equal(msCtx.marketSymbol('eth/usdt'), 'ETH');
  assert.equal(msCtx.marketSymbol('BTC'), 'BTC');
  assert.match(trade, /var pairIn = \(params\.get\('s'\) \|\| 'BTC'\)/);
  assert.match(trade, /var symbol = pairIn\.indexOf\('\/'\) >= 0 \? pairIn\.split\('\/'\)\[0\] : pairIn;/);
  assert.match(trade, /var coinTitle = symbol \+ '\/' \+ quoteUnit;/);
  assert.match(trade, /TrustApp\.findCoin\(pairIn\) \|\| TrustApp\.findCoin\(symbol\)/);
  // The normaliser is the belt to those braces: even a caller that passes the
  // whole pair again cannot reintroduce the fault.
  assert.match(app, /var symbol = marketSymbol\(/);
  assert.match(app, /var coin = marketSymbol\(/);
  assert.match(dbjs, /p_symbol: String\(data\.symbol \|\| data\.pair \|\| ''\)\.toUpperCase\(\)\.split\('\/'\)\[0\]/);
  assert.match(dbjs, /getProductTerms: function \(symbol, seconds\)[\s\S]{0,420}split\('\/'\)\[0\]/);

  // ---- 2b. Every coin the front end lists is a tradable product ----------
  const sql18 = fs.readFileSync(path.join(root, 'supabase', 'v2', '18_all_markets_and_auto_settle.sql'), 'utf8');
  const OFFERED = ['BTC', 'ETH', 'LTC', 'XRP', 'DOGE', 'TON', 'ADA', 'BNB', 'TRX', 'UNI', 'AVAX', 'DOT',
    'LINK', 'BCH', 'BSV', 'IOTA', 'ETC', 'USDC', 'TUSD', 'XAU', 'XAG', 'XPD', 'XPT', 'EUR', 'AUD', 'GBP'];
  for (const c of OFFERED) {
    assert.ok(new RegExp("\\('" + c + "',").test(sql18), 'no product row seeded for ' + c);
  }
  // Durations for every product, not only the twelve that existed before.
  assert.match(sql18, /insert into public\.product_durations[\s\S]{0,240}from public\.products p[\s\S]{0,140}where p\.is_active/);

  // ---- 3. AI Quant reads v2's investments, and the money is server-side ---
  const aiRow = ctx.dbAiOrderToApp({
    id: 7, uid: 'e488bbf9-ac1c-4386-9cba-d35d077810db', product_id: 2,
    principal: '1000', profit: '25', rate: '2.5', period_days: 7, settled_days: 3,
    status: 'active', start_at: '2026-09-27T00:00:00Z', end_at: '2026-10-04T00:00:00Z',
    created_at: '2026-09-27T00:00:00Z',
    schedules: JSON.stringify([
      { day: 1, rate: 2.5, profit: 25, due_at: '2026-09-28T00:00:00Z' },
      { day: 2, rate: 2.5, profit: 25, due_at: '2026-09-29T00:00:00Z' },
      { day: 3, rate: 2.5, profit: 25, due_at: '2026-09-30T00:00:00Z' },
      { day: 4, rate: 2.5, profit: 25, due_at: '2026-10-01T00:00:00Z' }
    ])
  });
  // These four were the "AI Quant is not starting" bug: v1 field names read off
  // a v2 row produce zeros, and a status that never matches 'running'.
  assert.equal(aiRow.amount, 1000, 'amount came from principal');
  assert.equal(aiRow.period, 7, 'period came from period_days');
  assert.equal(aiRow.rateMin, 2.5, 'the drawn rate, not a v1 band');
  assert.equal(aiRow.rateMax, 2.5);
  assert.equal(aiRow.status, 'running', "v2 'active' has to read as 'running'");
  assert.equal(aiRow.settledDays, 3);
  assert.equal(aiRow.product, 'AI Quant 7-Day', 'the product name comes from investment_products');
  assert.equal(aiRow.account, 'hassan.abid124000@gmail.com');
  // The countdown looks for status 0 and .time; open_investment writes neither.
  assert.equal(aiRow.schedules.filter(s => s.status === 0).length, 1, 'exactly one day still to settle');
  assert.equal(aiRow.schedules.filter(s => s.status === 1).length, 3);
  assert.equal(aiRow.schedules[3].time, '2026-10-01T00:00:00Z', '.time alias for due_at');
  assert.equal(ctx.normAiStatus('matured'), 'completed');
  assert.equal(ctx.normAiStatus('cancelled'), 'rejected');

  // A row the database stored no schedule for still has countable days.
  const noSched = ctx.dbAiOrderToApp({
    id: 8, uid: 'e488bbf9-ac1c-4386-9cba-d35d077810db', product_id: 2, principal: '500',
    rate: '2.5', period_days: 3, settled_days: 0, status: 'active', start_at: '2026-09-27T00:00:00Z'
  });
  assert.equal(noSched.schedules.length, 3);
  assert.equal(noSched.schedules[0].status, 0);

  // The admin page must not credit a balance or re-roll a rate any more.
  assert.ok(!/TrustApp\.addBalance/.test(adminQuants), 'admin-quants must not credit from the browser');
  assert.match(adminQuants, /TrustApp\.settleInvestmentDay\(id, settledDays/);
  assert.match(adminQuants, /TrustApp\.cancelInvestment\(id,/);
  assert.ok(!/Math\.random\(\) \* \(o\.rateMax - o\.rateMin\)/.test(adminQuants), 'the rate is drawn once at open, not per click');
  assert.ok(!/status: 'running',\s*\n\s*startAt/.test(adminQuants), 'approve must not write a v1 status the server rejects');
  // The plan carries the database product code, and the buy is awaited.
  assert.match(ai, /code: 'AIQ_7'/);
  assert.match(ai, /code: 'AIQ_30'/);
  assert.match(ai, /TrustApp\.openInvestment\(/);
  assert.match(app, /settleInvestmentDay: settleInvestmentDay/);
  assert.match(app, /cancelInvestment: cancelInvestment/);
  assert.match(dbjs, /settleInvestmentDay: function \(id, settledDays, note\)/);
  assert.match(dbjs, /cancelInvestment: function \(id, note\)/);
  // investment_products has to be loaded for the plan name to resolve.
  assert.match(dbjs, /ai\\?\.html\|admin-quants\/\.test\(path\)\) return \['users','balances','investments','investment_products'\]/);

  // The new SQL pays through the ledger, is owner-guarded, and is idempotent.
  assert.match(sql, /create or replace function public\.settle_investment_day\(/);
  assert.match(sql, /create or replace function public\.cancel_investment\(/);
  assert.match(sql, /if not \(public\.is_admin\(\) or v\.uid = auth\.uid\(\)\) then[\s\S]{0,40}not your investment/);
  assert.match(sql, /public\.post_ledger\(v\.uid, v_coin, v_paid, 'adjustment', 'investments'/);
  assert.match(sql, /public\.post_ledger\(v\.uid, v_coin, v_refund, 'adjustment', 'investments'/);
  assert.match(sql, /grant execute on function public\.settle_investment_day\(bigint, integer, text\) to authenticated;/);
  assert.match(sql, /grant execute on function public\.cancel_investment\(bigint, text\) to authenticated;/);
  assert.match(sql, /if v_days <= 0 then[\s\S]{0,500}already_settled', true/);

  // ---- 3b. The principal comes back when the term completes --------------
  // settle_investment_day is superseded by 18, which adds the principal to the
  // final day's payout. This is the "investment amount also returned" case.
  assert.match(sql18, /create or replace function public\.settle_investment_day\(/);
  assert.match(sql18, /v_payout := v_profit \+ \(case when v_matured then v\.principal else 0 end\);/);
  assert.match(sql18, /'principal_returned', case when v_matured then v\.principal else 0 end/);
  assert.match(sql18, /'days_paid', v_days/);
  // The principal is inside the same locked transaction as the counter, which is
  // what makes a retry safe: the guard finds no day left to settle.
  assert.match(sql18, /for update;[\s\S]{0,1400}if v_days <= 0 then/);
  // And the same in the unattended sweep.
  assert.match(sql18, /create or replace function public\.settle_due_investments\(/);
  assert.match(sql18, /v_paid := v_profit \+ \(case when v_mat then c\.principal else 0 end\);/);
  assert.match(sql18, /for update of i skip locked/);
  // A sweep never settles a day early: it compares the schedule's own due dates.
  assert.match(sql18, /\(s ->> 'due_at'\)::timestamptz <= now\(\)/);
  assert.match(sql18, /revoke all on function public\.settle_due_investments\(\) from public, anon, authenticated;/);
  assert.match(sql18, /grant execute on function public\.settle_due_investments\(\) to service_role;/);
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'settle-everything.mjs')), 'no settlement runner script');
  const runner = fs.readFileSync(path.join(root, 'scripts', 'settle-everything.mjs'), 'utf8');
  assert.match(runner, /rpc\/settle_due_investments/);
  // It settles trades too, so an order nobody is watching still pays.
  assert.match(runner, /rpc\/settle_due_contracts/);
  assert.match(runner, /api\.binance\.com/);
  assert.ok(!fs.existsSync(path.join(root, 'scripts', 'settle-investments.mjs')),
    'the investments-only runner was replaced, not left behind as a second thing to schedule');
  // The service key comes from the environment only. config.js ships to every
  // visitor, so a key read from there would be a public bypass of row level
  // security. Comments are stripped first so the warning about it is not a hit.
  const runnerCode = runner.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/config\.js/.test(runnerCode), 'the runner must not read the service key from config.js');
  assert.ok(!/require\(.*config/.test(runnerCode));
  assert.match(runnerCode, /process\.env\.SUPABASE_SERVICE_KEY/);

  // ---- 3c. All six plans exist, with the bounds the page shows ------------
  for (const code of ['AIQ_1', 'AIQ_7', 'AIQ_15', 'AIQ_30', 'AIQ_90', 'AIQ_180']) {
    assert.ok(new RegExp("\\('" + code + "',").test(sql18), 'no investment_products row for ' + code);
  }
  assert.match(sql18, /add column if not exists min_principal numeric\(24,8\);/);
  assert.match(sql18, /add column if not exists max_principal numeric\(24,8\);/);
  // The bounds are enforced in the database, not just drawn on the page.
  assert.match(sql18, /if v_prod\.min_principal is not null and p_principal < v_prod\.min_principal then/);
  assert.match(sql18, /if v_prod\.max_principal is not null and v_prod\.max_principal > 0 and p_principal > v_prod\.max_principal then/);
  // And the page reads the catalogue instead of carrying its own copy.
  assert.match(ai, /function loadPlans\(\)/);
  assert.match(ai, /function renderPlans\(\)/);
  assert.match(ai, /TrustApp\.getInvestmentProducts/);
  assert.match(ai, /window\.addEventListener\('trustsync:investment_products', loadPlans\)/);
  assert.match(app, /getInvestmentProducts: getInvestmentProducts/);
  assert.match(dbjs, /getInvestmentProducts: function \(\)/);
  assert.ok(!/<div class="product-card" onclick="openBuy\(\d\)/.test(ai), 'the plan cards must not be hard-coded any more');
  assert.match(ai, /function findProduct\(code\)/);

  // ---- 4. The admin search box cannot be autofilled ----------------------
  const guard = fn(app, 'initSearchAutofillGuard');
  assert.match(guard, /setAttribute\('autocomplete', 'off'\)/);
  assert.match(guard, /data-lpignore/);
  assert.match(guard, /if \(typed && !force\) return;/, 'an operator who typed must keep what they typed');
  assert.match(guard, /el\.value = '';/);
  // The attributes alone were tried first and Chrome ignored them, so the field
  // is readonly until the operator shows intent, and the value is re-cleared on
  // every render. Both are asserted because one without the other is not enough.
  assert.match(guard, /el\.removeAttribute\('readonly'\)/);
  assert.match(guard, /\['keydown', 'paste', 'input', 'drop'\]/);
  assert.match(guard, /\['pointerdown', 'mousedown', 'touchstart', 'focus'\]/);
  assert.match(guard, /state\.enforce = function \(\) \{ clear\(false\); \};/);
  assert.match(guard, /setInterval\(/, 'Chrome can fill late, so the check cannot be a single pass');
  assert.match(adminUsers, /readonly data-lpignore/, 'the input ships readonly so it is protected before any script runs');
  assert.match(adminUsers, /initSearchAutofillGuard\('userSearch'\)/);
  assert.match(adminUsers, /__searchGuard; if \(g && g\.enforce\) g\.enforce\(\)/, 'every repaint re-checks the box');
  assert.match(adminUsers, /<input type="search" id="userSearch" name="q"[^>]*autocomplete="off"/);
  assert.ok(!/<input type="text" id="userSearch"/.test(adminUsers), 'the filter must not be a bare type="text"');
  for (const f of ['admin-chat.html', 'admin-adjust.html', 'admin-addresses.html']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/<input type="text"[^>]*>/g)) {
      assert.match(m[0], /autocomplete="off"/, f + ': ' + m[0].slice(0, 70));
    }
  }

  console.log('PASS: loan rows show the member login and UID, untradable markets are refused before the balance is ' +
    'touched, AI Quant reads v2 investments and settles through the ledger, and the admin filter box cannot be autofilled');
})().catch(e => { console.error(e); process.exitCode = 1; });
