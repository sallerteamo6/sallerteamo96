/*
 * Post-install verification for backend v2.
 *
 * Reads the project with the anon key only, so it verifies what a browser can
 * actually see. That is the point: if RLS is misconfigured, this fails even
 * though the tables exist.
 *
 * Needs the Project URL and the anon key. Both are safe to pass here — the anon
 * key ships in config.js. The service key is NOT needed and must not be passed:
 * it would bypass RLS and make every check below pass regardless of policy.
 *
 *   PowerShell:
 *     $env:SUPABASE_URL="https://mpiqktgpgmbsljqgypzk.supabase.co"
 *     $env:SUPABASE_ANON_KEY="eyJ..."
 *     node scripts/verify.mjs
 *
 * Exit code 0 = every check passed. Non-zero = count the failures.
 */

const URL_ = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_ANON_KEY || '';

if (!URL_ || !KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY.');
  process.exit(1);
}

const headers = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

let pass = 0;
let fail = 0;

function ok(name, extra) {
  pass++;
  console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : ''));
}
function bad(name, detail) {
  fail++;
  console.log('  FAIL  ' + name + '\n          ' + detail);
}

async function get(path) {
  const res = await fetch(URL_ + '/rest/v1/' + path, { headers });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { /* keep null */ }
  return { status: res.status, body, raw: text };
}

async function tableExists(name) {
  const r = await get(name + '?select=*&limit=1');
  if (r.status === 200) return { exists: true, rows: r.body.length };
  if (r.status === 404 && /PGRST205|Could not find the table/.test(r.raw)) {
    return { exists: false, code: 'PGRST205' };
  }
  return { exists: true, denied: r.status, raw: r.raw.slice(0, 120) };
}

async function main() {
  console.log('Verifying ' + URL_ + '\n');

  // ---- 1. every table the schema creates ----
  console.log('1. Tables exist');
  const tables = [
    'users', 'balances', 'ledger_entries', 'coin_addresses', 'transactions',
    'products', 'product_durations', 'contracts', 'investment_products',
    'investments', 'loans', 'verifications', 'chat_threads', 'chat_messages',
    'app_settings', 'audit_log'
  ];
  const missing = [];
  for (const t of tables) {
    const r = await tableExists(t);
    if (!r.exists) { bad('table ' + t, 'does not exist — has 01_schema.sql been run?'); missing.push(t); }
    else if (r.denied) { ok('table ' + t, 'exists, RLS denies anon (correct)'); }
    else { ok('table ' + t, r.rows + ' row(s)'); }
  }

  if (missing.length) {
    console.log('\n' + missing.length + ' table(s) missing. Run the files in order 01 -> 06 and stop.');
    process.exit(1);
  }

  // ---- 2. RLS must be on everywhere ----
  console.log('\n2. Row level security is denying anonymous reads');
  // These are the tables that must NOT be world-readable. v1 exposed every one
  // of them, and every user record on the platform, through the anon key.
  const secret = ['users', 'balances', 'ledger_entries', 'transactions', 'contracts',
                   'investments', 'loans', 'verifications', 'chat_messages', 'audit_log'];
  const leaks = [];
  for (const t of secret) {
    const r = await get(t + '?select=*&limit=1');
    if (r.status === 200 && Array.isArray(r.body) && r.body.length > 0) {
      leaks.push(t);
      bad(t + ' returns rows to the anon key',
        r.body.length + ' row(s) leaked: ' + JSON.stringify(r.body[0]).slice(0, 140));
    } else if (r.status === 200) {
      ok(t + ' readable but empty', 'no rows yet');
    } else {
      ok(t + ' denied to anon', 'HTTP ' + r.status);
    }
  }

  // ---- 3. reference data must be public ----
  console.log('\n3. Public reference data is readable signed out');
  for (const t of ['coin_addresses', 'products', 'product_durations',
                   'investment_products', 'app_settings']) {
    const r = await get(t + '?select=*&limit=1');
    if (r.status === 200) ok(t + ' publicly readable', (r.body || []).length + ' row(s)');
    else bad(t + ' not readable while signed out', 'HTTP ' + r.status + ' — the deposit page needs this: ' + r.raw.slice(0, 120));
  }

  // ---- 4. seed data landed ----
  console.log('\n4. Seed data');
  const prods = await get('products?select=symbol,price_symbol,payout_pct&order=sort_order');
  if (prods.status === 200 && (prods.body || []).length) {
    ok('products seeded', prods.body.length + ' markets');
    const noPrice = prods.body.filter((p) => !p.price_symbol);
    if (noPrice.length) {
      bad('every product has price_symbol',
        noPrice.map((p) => p.symbol).join(', ') + ' — scripts/settle.mjs cannot quote these');
    } else {
      ok('every product has price_symbol', 'settlement can price all of them');
    }
  } else {
    bad('products seeded', 'run 05_seed.sql (HTTP ' + prods.status + ')');
  }

  const addrs = await get('coin_addresses?select=coin,network,address&order=coin');
  if (addrs.status === 200 && (addrs.body || []).length) {
    const placeholders = (addrs.body || []).filter((a) => /^CHANGE_ME/.test(a.address || ''));
    if (placeholders.length) {
      bad('deposit addresses are real',
        placeholders.length + ' placeholder(s) still in coin_addresses: ' +
        placeholders.map((a) => a.coin + '/' + a.network).join(', ') +
        ' — replace these or deposits go to wallets nobody controls');
    } else {
      ok('deposit addresses look real', (addrs.body || []).length + ' address(es)');
    }
  } else {
    bad('coin_addresses seeded', 'run 05_seed.sql (HTTP ' + addrs.status + ')');
  }

  // ---- 5. auth must be able to create accounts ----
  console.log('\n5. Auth');
  try {
    const res = await fetch(URL_.replace(/\/rest\/v1$/, '') + '/auth/v1/settings',
                            { headers: { apikey: KEY } });
    const s = await res.json();
    // GoTrue reports the email provider either as a bare boolean or as an
    // object with .enabled depending on version, so accept either. Testing
    // only .enabled read `true.enabled` -> undefined and reported a working
    // provider as switched off.
    const em = s.external && s.external.email;
    const emailOn = em === true || !!(em && em.enabled === true);
    if (emailOn) ok('email sign-in enabled');
    else bad('email sign-in enabled', 'the Email provider is off in Authentication -> Providers');
    if (s.disable_signup) bad('signups allowed', 'signups are disabled');
    else ok('signups allowed');
    console.log('        confirm-email on: ' + !s.mailer_autoconfirm +
      ' — with it on, signUp returns no session and the user must click a link first');
  } catch (e) {
    bad('auth reachable', e.message);
  }

  // ---- summary ----
  console.log('\n' + '-'.repeat(58));
  console.log('passed ' + pass + '   failed ' + fail);

  if (leaks.length) {
    console.log('\nSECURITY: the anon key can read ' + leaks.join(', ') +
      '.\nEvery visitor could read these tables. Check that 02_rls.sql ran, and\n' +
      'that Data API Settings has DB_PRIVILEGE = anon rather than postgres.');
  }
  if (fail === 0) console.log('All checks passed. Next: sign up, then promote yourself —\n  select public.promote_first_admin(\'your-email\');');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('verify crashed: ' + e.message); process.exit(1); });
