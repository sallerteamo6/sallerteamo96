const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const dbjs = fs.readFileSync(path.join(root, 'scripts/db.js'), 'utf8');
const trade = fs.readFileSync(path.join(root, 'trade.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const users = fs.readFileSync(path.join(root, 'admin-users.html'), 'utf8');
const sql = fs.readFileSync(path.join(root, 'supabase', 'v2', '17_profit_mode_and_settlement.sql'), 'utf8');
function fn(source, name, indent = '  ') {
  const m = new RegExp('^' + indent + '(?:async )?function ' + name + '\\(', 'm').exec(source);
  assert.ok(m, name);
  return source.slice(m.index, source.indexOf('\n' + indent + '}', m.index) + indent.length + 2);
}

(async () => {
  // ---- 1. No page ships the double-encoded text any more -----------------
  // The signature of the old corruption: a UTF-8 lead byte rendered as Latin-1
  // (U+00C2 / U+00C3 / U+00E2) immediately followed by a C1 or Latin-1
  // supplement character, i.e. "Ã‚", "Ãƒ", "â€". The long blobs it produced were
  // spread across every shipped page, not just the trade panel, so this walks
  // the whole set.
  const mojibake = /[\u00c2\u00c3\u00e2][\u0080-\u00bf\u2018\u2019\u201c\u201d\u20ac\u2013\u2014]/;
  const shipped = fs.readdirSync(root)
    .filter(f => /\.(html|js|css)$/.test(f) || /^scripts\/.*\.js$/.test(f.replace(/\\/g, '/')))
    .map(f => path.join(root, f));
  for (const file of shipped) {
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!mojibake.test(src), path.basename(file) + ' still contains mojibake');
    assert.ok(src.indexOf('\ufffd') === -1, path.basename(file) + ' contains a replacement character');
  }
  // The close buttons and the record separator are real markup again.
  assert.match(trade, /class="close-btn" onclick="closeSubmit\(\)">\s*<svg/);
  assert.match(trade, /id="resultIcon"><\/div>/);
  assert.match(trade, /icon\.textContent = win \? '\\u2713' : 'X';/);
  assert.match(trade, /recLabel \+ ' &middot; ' \+ r\.time/);

  // ---- 2. The result modal shows the server's profit and detail ----------
  const nodes = {};
  function el(id) { return nodes[id] || (nodes[id] = { id, className: '', textContent: '', innerHTML: '', style: {} }); }
  const ctx = {
    console, Promise, Math, Date, JSON, parseFloat, isFinite, Number, String, Object, Array, RegExp,
    document: { getElementById: id => el(id), querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
    symbol: 'BTC', quoteUnit: 'USDT', alias: 'USDT', dec: 2, direction: 'up', durationSec: 60,
    price: 101.5, buyPrice: 100, odds: 185, wallet: 'USDT', minAmount: 10, orderBusy: false,
    currentOrderId: null, countdownTimer: null, records: [], coinTitle: 'BTC/USDT',
    tradeCfg: { showCountdownCurrentStatus: false, showMinOrderAmount: true },
    fmt: (n, d) => (parseFloat(n) || 0).toFixed(d == null ? 2 : d),     escHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    num2: n => String(Math.round((parseFloat(n) || 0) * 100) / 100),
    toast: (...a) => { ctx.toasts.push(a); }, toasts: [],
    renderRecords() {}, reloadRecords() {},
    getTerms: null,
    TrustApp: {
      getUserId: () => 'user-1',
      getBalance: () => 325,
      accountByUid: () => ({ account: 'me@example.test' }),
      getTradeTerms: () => ctx.getTerms,
      getProfitMode: () => false,
      openTrade: o => ctx.openTrade(o),
      settleTrade: (id, px) => ctx.settleTrade(id, px),
      refreshTrade: id => { ctx.refreshed = id; },
      weekendTradingEnabled: () => true
    }
  };
  vm.createContext(ctx);
  for (const name of ['escHtml', 'num2', 'syncOdds', 'refreshBalance', 'setSettling', 'settleErrorText', 'renderResult', 'renderUnsettled', 'showResult']) {
    vm.runInContext(fn(trade, name, '    '), ctx);
  }

  // A won order: the figures on screen are the ones the server returned.
  ctx.renderResult(
    { id: '11111111-2222-3333-4444-555555555555', status: 'won', amount: 100, payout: 285, profit: 185,
      entry_price: 100, settle_price: 101.5, payout_pct: 185, duration_sec: 60, coin: 'USDT', side: 'up',
      balance: 325, forced: false, settled_at: '2026-09-27T10:00:00Z' }, 100);
  assert.equal(el('resultIcon').className, 'result-icon win');
  assert.equal(el('resultIcon').textContent, '\u2713');
  assert.equal(el('resultTitle').textContent, 'Trade Won');
  assert.equal(el('resultAmount').textContent, '+185.00');
  for (const label of ['Market', 'Direction', 'Payout Rate', 'Purchase Amount', 'Purchase Price',
                       'Selling Price', 'Return', 'Net Profit/Loss', 'New Balance']) {
    assert.ok(el('resultInfo').innerHTML.includes('>' + label + '<'), 'missing detail row: ' + label);
  }
  assert.match(el('resultInfo').innerHTML, /101\.50/);   // selling price, not a made-up +/-0.1%
  assert.equal(el('resultOverlay').style.display, 'flex');
  assert.equal(ctx.records.length, 1);
  assert.equal(ctx.records[0].status, 'win');

  // A lost order: the whole stake, and the result modal says so.
  ctx.records.length = 0;
  ctx.renderResult(
    { id: 'c-2', status: 'lost', amount: 100, payout: 0, profit: -100, entry_price: 100,
      settle_price: 99, payout_pct: 185, duration_sec: 60, coin: 'USDT', side: 'down',
      balance: 200, forced: false, settled_at: '2026-09-27T10:01:00Z' }, 100);
  assert.equal(el('resultIcon').className, 'result-icon lose');
  assert.equal(el('resultTitle').textContent, 'Trade Lost');
  assert.equal(el('resultAmount').textContent, '-100.00');
  assert.match(el('resultInfo').innerHTML, /down-text">Down/);

  // Profit Mode is disclosed, never silently applied.
  ctx.renderResult(
    { id: 'c-3', status: 'won', amount: 100, payout: 285, profit: 185, entry_price: 100,
      settle_price: 99, payout_pct: 185, duration_sec: 60, coin: 'USDT', side: 'down',
      balance: 485, forced: true, settled_at: '2026-09-27T10:02:00Z' }, 100);
  assert.match(el('resultInfo').innerHTML, /Applied by administrator/);

  // Settlement goes through the server, and a failure is reported in plain words
  // rather than credited locally or dumped raw.
  ctx.currentOrderId = 'c-9';
  ctx.settleTrade = () => Promise.reject(new Error('insufficient USDT balance'));
  ctx.showResult(100);
  await new Promise(r => setImmediate(r));
  assert.equal(el('resultIcon').textContent, '!');
  assert.equal(el('resultTitle').textContent, 'Settlement Pending');
  assert.match(el('resultInfo').innerHTML, /Awaiting settlement/);
  assert.match(el('resultInfo').innerHTML, /not enough balance/i);
  assert.equal(el('resultRetry').style.display, '', 'a retry is offered on a failure');
  // The order id is on screen, so a member can quote it to support.
  assert.match(el('resultInfo').innerHTML, />c-9</);
  assert.equal(ctx.refreshed, 'c-9');
  ctx.settleTrade = (id, px) => Promise.resolve({ id, status: 'won', amount: 100, payout: 285, profit: 185, balance: 325, payout_pct: 185, entry_price: 100, settle_price: px, coin: 'USDT', side: 'up', duration_sec: 60, forced: false });
  ctx.currentOrderId = 'c-10';
  ctx.showResult(100);
  await new Promise(r => setImmediate(r));
  assert.equal(el('resultAmount').textContent, '+185.00');

  // ---- 3. The order form is priced from the database --------------------
  ctx.getTerms = { payout_pct: 183, min_amount: 25 };
  ctx.syncOdds();
  assert.equal(ctx.odds, 183);
  assert.equal(ctx.minAmount, 25);
  assert.equal(el('oddsLabel').textContent, '183%');
  assert.equal(el('amountInput').min, '25');

  // ---- 4. The browser never moves money itself --------------------------
  assert.ok(!/TrustApp\.addBalance/.test(trade), 'trade.html must not write a balance');
  assert.ok(!/TrustApp\.updateTrade/.test(trade), 'trade.html must not write a trade status');
  assert.match(trade, /TrustApp\.settleTrade\(id, price\)/);
  assert.match(app, /openTrade: openTrade/);
  assert.match(app, /settleTrade: settleTrade/);
  assert.ok(!/settleExpiredTrades/.test(app), 'the client-side auto-settler must stay gone');
  // A rejected adjustment must not be swallowed into a fake local total: that
  // silent catch is how a settled trade showed a profit that never arrived.
  const addBalance = fn(app, 'addBalance');
  assert.ok(!/\.catch\(function \(\) \{ return/.test(addBalance), 'addBalance must not fake a success');
  assert.match(addBalance, /return Promise\.reject/);
  assert.match(addBalance, /admin_adjust_balance|_notifyChange\('user_balances'\)/);
  // No page may re-upload a settled order, which in v2 is a second debit.
  const migrate = fn(app, 'migrateLegacyTrades');
  assert.match(migrate, /return false;/, 'the legacy trade re-upload must stay disabled');
  assert.ok(!/DB\.addTrade/.test(migrate));
  // The AI page must not debit the principal itself: open_investment does it.
  const ai = fs.readFileSync(path.join(root, 'ai.html'), 'utf8');
  assert.ok(!/TrustApp\.addBalance/.test(ai), 'ai.html must not debit the principal in the browser');
  assert.match(ai, /TrustApp\.openInvestment\(/);
  assert.match(app, /openInvestment: openInvestment/);
  assert.match(dbjs, /openInvestment: function \(code, principal, coin\)/);
  // A swap has no server path, so it must not claim one.
  const ex = fs.readFileSync(path.join(root, 'exchange.html'), 'utf8');
  assert.ok(!/TrustApp\.addBalance/.test(ex), 'exchange.html must not move two balances in the browser');
  assert.match(ex, /No coins were moved/);

  // ---- 5. The new RPCs exist, are owned, and are reachable only as intended
  assert.match(sql, /create or replace function public\.open_trade\(/);
  assert.match(sql, /create or replace function public\.settle_trade\(/);
  assert.match(sql, /create or replace function public\.admin_set_profit_mode\(/);
  assert.match(sql, /grant execute on function public\.open_trade\(text, text, text, numeric, integer, numeric\) to authenticated;/);
  assert.match(sql, /grant execute on function public\.settle_trade\(uuid, numeric\) to authenticated;/);
  assert.match(sql, /grant execute on function public\.admin_set_profit_mode\(text, uuid, boolean\) to anon, authenticated;/);
  // settle_trade may only be called for the caller's own contract, and only by a
  // signed-in user: settle_contract stays service_role only.
  assert.match(sql, /grant execute on function public\.settle_contract\(uuid, numeric\) to service_role;/);
  assert.ok(!/to anon, authenticated;[\s\S]{0,40}settle_contract/.test(sql));
  assert.match(sql, /if v\.uid <> auth\.uid\(\) and not public\.is_admin\(\) then[\s\S]{0,40}not your order/);
  // The stake and the payout both go through the audited ledger.
  assert.match(sql, /public\.post_ledger\(v_uid, coalesce\(p_coin, v_product\.quote_coin\), -p_amount,[\s\S]{0,120}'contract stake'\)/);
  assert.match(sql, /public\.post_ledger\(v\.uid, v\.coin, v_payout, 'trade'/);
  // Profit Mode is decided in the database, from a setting no client may write.
  assert.match(sql, /v_forced := public\.profit_mode_for\(v\.uid\);/);
  assert.match(sql, /v_key := case when p_uid is null then 'profit_mode:all' else 'profit_mode:' \|\| p_uid::text end;/);
  assert.match(sql, /insert into public\.audit_log\(actor,action,entity,entity_id,before,after\)/);

  // ---- 6. Profit Mode is switchable, and readable on both scopes --------
  assert.match(users, /id="profitAllBtn"/);
  assert.match(users, /onclick="toggleProfitAll\(\)"/);
  assert.ok(/onclick="toggleProfit\(/.test(users), 'per-user toggle is not wired to a row');
  assert.match(users, /async function toggleProfit\(uid\)/);
  assert.ok(!/Forced winning outcomes are unavailable/.test(users), 'the old disabled toggle is gone');
  assert.match(users, /Turn ON for all/);
  assert.match(dbjs, /getOwnProfitMode: function \(uid\)/);
  assert.match(app, /getOwnProfitMode: getOwnProfitMode/);
  assert.match(app, /isGlobalProfitMode: isGlobalProfitMode/);

  // ---- 7. The admin list cannot be emptied by a click -------------------
  // The card builder must clone the rows, not move the live cells out of the
  // table: moving them is what left the panel blank.
  const build = fn(app, 'buildCards');
  assert.match(build, /cloneNode\(true\)/, 'cards must be built from clones');
  assert.ok(!/holder\.appendChild\(td\.firstChild\);?\s*\}\s*\}\);?\s*\}\);?\s*wrap\.insertBefore/.test(build));
  const afterClone = build.slice(build.indexOf('cloneNode(true)'));
  assert.ok(!/while \(td\.firstChild\) holder\.appendChild\(td\.firstChild\);\s*\}\);\s*\}\);\s*\}\);\s*wrap\.insertBefore\(list, tbl\);\s*if \(existing/.test(afterClone));
  // The table is only hidden after its replacement is in the DOM, and a
  // colspan placeholder row is shown as a table, not as a one-card list.
  assert.ok(build.indexOf('wrap.insertBefore(list, tbl)') > build.indexOf('cloneNode(true)'));
  assert.match(build, /tbl\.removeAttribute\('data-mc-on'\);/);
  assert.match(build, /getAttribute\('colspan'\)/);
  // The observer watches the table body, not the whole document: a click, a
  // toast or an unrelated panel must not schedule a rebuild.
  const watch = fn(app, '_watchCardSource');
  assert.match(watch, /observe\(body, \{ childList: true \}\)/);
  assert.ok(!/observe\(document\.body/.test(app), 'no document-wide observer');
  // The open/closed state of a row survives a rebuild, keyed by the row.
  assert.match(app, /var _openCardKeys = \{\};/);
  assert.match(build, /if \(_openCardKeys\[key\]\) card\.classList\.add\('arc-open'\);/);
  // A click on one row only toggles that row.
  assert.match(build, /var toggle = function \(ev\) \{[\s\S]{0,160}card\.classList\.toggle\('arc-open'\);/);
  assert.ok(!/querySelectorAll\('\.arc-open'\)\.forEach[\s\S]{0,80}classList\.remove/.test(build),
    'tapping one row must not close the others');

  // ---- 8. contracts.status is an enum, so it must be cast ----------------
  // The reported failure was:
  //   {"code":"42804","message":"column \"status\" is of type contract_status
  //    but expression is of type text"}
  // and the result modal showed "Awaiting settlement" instead of the outcome,
  // with the stake debited and the contract left open.
  //
  // `case when c then 'won' else 'lost' end` over two bare literals resolves to
  // text, and PostgreSQL has no implicit cast from text to an enum, so the UPDATE
  // raises and settlement never completes. Every assignment to that column needs
  // an explicit ::public.contract_status. This walks all the SQL so the same
  // mistake cannot be reintroduced in a later file.
  const schema = fs.readFileSync(path.join(root, 'supabase', 'v2', '01_schema.sql'), 'utf8');
  assert.match(schema, /create type contract_status as enum \('open', 'won', 'lost', 'void'\)/);
  assert.match(schema, /status\s+contract_status\s+not null default 'open'/);
  const sqlDir = path.join(root, 'supabase', 'v2');
  let contractUpdates = 0;
  for (const f of fs.readdirSync(sqlDir).filter(x => x.endsWith('.sql'))) {
    const s = fs.readFileSync(path.join(sqlDir, f), 'utf8');
    const re = /update\s+public\.contracts[\s\S]{0,700}?set\s[\s\S]{0,140}?status\s*=\s*case when[\s\S]{0,160}?end/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      contractUpdates++;
      assert.ok(/::public\.contract_status/.test(m[0]),
        f + ' assigns a bare-literal CASE to the contract_status enum column: ' +
        m[0].replace(/\s+/g, ' ').slice(0, 130));
    }
  }
  assert.ok(contractUpdates >= 3, 'expected the settlement statements to be found, saw ' + contractUpdates);
  // The corrective migration exists for a project that already applied 17, since
  // re-running 17 is not something to rely on an operator remembering.
  const sql19 = fs.readFileSync(path.join(sqlDir, '19_settlement_enum_fix.sql'), 'utf8');
  assert.match(sql19, /create or replace function public\.settle_trade\(/);
  assert.match(sql19, /create or replace function public\.settle_contract\(/);
  assert.match(sql19, /'won'::public\.contract_status/);
  assert.match(sql19, /'lost'::public\.contract_status/);
  assert.match(sql19, /grant execute on function public\.settle_trade\(uuid, numeric\) to authenticated;/);
  assert.match(sql19, /grant execute on function public\.settle_contract\(uuid, numeric\) to service_role;/);
  // investments.status is plain text, so its CASE needs no cast. Assert the
  // schema agrees, so nobody "fixes" that one by hand and drifts from it.
  assert.match(schema, /status\s+text\s+not null default 'active'/);

  // ---- 9. random() must not leak into numeric arithmetic ----------------
  // The reported AI Quant failure was:
  //   {"code":"42883","message":"function round(double precision, integer)
  //    does not exist"}
  // random() returns double precision, and double precision * numeric is double
  // precision, so `round(rate_min + random() * band, 2)` is round(double, int),
  // which does not exist. Every round(x, n) on a stored numeric column needs
  // random() cast, or no cast at all.
  const sqlDir2 = sqlDir;
  for (const f of fs.readdirSync(sqlDir2).filter(x => x.endsWith('.sql'))) {
    // Comments are stripped first: the corrective migrations quote the broken
    // line in order to explain it, and a scan that read the comments would flag
    // the explanation as the bug.
    const s = fs.readFileSync(path.join(sqlDir2, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
    // round(<expr containing random()>, n) without a ::numeric cast on random()
    const re = /round\(\s*([^;]{0,220}?random\(\)[^;]{0,220}?),\s*\d+\s*\)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      assert.ok(/random\(\)\s*::\s*numeric/.test(m[0]),
        f + ': round() is fed a double precision random(). Cast it: ' + m[0].replace(/\s+/g, ' ').slice(0, 110));
    }
  }
  assert.ok(fs.readFileSync(path.join(sqlDir, '20_payouts_multi_trade_numeric_fix.sql'), 'utf8')
    .includes('random()::numeric'), 'the corrective migration must carry the cast');

  // ---- 10. The stated payouts, and more than one order at a time ---------
  const sql20 = fs.readFileSync(path.join(sqlDir, '20_payouts_multi_trade_numeric_fix.sql'), 'utf8');
  assert.match(sql20, /when 60\s+then 20/);
  assert.match(sql20, /when 120\s+then 30/);
  assert.match(sql20, /when 300\s+then 40/);
  // A fresh install must seed the same numbers, or it drifts from a live project.
  const seed = fs.readFileSync(path.join(sqlDir, '05_seed.sql'), 'utf8');
  assert.match(seed, /\(60::integer,\s+20::numeric\)/);
  assert.match(seed, /\(120,\s+30\)/);
  assert.match(seed, /\(300,\s+40\)/);
  assert.ok(!/p\.payout_pct \+ d\.adjust/.test(seed), 'the durations must not be derived from the product default');
  // Several orders on one market at once, each debiting its own stake. The guard
  // message is quoted in migration 20's comment to explain the removal, so the
  // code is checked with comments stripped.
  const sql20Code = sql20.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
  assert.match(sql20, /create or replace function public\.open_trade\(/);
  assert.ok(!/an order for this market is still running/.test(sql20Code),
    'the one-order-per-market guard must be gone or a second trade is impossible');
  // The only refusals open_trade may make are the per-order input validations.
  // Nothing may refuse because another order happens to be running.
  const openTradeBody = sql20Code.split('create or replace function public.open_trade')[1].split('\nend $$')[0];
  const reasons = [...openTradeBody.matchAll(/raise exception '([^']+)'/g)].map(m => m[1]);
  const expected = ['not signed in', 'account is not active', 'side must be up or down',
    'entry price unavailable', 'amount must be positive', 'unknown market %, available: %',
    'unknown duration % for market %, available: %', 'minimum amount is %'];
  assert.deepEqual(reasons.map(r => r.replace(/\s+/g, ' ')), expected,
    'open_trade refuses for something other than its own input, or lost a validation');
  assert.ok(!/select 1 from public\.contracts\s+where uid = v_uid and status = 'open'/.test(openTradeBody),
    'open_trade must not look for an already-running order on the same market');
  assert.match(sql20, /v_balance := public\.post_ledger\(v_uid, coalesce\(p_coin, v_product\.quote_coin\), -p_amount,/);
  // Closing the countdown must not abandon an order, so contracts settle without
  // a browser.
  assert.match(sql20, /create or replace function public\.settle_due_contracts\(p_prices jsonb\)/);
  assert.match(sql20, /grant execute on function public\.settle_due_contracts\(jsonb\) to service_role;/);
  assert.ok(!/to (anon|authenticated);[\s\S]{0,20}$/m.test(''), 'placeholder');
  assert.match(sql20, /revoke all on function public\.settle_due_contracts\(jsonb\) from public, anon, authenticated;/);
  assert.match(sql20, /for update of ct skip locked/);
  assert.match(sql20, /v_price is null or v_price <= 0 then continue/, 'an unquoted market blocks rather than guessing');
  // The page must not abandon an order when the window closes.
  const closeFn = fn(trade, 'closeCountdown', '    ');
  assert.match(closeFn, /rememberOrder\(/, 'closing the countdown must remember the order');
  assert.ok(!/clearInterval\(countdownTimer\); countdownTimer = null; \}\s*\n\s*document\.getElementById\('countdownOverlay'\)\.style\.display = 'none';\s*\n\s*\}/.test(closeFn),
    'closeCountdown must not simply hide the modal and drop the order');
  assert.match(trade, /function cancelCountdown\(\)/);
  assert.match(trade, /TrustApp\.cancelTrade\(id\)/);
  assert.match(app, /cancelTrade: cancelTrade/);
  assert.match(dbjs, /cancelTrade: function \(id\)/);
  assert.match(trade, /onclick="closeCountdown\(\)"/);
  assert.match(trade, /onclick="cancelCountdown\(\)"/);
  // And a running order is not shown as a red 0.00 loss.
  assert.ok(!/Profit\/Loss<\/span><span class="value" style="color:#8a94a6;">--/.test(trade),
    'a running order must not print a profit figure it does not have yet');
  assert.match(trade, /: 'Running'/);

  // ---- 8b. A running order says how much time is left ------
  // The countdown has to come from the contract's own expires_at, not from a
  // timer started when the page opened: reload half way through an order and the
  // number on screen must still be the real remainder, or it counts from
  // nothing and overstates the time the stake is committed for.
  const loadFn = fn(trade, 'loadRecords', '    ');
  assert.match(loadFn, /expiresAt:/, 'records must keep expires_at to count down from');
  assert.match(loadFn, /t\.expires_at/, 'the countdown must read the contract expiry');
  assert.match(loadFn, /t\.duration/, 'a contract without expires_at must fall back to createdAt + duration');
  assert.match(trade, /class="label">Time left<\/span>/, 'a running order must label the time left');
  assert.match(trade, /data-until="' \+ escHtml\(r\.expiresAt/, 'the time left must carry the deadline into the DOM');
  assert.match(trade, /data-id="' \+ escHtml\(r\.id/, 'the countdown must carry the order id, so it can settle that order');
  assert.match(trade, /function tickRecTimers\(\)/);
  const tickTimer = fn(trade, 'tickRecTimers', '    ');
  assert.match(tickTimer, /Date\.parse\(/, 'the countdown must parse the deadline it was given');
  assert.match(tickTimer, /- now/, 'the countdown must measure against the current time');
  assert.match(tickTimer, /fmtRemain\(left\)/, 'the countdown must show the remainder');
  // Missing deadline must say so rather than invent a number.
  assert.match(tickTimer, /!isFinite\(until\)[\s\S]{0,80}'--'/, 'an order with no deadline must show -- and not a made-up time');
  // A second, not the 2s price tick or the 4s record reload, or the seconds jump.
  assert.match(trade, /setInterval\(tickRecTimers, 1000\)/,
    'the time left must tick once a second, so the seconds do not jump');
  // Reaching zero must actually settle the order, not just repaint the row. The
  // page used to print "Settling" and re-read the list, so nothing ever asked the
  // server to settle: the order stayed open for good with the stake committed.
  assert.match(tickTimer, /Settling/);
  assert.match(tickTimer, /settleDueRecords\(due\)/, 'reaching zero must settle the order');
  assert.match(tickTimer, /getAttribute\('data-id'\)/, 'the row must name the order it is settling');
  const settleDue = fn(trade, 'settleDueRecords', '    ');
  assert.match(settleDue, /TrustApp\.settleTrade\(id, price\)/,
    'the due order must be settled through the server, which decides the result');
  assert.match(settleDue, /forgetOrder\(id\)/, 'a settled order must stop being treated as a background order');
  assert.match(settleDue, /reloadRecords\(\)/, 'the row must repaint from the settled result');
  // The tick runs every second, so without a guard it would stack a call per second.
  assert.match(settleDue, /if \(!id \|\| settling\[id\]\) return;/, 'a settlement already in flight must not be started again');
  assert.match(settleDue, /settling\[id\] = true/);
  // A settlement that keeps failing must say so. Swallowing it is what left an
  // order looking unfinished with no clue why.
  assert.match(settleDue, /toast\('error'/, 'a settlement that will not go through must be reported');
  assert.match(settleDue, /settleSaid\[id\]/, 'a persistent failure must be reported once, not every second');
  // A remembered order must only be dropped when it is positively known to be
  // finished. Reading "not in the list" as finished threw the order away while
  // the contract list was still loading, and nothing was left to settle it.
  const settleRem = fn(trade, 'settleRemembered', '    ');
  assert.match(settleRem, /if \(finished\[o\.id\]\) \{ forgetOrder\(o\.id\); return; \}/,
    'an order is forgotten only when the server says it is finished');
  assert.match(settleRem, /if \(!open\[o\.id\]\) return;/,
    'an order the page has not loaded yet must be kept, not dropped');
  assert.ok(!/if \(!open\[o\.id\]\) \{ forgetOrder\(o\.id\); return; \}/.test(settleRem),
    'an absent order must never be treated as a settled one');

  // ---- 8c. A cancelled order must not still read as running ------
  // cancel_contract sets status = 'void' and posts the stake back. The record
  // list treated anything that was not win or loss as open, so a refunded order
  // kept its blue "Running" badge and a live countdown, and the member saw their
  // stake as committed after the money was already back in the wallet.
  const recLoad = fn(trade, 'loadRecords', '    ');
  assert.match(recLoad, /var open = t\.status === 'open';/,
    'only an open contract may be shown as running');
  assert.match(recLoad, /var voided = t\.status === 'void';/, 'a voided contract must be recognised');
  assert.match(recLoad, /voided \? 'void' : 'open'/, 'a voided contract must not be reported as open');
  assert.match(recLoad, /expiresAt: open \? until : null/,
    'only a running order gets a countdown; a refunded one must not tick');
  const render = fn(trade, 'renderRecords', '    ');
  assert.match(render, /r\.status === 'void' \? 'Refunded' : 'Running'/,
    'a cancelled order must read as refunded, not running');
  assert.match(render, /'status-void'/, 'a cancelled order needs its own badge');
  assert.match(render, /Refunded in full, no profit or loss/,
    'a cancelled order must not print a profit figure');
  assert.match(css, /\.trade-record-status\.status-void\{/);
  // The cancel path drops the local note and repaints, so the row can change.
  const cancelFn = fn(trade, 'cancelCountdown', '    ');
  assert.match(cancelFn, /forgetOrder\(id\)/);
  assert.match(cancelFn, /reloadRecords\(\)/, 'cancelling must repaint the record straight away');
  // The server is the backstop: settling an already-void order pays nothing.
  assert.match(sql19, /if v\.status <> 'open' then[\s\S]{0,700}'already_settled', true/,
    'settle_trade must pay nothing for an order that is no longer open');
  // Only the text is rewritten, so the list does not re-render under the cursor.
  assert.match(tickTimer, /querySelectorAll\('\.rec-timer'\)/,
    'the tick must update the existing nodes, not rebuild the list');
  // The order countdown modal counts against the same deadline.
  const startFn = fn(trade, 'startCountdown', '    ');
  assert.match(startFn, /order\.expires_at/, 'the countdown modal must use the contract expiry, not a local guess');
  assert.match(startFn, /isFinite\(until\)/, 'the modal must keep the duration as a fallback when the server sent no expiry');
  assert.match(css, /\.rec-timer\{/, 'the time left must be styled');
  assert.match(css, /tabular-nums/, 'the countdown digits must not shift sideways every second');

  // Run it, rather than only reading it. The formatting is the whole point of
  // the feature and a regex cannot tell 01:05 from 01::05.
  const fmtRemainSrc = fn(trade, 'fmtRemain', '    ');
  const fmtRemain = new Function('return (' + fmtRemainSrc + ')')();
  // Hours are zero-padded too, so the field keeps its width as it grows into
  // three digits and the digits never shuffle sideways.
  for (const [ms, want] of [[0, '00:00'], [999, '00:00'], [1000, '00:01'], [59999, '00:59'],
                            [60000, '01:00'], [65432, '01:05'], [599000, '09:59'],
                            [3599999, '59:59'], [3600000, '01:00:00'], [3661000, '01:01:01'],
                            [7205000, '02:00:05'], [86400000, '24:00:00'], [-5000, '00:00']]) {
    assert.equal(fmtRemain(ms), want, 'time left of ' + ms + 'ms must read ' + want);
  }
  // loadRecords' fallback when a contract carries no expires_at.
  const created = '2026-09-27T10:00:00.000Z';
  assert.equal(new Date(new Date(created).getTime() + 300 * 1000).toISOString(),
    '2026-09-27T10:05:00.000Z', 'a 300s order opens must expire 300s later');

  // ---- 9. A failed settlement explains itself and keeps the details ------
  const errNodes = {};
  const el2 = id => errNodes[id] || (errNodes[id] = { id, className: '', textContent: '', innerHTML: '', style: {} });
  const errCtx = {
    console, Promise, Math, Date, JSON, parseFloat, parseInt, String, Object, Array, RegExp, Number, isFinite,
    symbol: 'BTC', quoteUnit: 'USDT', dec: 2, direction: 'up', durationSec: 60, odds: 185,
    price: 101.5, buyPrice: 100, currentOrderId: null, records: [],
    tradeCfg: { showCountdownCurrentStatus: false },
    fmt: (n, d) => (parseFloat(n) || 0).toFixed(d == null ? 2 : d),
    num2: n => String(Math.round((parseFloat(n) || 0) * 100) / 100),
    escHtml: s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    renderRecords() {}, refreshTrade() {},
    document: { getElementById: el2, querySelector: () => null, querySelectorAll: () => [] },
    TrustApp: { settleTrade: () => Promise.reject(new Error('x')), refreshTrade() {} }
  };
  vm.createContext(errCtx);
  for (const n of ['escHtml', 'num2', 'setSettling', 'settleErrorText', 'renderUnsettled']) {
    vm.runInContext(fn(trade, n, '    '), errCtx);
  }
  // The raw PostgREST envelope must never reach a member.
  const raw = '{"code":"42804","details":null,"hint":"You will need to rewrite or cast the expression.",' +
    '"message":"column \\"status\\" is of type contract_status but expression is of type text"}';
  const said = errCtx.settleErrorText(new Error(raw));
  assert.ok(!said.includes('42804'), 'the PostgREST error code is not shown to the member: ' + said);
  assert.ok(!said.includes('{'), 'the raw JSON envelope is not shown to the member: ' + said);
  assert.ok(!said.includes('contract_status'), 'the SQL type name is not shown to the member: ' + said);
  assert.match(said, /still open/i);
  assert.match(said, /settle/i);
  assert.match(errCtx.settleErrorText(new Error('Failed to fetch')), /connection dropped/i);
  assert.match(errCtx.settleErrorText(new Error('order has not finished yet')), /not finished counting down/i);
  assert.match(errCtx.settleErrorText(new Error('unknown order')), /order history/i);
  assert.match(errCtx.settleErrorText(new Error('insufficient USDT balance')), /not enough balance/i);
  // The wording open_trade actually raises, not an invented one: it contains
  // "market", so a mapper that checked the market branch first would tell a member
  // with a running order that the market is unavailable.
  assert.match(errCtx.settleErrorText(new Error('an order for ETH is still running')), /already have an order running/i);
  assert.match(errCtx.settleErrorText(new Error('unknown market ETHUSDT, available: BTC, ETH')), /not available for trading/i);
  assert.match(errCtx.settleErrorText(new Error('unknown duration 900 for market ETH, available: 60, 120, 300')), /not available for trading/i);
  assert.match(errCtx.settleErrorText(new Error('function public.settle_trade does not exist')), /not available for trading/i);
  // An unrecognised message still comes through rather than being swallowed.
  assert.match(errCtx.settleErrorText(new Error('something nobody has seen')), /something nobody has seen/);
  // And the full trade details survive the failure, so the member can see what
  // they placed and quote the order id to support.
  errCtx.renderUnsettled('abcdef01-2345-6789-abcd-ef0123456789', 100, said);
  for (const label of ['Result', 'Market', 'Direction', 'Duration', 'Payout Rate',
                       'Purchase Amount', 'Purchase Price', 'Order ID', 'Status', 'Note']) {
    assert.ok(el2('resultInfo').innerHTML.includes('>' + label + '<'), 'a pending result must still show ' + label);
  }
  assert.equal(el2('resultTitle').textContent, 'Settlement Pending');
  assert.equal(el2('resultAmount').textContent, '--');
  assert.equal(el2('resultRetry').style.display, '', 'a retry is offered, since settling is idempotent');
  assert.match(el2('resultInfo').innerHTML, /abcdef01-2345-6789/, 'the order id is shown so support can find it');
  errCtx.setSettling(false);
  assert.equal(el2('settlingBox').style.display, 'none');

  // ---- 11. The currency an order is charged in -----------------------------
  // The metals and forex tabs showed "Balance: 0.00" and could not be traded at
  // all. Those products were quoted in USD, the order form read the USD balance,
  // and the stake was debited from USD too, so every metals and forex order was
  // refused as "insufficient USD balance: available 0" for a member holding a
  // large USDT balance. The 0.00 was the symptom; the unfundable stake was the bug.
  const sql21 = fs.readFileSync(path.join(sqlDir, '21_quote_currency_usdt.sql'), 'utf8');
  const sql21Code = sql21.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
  assert.match(sql21Code, /update public\.products set quote_coin = 'USDT'/,
    'every product must settle in the currency the wallet actually holds');
  // The server decides the currency. A request that can name the currency it is
  // debited in is what put a USD-denominated order on a USDT-only wallet.
  const open21 = sql21Code.split('create or replace function public.open_trade')[1].split('\nend $$')[0];
  assert.match(open21, /v_coin := coalesce\(nullif\(v_product\.quote_coin, ''\)/,
    'open_trade must take the currency from the product row');
  assert.match(open21, /post_ledger\(v_uid, v_coin, -p_amount/,
    'the stake must be debited in the currency the function resolved');
  assert.ok(!/post_ledger\(v_uid, coalesce\(p_coin/.test(open21),
    'the stake must not be debited in a currency the request chose');
  assert.ok(!/post_ledger\(v_uid, p_coin/.test(open21),
    'the client-supplied coin must not reach the ledger');
  // The same 8 refusals as migration 20: settling the currency is not a new
  // reason to refuse an order.
  const reasons21 = [...open21.matchAll(/raise exception '([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(reasons21.map(r => r.replace(/\s+/g, ' ')), reasons,
    'open_trade gained or lost a refusal while changing the currency');
  // The two USD-base FX crosses cannot be funded by a USDT wallet, so they are
  // left visible but not tradable rather than failing at the order.
  assert.match(sql21Code, /set is_active = false where symbol in \('USDCNY', 'USDJPY'\)/);
  // The market list must quote what the wallet holds, or the form reads a
  // balance that is not there.
  assert.ok(!/\{ s: 'XAU', n: 'USD'/.test(app), 'metals must not be quoted in a currency the wallet lacks');
  assert.ok(!/\{ s: 'EUR', n: 'USD'/.test(app), 'forex must not be quoted in a currency the wallet lacks');
  assert.match(app, /\{ s: 'XAU', n: 'USDT'/);
  assert.match(app, /\{ s: 'EUR', n: 'USDT'/);
  // n is the quote currency: rebuildFlat builds the pair as s + '/' + n. A
  // remote row put the display name there, giving pairs like "XAU/Gold".
  const parseItem = fn(app, 'parseItem', '  ');
  assert.match(parseItem, /n: trim\(row\.quote_coin\) \|\| trim\(row\.quote\) \|\| name/,
    'a remote market row must resolve its quote currency, not fall back to the display name');
  // An unfundable market must not answer to its bare symbol either, or ?s=USD
  // resolves to a currency cross no USDT balance can pay for.
  const rebuild = fn(app, 'rebuildFlat', '  ');
  assert.match(rebuild, /if \(!d\.x && !marketFlat\[d\.s\]\)/,
    'a market flagged x:1 must not claim its bare symbol');
  assert.match(app, /i: 'USD_CNY\.svg', x: 1 \}/, 'the USD-base crosses are marked untradable');

  // The order form: the currency comes from the market row, never the URL. A link
  // saved from an older build said XAU/USD and produced the 0.00 read.
  const tradeSetup = trade.slice(trade.indexOf('var pairIn ='), trade.indexOf('var currentInterval'));
  assert.match(tradeSetup, /var quoteUnit = alias;/,
    'the stake currency must come from the market row, not the URL pair');
  assert.ok(!/pairIn\.split\('\/'\)\[1\]/.test(tradeSetup),
    'the stake currency must not be taken from the URL');
  // products.quote_coin is what the server charges, so it outranks the market list.
  const syncOdds = fn(trade, 'syncOdds', '    ');
  assert.match(syncOdds, /if \(t\.coin && t\.coin !== quoteUnit\)/,
    'syncOdds must take the settlement currency from the products table');
  assert.match(syncOdds, /refreshWalletReadout\(\)/, 'a corrected currency must refresh the balance shown');
  // The number and the unit label were set in two places and the markup said USDT
  // while the number came from USD, so a full balance read as 0.00 USDT.
  assert.match(trade, /<span id="walletBalanceUnit">/, 'the balance unit must not be hard-coded in the markup');
  assert.ok(!/walletBalanceLabel">0\.00<\/b> USDT/.test(trade),
    'the balance label must not hard-code USDT next to a number read in another currency');
  const readout = fn(trade, 'refreshWalletReadout', '    ');
  assert.match(readout, /getBalance\(TrustApp\.getUserId\(\), quoteUnit\)/);
  assert.match(readout, /unit\.textContent = quoteUnit/,
    'the unit label must be written from the same currency as the number');
  // The two balance readers must go through the one helper, or they drift again.
  assert.ok(!/walletBalanceLabel'\)\.textContent = TrustApp\.getBalance/.test(trade),
    'no reader may set the balance without its unit');
  // And the reason an untradable market cannot be funded is explained, not
  // reported as insufficient funds.
  const mktCheck = fn(trade, 'marketCheck', '    ');
  assert.match(mktCheck, /if \(market && market\.x\)/);
  assert.match(mktCheck, /priced in/, 'an unfundable market must say why');
  assert.match(mktCheck, /Nothing was taken from your balance/);

  console.log('PASS: clean encoding, server-settled profit and details in the result modal, priced from the database, ' +
    'ledger-backed open/settle, admin profit-mode switch on both scopes, a non-destructive admin list rebuild, ' +
    'the contract_status enum cast, random() kept out of numeric arithmetic, 20/30/40 payouts, concurrent orders, ' +
    'background settlement, a settlement failure that explains itself, time left on every running order counted ' +
    'from the contract expiry, a due order actually settled instead of sitting on "Settling", a cancelled order ' +
    'reading as refunded rather than running, and metals and forex settling in the currency the wallet holds');
})().catch(e => { console.error(e); process.exitCode = 1; });
