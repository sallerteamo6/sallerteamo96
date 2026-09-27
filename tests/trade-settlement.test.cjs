const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const path = require('node:path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const dbjs = fs.readFileSync(path.join(root, 'scripts/db.js'), 'utf8');
const trade = fs.readFileSync(path.join(root, 'trade.html'), 'utf8');
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

  console.log('PASS: clean encoding, server-settled profit and details in the result modal, priced from the database, ' +
    'ledger-backed open/settle, admin profit-mode switch on both scopes, a non-destructive admin list rebuild, ' +
    'the contract_status enum cast, and a settlement failure that explains itself');
})().catch(e => { console.error(e); process.exitCode = 1; });
