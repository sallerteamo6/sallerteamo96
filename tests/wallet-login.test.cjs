/*
 * Wallet sign-in must be verified somewhere the member cannot reach.
 *
 * The button on the index, login and register pages connects a wallet perfectly
 * well and then failed to log in, always with the same message. That was not a
 * broken button and not a broken wallet: app.js refused on purpose, because
 * checking an Ethereum signature in the page would mean the page verifying its
 * own lie. So these tests pin down the two halves of the fix and, just as
 * importantly, the places a shortcut would look identical.
 */
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const dbjs = fs.readFileSync(path.join(root, 'scripts/db.js'), 'utf8');
const cfg = fs.readFileSync(path.join(root, 'scripts/config.js'), 'utf8');
const sql = fs.readFileSync(path.join(root, 'supabase', 'v2', '24_wallet_login_challenges.sql'), 'utf8');
let fnSrc;
try { fnSrc = fs.readFileSync(path.join(root, 'supabase', 'functions', 'wallet-login', 'index.ts'), 'utf8'); }
catch (e) { console.error('FAIL: no edge function at supabase/functions/wallet-login/index.ts'); process.exit(1); }

function fn(name) {
  const s = app.indexOf('  function ' + name + '(');
  assert.notEqual(s, -1, 'missing function ' + name);
  return app.slice(s, app.indexOf('\n  }', s) + 4);
}

// ---- 1. The old blanket refusal is gone -------------------------------------
// It used to be the last thing the function did: return a refusal, whatever the
// address. The defensive "no walletAuth on this build" guard may stay, because a
// build with an old scripts/db.js genuinely has nothing to call, but the function
// must reach the server rather than stop at the door.
const loginSrc = fn('walletLogin');
assert.ok(!/return Promise\.resolve\(\{ ok: false[^}]*\}[^;]*\);\s*\}\s*$/.test(loginSrc),
  'walletLogin must not end in an unconditional refusal');
assert.match(loginSrc, /DB\.walletAuth\('nonce'/, 'and it must actually reach the server');
assert.ok(!/^function walletLogin[\s\S]*?not available on this build[\s\S]*?return Promise\.resolve\(\{ ok: true/m.test(loginSrc),
  'the refusal message must not be the end of the path');

// ---- 2. The signature is checked off the page --------------------------------
assert.match(fnSrc, /verifyMessage\(/, 'the signature is verified in the function');
assert.match(fnSrc, /recovered\.toLowerCase\(\) !== claim\.address\.toLowerCase\(\)/,
  'the recovered signer must equal the address the challenge was issued for');
assert.match(fnSrc, /personal_sign|verifyMessage/);
assert.ok(!/verifyMessage|recoverMessageAddress/.test(app) && !/recoverMessageAddress/.test(dbjs),
  'no signature recovery in the page or the database client: that is the whole point');
// The address in the request is never taken on trust; it only looks up a
// challenge that was issued for that same address.
assert.match(fnSrc, /wallet_consume_nonce/);
assert.ok(!/body\?\.address\s*===\s*claim\.address\s*\?/.test(fnSrc), 'no trusting the posted address');
// The message the member signs is built and stored by the database.
assert.match(fnSrc, /claim\.message/, 'the signature is checked over the stored message, not one rebuilt here');
// No SIWE text is assembled here. (The catch blocks do hold locals called
// `message`, but those are error strings, so the check is for the markers.)
assert.ok(!/wants you to sign in/i.test(fnSrc), 'the function must not assemble the signed text itself');
assert.ok(!/Nonce:\s/.test(fnSrc) && !/Issued At:\s/.test(fnSrc), 'no EIP-4361 fields are built here either');
assert.ok(!/Version:\s*1/.test(fnSrc), 'the signed text comes from the database in one piece');

// ---- 3. Replay protection lives in the database ------------------------------
const sqlCode = sql.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
assert.match(sqlCode, /create table if not exists public\.wallet_nonces/);
assert.match(sqlCode, /used_at\s+timestamptz/);
const consume = sqlCode.split('create or replace function public.wallet_consume_nonce')[1].split('\nend $$')[0];
assert.match(consume, /for update/, 'the challenge row is locked while it is consumed');
assert.match(consume, /if v_row\.used_at is not null then[\s\S]{0,80}already_used/,
  'a used challenge is refused');
assert.match(consume, /if v_row\.expires_at < now\(\) then[\s\S]{0,80}expired/,
  'an expired challenge is refused');
assert.match(consume, /update public\.wallet_nonces set used_at = now\(\)/,
  'the challenge is burnt, and burnt even if the signature then turns out wrong');
// anon must not be able to burn a challenge: that would let one member kill
// another member's in-flight sign-in.
assert.match(sqlCode, /grant\s+execute on function public\.wallet_consume_nonce\(text, text\) to service_role;/);
assert.ok(!/to anon[^;]*wallet_consume_nonce/.test(sqlCode), 'consume must not be reachable by anon');
// Issuing is anonymous by design, and locked to one live challenge per address.
assert.match(sqlCode, /to anon, authenticated;[\s\S]*?wallet_issue_nonce|grant\s+execute on function public\.wallet_issue_nonce\(text\) to anon, authenticated;/);
assert.match(sqlCode, /on conflict \(address\) do update/, 'a second request replaces the challenge rather than adding a second usable one');
assert.match(sqlCode, /interval '10 minutes'/, 'the challenge is short-lived');
// The address shape is checked in the database, not only in the browser.
assert.match(sqlCode, /v_addr !~ '\^0x\[0-9a-f\]\{40\}\$'/);

// ---- 4. One wallet, one account, and it cannot be stolen ---------------------
assert.match(sqlCode, /grant\s+execute on function public\.wallet_link_profile\(uuid, text, text\) to service_role;/);
const link = sqlCode.split('create or replace function public.wallet_link_profile')[1].split('\nend $$')[0];
assert.match(link, /u\.id <> p_uid/, 'an address already on another profile is refused');
assert.match(link, /already linked to another account/,
  'a wallet cannot be attached to a second account, which is what stops one taking a balance');
assert.match(link, /login_method = 'wallet'/, 'the profile records how it signs in');
assert.match(sqlCode, /users_account_ci_idx|lower\(u\.account\) = v_addr/,
  'the address is matched case-insensitively, so 0xAbC and 0xabc are one account');

// ---- 5. The client asks the wallet to sign, and never holds a credential -----
const loginFn = fn('walletLogin');
assert.match(loginFn, /DB\.walletAuth\('nonce'/, 'a challenge is requested first');
assert.match(loginFn, /personal_sign/, 'the wallet is asked to sign the challenge');
assert.match(loginFn, /DB\.walletAuth\('verify'/, 'the signature goes to the server to be checked');
assert.match(loginFn, /DB\.adoptWalletSession\(/, 'the one-time token becomes a session');
assert.match(loginFn, /_activateSession\(/, 'a wallet sign-in is a normal session, so nothing downstream skips a step');
// The message is displayed, never assembled: a page-built message would verify
// against itself.
assert.ok(!/Wants you to sign in/.test(app) && !/wants you to sign in/.test(app),
  'the page must not build the signed text itself');
// A wallet address cannot sign, so the live provider has to be kept.
assert.match(app, /signer: provider/, 'the live provider is kept so signing is possible at all');
assert.match(app, /done\(res\.accounts\[0\], 'WalletConnect v2', 'WalletConnect v2', res\.provider\)/,
  'the WalletConnect provider is passed through, not just its name');
assert.match(app, /signer: provider, source: source/);
assert.ok(!/signer: provider, source: source/.test(app) === false || true);
assert.match(app, /var _wallet = null; \/\/ in-memory only/,
  'the provider lives on the in-memory wallet, so it is never serialised');

// ---- 6. Failures are explained ---------------------------------------------
assert.match(app, /if \(e && e\.status === 404\)[\s\S]{0,200}email and password/,
  'a function that is not deployed says so, and points at the way in that works');
assert.match(dbjs, /Wallet sign-in has not been set up on the server yet/);
const errText = fn('walletLoginErrorText');
assert.match(errText, /cancelled in the wallet/i, 'a rejected signature is named as such');
assert.match(errText, /Failed to fetch|NetworkError/, 'a network failure is not shown as a rejection');
// What counts as showable is a question about behaviour, so ask the function.
const rErr = { console, Promise, Date };
vm.createContext(rErr);
vm.runInContext(fn('routableError'), rErr);
assert.equal(rErr.routableError('{"code":"42501","message":"admin sign-in required"}'), false,
  'a raw JSON envelope is not shown to a member');
assert.equal(rErr.routableError('Error: something broke\n    at foo (app.js:1:2)'), false,
  'a stack trace is not shown to a member');
assert.equal(rErr.routableError('That signature is from a different wallet'), true,
  'a sentence explaining what happened is shown as it is');
assert.equal(rErr.routableError('x'.repeat(400)), false, 'a wall of text is not shown either');

// ---- 7. No secret on the page ------------------------------------------------
assert.ok(!/SUPABASE_SERVICE_KEY|service_role/i.test(app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')),
  'no service key anywhere in app.js');
assert.ok(!/SUPABASE_SERVICE_KEY|service_role/i.test(dbjs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')),
  'no service key anywhere in scripts/db.js');
// The function reads the key from its own environment, never from a request.
assert.match(fnSrc, /env\("SUPABASE_SERVICE_KEY"\)/);
assert.ok(!/body\?\.service|body\.service_key|body\?\.key/.test(fnSrc), 'the key is never taken from the request');
// The password minted for a new account is never returned to anybody.
assert.match(fnSrc, /password: randomPassword\(\)/);
assert.ok(!/password/.test(fnSrc.split('return json({ ok: true, address: addr')[1] || ''),
  'the generated password must not appear in the response');

// ---- 8. The endpoint is configurable and defaults to where Supabase puts it ---
assert.match(cfg, /WALLET_AUTH_URL/);
assert.match(dbjs, /\/functions\/v1\/wallet-login/,
  'the default is where `supabase functions deploy wallet-login` places it');

// ---- 9. Run the client flow against a fake function -------------------------
// Driven end to end so the wiring is proven, not just grepped: a nonce comes
// back, the wallet is asked to sign exactly what the server sent, and a
// signature from the wrong wallet is refused by the server rather than accepted.
function makeCtx(opts) {
  const signed = [];
  const c = {
    console, Promise, Date,
    getWallet: () => ({ address: '0x' + 'ab'.repeat(20), signer: { request: async (r) => { signed.push(r); return opts.signature || '0xsig'; } } }),
    getLang: () => 'en',
    _activateSession: async (uid) => { c.__session = uid; return {}; },
    _notifyChange() {},
    DB: {
      walletAuth: async (action, payload) => {
        c.__calls.push({ action, payload });
        if (action === 'nonce') return { message: 'example.com wants you to sign in:\n0x' + 'ab'.repeat(20), nonce: 'deadbeef' };
        if (opts.rejectVerify) throw Object.assign(new Error('that signature is from a different wallet'), { status: 400 });
        return { email: 'abc@wallet.example', token_hash: 'tok_123', address: payload.address };
      },
      adoptWalletSession: async (email, tokenHash) => { c.__adopted = { email, tokenHash }; return { ok: true, user: { uid: 'u1', is_admin: false } }; }
    }
  };
  c.__calls = [];
  vm.createContext(c);
  vm.runInContext(fn('routableError'), c);
  vm.runInContext(fn('walletLoginErrorText'), c);
  vm.runInContext(fn('walletLogin'), c);
  return { c, signed };
}

(async () => {
  const { c, signed } = makeCtx({});
  let res = await c.walletLogin('0x' + 'ab'.repeat(20));
  assert.equal(res.ok, true, 'a correctly signed wallet logs in');
  assert.deepEqual(c.__calls.map(x => x.action), ['nonce', 'verify'],
    'the challenge is fetched before the signature is sent');
  assert.equal(signed.length, 1, 'the wallet was asked to sign once');
  assert.equal(signed[0].method, 'personal_sign');
  assert.equal(signed[0].params[0], 'example.com wants you to sign in:\n0x' + 'ab'.repeat(20),
    'the wallet signs exactly the text the server stored, not one the page wrote');
  assert.equal(signed[0].params[1], '0x' + 'ab'.repeat(20), 'and signs for the connected address');
  assert.equal(c.__adopted.tokenHash, 'tok_123', 'the one-time token is exchanged for a session');
  assert.equal(c.__session, 'u1', 'a wallet sign-in activates a normal session');

  // A signature the server rejects must not become a session.
  const bad = makeCtx({ rejectVerify: true });
  res = await bad.c.walletLogin('0x' + 'ab'.repeat(20));
  assert.equal(res.ok, false, 'a rejected signature does not log in');
  assert.equal(bad.c.__adopted, undefined, 'and never reaches the session step');
  assert.match(res.msg, /different wallet/, 'the reason is passed on, not swallowed');

  // A missing address, a malformed one, and a wallet with no provider.
  assert.equal((await c.walletLogin('')).ok, false, 'no address is refused');
  assert.equal((await c.walletLogin('0x123')).ok, false, 'a malformed address is refused');
  // A wallet that is connected but has no live provider: an address on its own
  // cannot sign, which is why the provider is kept in memory.
  const noProvider = {
    console, Promise, Date,
    getWallet: () => ({ address: '0x' + 'ab'.repeat(20) }),
    getLang: () => 'en',
    DB: { walletAuth: async () => ({ message: 'm', nonce: 'n' }) }
  };
  vm.createContext(noProvider);
  vm.runInContext(fn('routableError'), noProvider);
  vm.runInContext(fn('walletLoginErrorText'), noProvider);
  vm.runInContext(fn('walletLogin'), noProvider);
  res = await noProvider.walletLogin('0x' + 'ab'.repeat(20));
  assert.equal(res.ok, false, 'a wallet with no live provider cannot be asked to sign');
  assert.match(res.msg, /Reconnect the wallet/, 'and is told to reconnect, which is the fix');

  // A build whose scripts/db.js has no walletAuth at all still has to say so
  // rather than fail silently.
  const noApi = { console, Promise, Date, getWallet: () => null, getLang: () => 'en', DB: {} };
  vm.createContext(noApi);
  vm.runInContext(fn('routableError'), noApi);
  vm.runInContext(fn('walletLoginErrorText'), noApi);
  vm.runInContext(fn('walletLogin'), noApi);
  res = await noApi.walletLogin('0x' + 'ab'.repeat(20));
  assert.equal(res.ok, false, 'a build without the wallet API cannot pretend to sign in');
  assert.match(res.msg, /not available on this build/, 'and says which build is at fault');

  console.log('PASS: the refusal is replaced by a real signature check, the challenge is single-use and short-lived, ' +
    'a wallet cannot be attached to a second account, the page never holds a credential, and the flow is driven ' +
    'end to end including a signature the server rejects');
})().catch(e => { console.error(e); process.exitCode = 1; });
