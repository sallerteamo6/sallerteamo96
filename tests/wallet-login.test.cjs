/* Node 22.13+ / 24: execute real client and Edge Function code against mocked
 * wallet, Auth REST and database boundaries. No live accounts or funds are used.
 * Signature recovery is injected here; ethers performs it in production.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const dbSource = fs.readFileSync(path.join(root, 'scripts/db.js'), 'utf8');
const login = fs.readFileSync(path.join(root, 'login.html'), 'utf8');
const edge = stripTypeScriptTypes(fs.readFileSync(path.join(root, 'supabase/functions/wallet-login/index.ts'), 'utf8').replace(/^import .*;\n/m, ''));
const address = '0x' + 'ab'.repeat(20);
const otherAddress = '0x' + 'cd'.repeat(20);
const signature = '0x' + '11'.repeat(65);
function appFn(name) {
  const start = app.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf('\n  }', start) + 4);
}
function pageFn(name) {
  const start = login.indexOf('    function ' + name + '(');
  return login.slice(start, login.indexOf('\n    }', start) + 6);
}
function json(value, status = 200) { return new Response(JSON.stringify(value), {status}); }
function server(options = {}) {
  const state = { users: [], profiles: [], tokens: new Map(), challenges: new Map(), calls: [], recovery: [], sequence: 0 };
  const env = { SUPABASE_URL: 'https://db.example', SITE_URL: 'https://site.example',
    ...(options.secretMap ? {SUPABASE_SECRET_KEYS: '{"default":"sb_secret_test"}'} : {SUPABASE_SERVICE_ROLE_KEY: 'server.role.key'}) };
  const context = { Request, Response, URL, Uint8Array, crypto, console: {error() {}},
    Deno: { env: {get: name => env[name]}, serve: fn => { state.handler = fn; } },
    verifyMessage(message, sig) {
      state.recovery.push({message, sig});
      if (options.invalidSignature) throw new Error('invalid signature');
      assert.equal(sig, signature);
      return options.wrongSigner ? otherAddress : address;
    },
    fetch: async (url, init) => {
      const endpoint = new URL(url).pathname;
      const body = JSON.parse(init.body || '{}');
      state.calls.push({endpoint, body});
      assert.equal(init.headers.apikey, options.secretMap ? 'sb_secret_test' : 'server.role.key');
      assert.equal(init.headers.Authorization, options.secretMap ? undefined : 'Bearer server.role.key');
      if (endpoint.endsWith('/wallet_issue_nonce')) {
        assert.equal(body.p_origin, env.SITE_URL);
        const nonce = String(++state.sequence);
        const challenge = {ok: true, address: body.p_address, nonce, message: 'Sign in to ' + body.p_origin + '\nNonce: ' + nonce, expires_at: '2099-01-01T00:00:00Z'};
        state.challenges.set(body.p_address, challenge);
        return json(challenge);
      }
      if (endpoint.endsWith('/wallet_consume_nonce')) {
        const ch = state.challenges.get(body.p_address);
        if (!ch) return json({ok: false, reason: 'no_challenge'});
        if (ch.used) return json({ok: false, reason: 'already_used'});
        if (options.expired) return json({ok: false, reason: 'expired'});
        if (ch.nonce !== body.p_nonce) return json({ok: false, reason: 'bad_nonce'});
        ch.used = true; return json(ch);
      }
      if (endpoint.endsWith('/wallet_user_email')) {
        const row = state.users.find(u => u.app_metadata?.wallet_address === body.p_address || state.profiles.some(p => p.id === u.id && p.account === body.p_address && p.login_method === 'wallet'));
        return json(row ? {uid: row.id, email: row.email} : null);
      }
      if (endpoint.endsWith('/admin/users')) {
        assert.equal(state.recovery.length > 0, true, 'no account before signature verification');
        assert.equal(body.app_metadata.wallet_address, address);
        const user = {id: '00000000-0000-4000-8000-' + String(state.users.length + 1).padStart(12, '0'), ...body};
        state.users.push(user);
        // Simulate missing on_auth_user_created trigger: the link RPC must
        // still be called to create the public profile before a token is issued.
        return json(user);
      }
      if (endpoint.endsWith('/wallet_link_profile')) {
        if (options.profileFailure) { options.profileFailure = false; return json({message: 'temporary profile write failure'}, 500); }
        if (options.suspended) return json({message: 'this account is suspended or banned'}, 403);
        const u = state.users.find(u => u.id === body.p_uid);
        assert.ok(u); assert.equal(body.p_email, u.email);
        let row = state.profiles.find(p => p.id === u.id);
        if (!row) { row = {id: u.id, uid_code: '123456', is_admin: false, status: 'active'}; state.profiles.push(row); }
        Object.assign(row, {account: body.p_address, email: u.email, login_method: 'wallet', is_guest: false});
        return json({ok: true, uid: row.id, account: row.account});
      }
      if (endpoint.endsWith('/admin/generate_link')) {
        const user = state.users.find(u => u.email === body.email);
        assert.ok(state.profiles.some(p => p.id === user.id), 'a durable profile exists before minting a token');
        const token = 'token-' + (++state.sequence);
        state.tokens.set(token, user);
        if (options.noToken) return json({id: user.id});
        return json(options.sdkShape ? {user: {id: user.id}, properties: {hashed_token: token}} : {id: user.id, hashed_token: token});
      }
      throw new Error('Unexpected request: ' + endpoint);
    }
  };
  vm.runInNewContext(edge, context, {filename: 'wallet-login/index.ts'});
  state.call = async (action, extra = {}) => state.handler(new Request('https://db.example/functions/v1/wallet-login', {method: 'POST', body: JSON.stringify({action, address, ...extra})}));
  return state;
}
function client(s, options = {}) {
  const c = {console, Promise, Date, URL, URLSearchParams, TextEncoder, AbortController, setTimeout, clearTimeout};
  const buttons = {walletBtn: {disabled: false, classList: {add() {}, remove() {}}}, walletText: {textContent: ''}};
  c.window = {location: {href: 'https://site.example/login.html', origin: 'https://site.example', search: ''}, AppConfig: {walletLoginEnabled: true}};
  c.document = {getElementById: id => buttons[id] || null};
  c.fetch = async (url, init) => {
    if (init.method === 'GET') {
      c.diagnostics = (c.diagnostics || 0) + 1;
      assert.equal(init.body, undefined);
      assert.equal(init.headers, undefined);
      assert.equal(init.credentials, 'omit');
      if (options.offline) throw new Error('Failed to fetch');
      return json({}, options.preflightStatus || 405);
    }
    c.sent.push(JSON.parse(init.body));
    if (options.preflightStatus) throw new TypeError('Failed to fetch');
    if (options.offline) throw new Error('Failed to fetch');
    if (options.httpStatus) return json({message: 'Server unavailable'}, options.httpStatus);
    return s.handler(new Request(url, init));
  };
  Object.assign(c, {sent: [], toasts: [], signed: [], qrCalls: 0, activated: [], _wallet: null,
    _connectBusy: false, _connectPromise: null, _walletLoginPromise: null,
    t: key => key === 'wallet.loginSuccess' ? 'Wallet login successful' : 'Connect Wallet',
    toast: (kind, msg) => c.toasts.push({kind, msg}),
    getLang: () => 'en', providerDisplayName: () => 'Test wallet', closeWalletConnect() {},
    _activateSession: async uid => { c.activated.push(uid); }, dbReadable: () => true});
  const provider = {request: async request => {
    if (request.method === 'eth_requestAccounts' || request.method === 'eth_accounts') {
      if (options.rejectConnection) throw Object.assign(new Error('User rejected connection'), {code: 4001});
      return [address];
    }
    assert.equal(request.method, 'personal_sign');
    c.signed.push(request);
    if (options.signGate) await options.signGate;
    if (options.rejectSignature) throw Object.assign(new Error('User rejected request'), {code: 4001});
    assert.match(request.params[0], /^0x[0-9a-f]+$/);
    return signature;
  }};
  c.waitForInjectedProvider = async () => options.qr ? null : {provider, source: 'test'};
  c.connectViaWalletConnect = async () => { c.qrCalls++; return {provider, accounts: [address]}; };
  vm.createContext(c); vm.runInContext(dbSource, c);
  const db = c.DB;
  db.ENABLED = true; db.anon = options.publishable ? 'sb_publishable_test' : 'public.anon.key'; db.url = 'https://db.example';
  db._cache.users = [];
  db._waitForClient = async () => ({auth: {
    verifyOtp: async ({token_hash, type}) => {
      assert.equal(type, 'email');
      const user = s.tokens.get(token_hash);
      if (!user) return {data: {}, error: {message: 'Token invalid'}};
      s.tokens.delete(token_hash);
      if (options.noSession) return {data: {user, session: null}, error: null};
      return {data: {user, session: {access_token: 'signed.session.token', user}}, error: null};
    },
    signOut: async () => { c.signedOut = true; }
  }});
  db.q = async route => {
    assert.match(route, /^users\?id=eq\./);
    return options.missingProfile ? [] : s.profiles;
  };
  db._bootstrap = async () => true;
  db._dispatchTrustSync = name => { c.lastSync = name; };
  for (const name of ['getWallet', 'getUserId', 'isLoggedIn', 'walletReturnUrl', 'connectWallet', 'applyWalletBtn', 'walletLogin', 'walletLoginErrorText', 'routableError', 'dbUserToApp', 'getUsers']) vm.runInContext(appFn(name), c);
  c.buttons = buttons; return c;
}

test('one click creates a saved wallet profile, real session and visible admin row', async () => {
  const s = server(), c = client(s);
  const out = await c.connectWallet({redirect: false});
  assert.equal(out.ok, true);
  assert.equal(c.signed.length, 1);
  assert.deepEqual(c.sent.map(x => x.action), ['nonce', 'verify']);
  assert.equal(Buffer.from(c.signed[0].params[0].slice(2), 'hex').toString(), s.recovery[0].message);
  assert.equal(c.DB._uid(), s.users[0].id);
  assert.equal(c.activated[0], s.users[0].id);
  assert.equal(c.getUsers().length, 1);
  assert.equal(c.getUsers()[0].account, address);
  assert.equal(c.getUsers()[0].uid_code, '123456');
  assert.equal(c.getUsers()[0].isGuest, false);
  const start = fs.readFileSync(path.join(root, 'admin-users.html'), 'utf8').indexOf('    function accCell(');
  const admin = fs.readFileSync(path.join(root, 'admin-users.html'), 'utf8');
  const a = {TrustApp: {isUserAdmin: () => false}, esc: s => String(s), memberNo: u => u.uid_code};
  vm.createContext(a); vm.runInContext(admin.slice(start, admin.indexOf('\n    }', start) + 6), a);
  assert.match(a.accCell(c.getUsers()[0]), /WALLET/);
  assert.match(a.accCell(c.getUsers()[0]), /123456/);
  assert.equal(c.qrCalls, 0, 'no second wallet connection in the background');
});

test('double click and concurrent walletLogin share one challenge and one signature', async () => {
  let release; const gate = new Promise(r => {release = r;});
  const s = server(), c = client(s, {signGate: gate});
  const first = c.connectWallet({redirect: false}), second = c.connectWallet({redirect: false});
  assert.equal(first, second);
  while (!c.signed.length) await new Promise(r => setImmediate(r));
  const concurrent = c.walletLogin(address);
  assert.equal(c.sent.length, 1);
  release();
  const values = await Promise.all([first, second, concurrent]);
  assert.ok(values.every(x => x.ok));
  assert.equal(c.signed.length, 1); assert.equal(s.users.length, 1);
});

test('cancelled signature displays an error and retry works without a second account', async () => {
  const options = {rejectSignature: true}, s = server(), c = client(s, options);
  assert.equal((await c.connectWallet({redirect: false})).ok, false);
  assert.equal(c.buttons.walletText.textContent, 'Connect Wallet');
  assert.equal(c.buttons.walletBtn.disabled, false);
  assert.ok(c.toasts.every(x => x.kind !== 'success'));
  assert.match(c.toasts.at(-1).msg, /cancelled/); assert.equal(s.users.length, 0);
  options.rejectSignature = false;
  assert.equal((await c.connectWallet({redirect: false})).ok, true);
  assert.equal(s.users.length, 1);
});

test('connection rejection stops before any sign-in challenge', async () => {
  const c = client(server(), {rejectConnection: true});
  assert.equal((await c.connectWallet({redirect: false})).ok, false);
  assert.equal(c.sent.length, 0); assert.equal(c.qrCalls, 0);
});

test('returning wallet gets the same account and member number', async () => {
  const s = server();
  const one = await client(s).connectWallet({redirect: false});
  const two = await client(s).connectWallet({redirect: false});
  assert.equal(two.user.uid, one.user.uid);
  assert.equal(two.user.uid_code, one.user.uid_code);
  assert.equal(s.users.length, 1);
});

test('interrupted profile write is recovered through server metadata on retry', async () => {
  const s = server({profileFailure: true}), c = client(s);
  assert.equal((await c.connectWallet({redirect: false})).ok, false);
  assert.equal(s.users.length, 1); assert.equal(s.profiles.length, 0);
  assert.equal((await c.connectWallet({redirect: false})).ok, true);
  assert.equal(s.users.length, 1); assert.equal(s.profiles.length, 1);
});

for (const options of [{wrongSigner: true}, {invalidSignature: true}, {expired: true}]) test('reject unauthorized signature/challenge: ' + JSON.stringify(options), async () => {
  const s = server(options), c = client(s);
  assert.equal((await c.connectWallet({redirect: false})).ok, false);
  assert.equal(s.users.length, 0); assert.equal(c.activated.length, 0);
});

test('replayed challenge cannot mint another session', async () => {
  const s = server();
  const challenge = await (await s.call('nonce')).json();
  assert.equal((await s.call('verify', {nonce: challenge.nonce, signature})).status, 200);
  assert.equal((await s.call('verify', {nonce: challenge.nonce, signature})).status, 400);
  assert.equal(s.tokens.size, 1);
});

for (const options of [{missingProfile: true}, {noSession: true}, {httpStatus: 404}, {httpStatus: 401}, {offline: true}]) test('no false login success: ' + JSON.stringify(options), async () => {
  const s = server(), c = client(s, options);
  const out = await c.connectWallet({redirect: false});
  assert.equal(out.ok, false); assert.equal(c.activated.length, 0);
  assert.equal(c.buttons.walletBtn.disabled, false);
  assert.ok(c.toasts.every(x => x.kind !== 'success'));
  if (options.missingProfile) { assert.equal(c.signedOut, true); assert.equal(c.DB._uid(), null); }
});

test('QR fallback and new Supabase key formats complete the same login', async () => {
  const s = server({secretMap: true}), c = client(s, {qr: true, publishable: true});
  assert.equal((await c.connectWallet({redirect: false})).ok, true);
  assert.equal(c.qrCalls, 1); assert.equal(c.signed.length, 1);
});

test('raw Auth REST and SDK-shaped link responses both return tokens', async () => {
  for (const sdkShape of [false, true]) {
    const c = client(server({sdkShape})); assert.equal((await c.connectWallet({redirect: false})).ok, true);
  }
  assert.equal((await client(server({noToken: true})).connectWallet({redirect: false})).ok, false);
});

test('suspended wallet cannot be reactivated by login', async () => {
  const s = server({suspended: true}), c = client(s);
  const out = await c.connectWallet({redirect: false});
  assert.equal(out.ok, false); assert.match(out.msg, /suspended/);
  assert.equal(s.tokens.size, 0);
});

test('login page awaits one connection and its retry button retries wallet auth', async () => {
  let resolve; let calls = 0; let retry;
  const button = {disabled: false, textContent: ''};
  const c = {Promise, walletAttempt: null, document: {getElementById: () => button},
    say: (kind, msg, label, fn) => {retry = fn;},
    TrustApp: {connectWallet: () => {calls++; return new Promise(r => {resolve = r;});}}, setTimeout() {}};
  vm.createContext(c); vm.runInContext(pageFn('doWalletLogin'), c);
  const a = c.doWalletLogin(), b = c.doWalletLogin();
  assert.equal(a, b); await Promise.resolve(); assert.equal(calls, 1);
  assert.equal(button.disabled, true);
  resolve({ok: false, msg: 'cancelled'}); await a;
  assert.equal(button.disabled, false); assert.equal(retry, c.doWalletLogin);
  const again = retry(); await Promise.resolve(); assert.equal(calls, 2);
  resolve({ok: true}); await again; assert.equal(button.textContent, 'Signed in');
});

test('wallet redirect only allows the same website', () => {
  const c = client(server());
  c.window.location.search = '?r=' + encodeURIComponent('https://attacker.example');
  assert.equal(c.walletReturnUrl(), 'index.html');
  c.window.location.search = '?r=' + encodeURIComponent('trade.html');
  assert.equal(c.walletReturnUrl(), 'https://site.example/trade.html');
});

test('deployment and migration retain authentication boundaries', () => {
  const config = fs.readFileSync(path.join(root, 'supabase/config.toml'), 'utf8');
  assert.match(config, /\[functions.wallet-login\][\s\S]*verify_jwt\s*=\s*false/);
  const sql = fs.readFileSync(path.join(root, 'supabase/v2/26_wallet_login_repair.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.match(sql, /raw_app_meta_data/); assert.doesNotMatch(sql, /raw_user_meta_data/);
  assert.match(sql, /insert into public.users[\s\S]+on conflict \(id\) do update/);
  assert.match(sql, /login_method = 'wallet', is_guest = false/);
  assert.doesNotMatch(sql, /update public\.balances|set is_admin|uid_code\s*=/i);
  for (const [name, args] of [['wallet_issue_nonce', 'text, text'], ['wallet_user_email', 'text'], ['wallet_link_profile', 'uuid, text, text']]) {
    assert.ok(sql.includes(`revoke all on function public.${name}(${args}) from public, anon, authenticated;`));
    assert.ok(sql.includes(`grant execute on function public.${name}(${args}) to service_role;`));
  }
});

test('bundled Supabase SDK exchanges the token and restores the wallet session after reload', async () => {
  const {createClient} = new Function(fs.readFileSync(path.join(root, 'scripts/vendor/supabase.umd.js'), 'utf8') + '; return supabase;')();
  const s = server(), c = client(s);
  const memory = new Map();
  const storage = {getItem: k => memory.get(k) || null, setItem: (k, v) => memory.set(k, v), removeItem: k => memory.delete(k)};
  const sdkOptions = {auth: {storage, storageKey: 'wallet-login-test', persistSession: true, autoRefreshToken: false, detectSessionInUrl: false},
    global: {fetch: async (url, init) => {
      assert.match(String(url), /\/auth\/v1\/verify$/);
      const payload = JSON.parse(init.body);
      assert.equal(payload.type, 'email');
      const authUser = s.tokens.get(payload.token_hash);
      assert.ok(authUser); s.tokens.delete(payload.token_hash);
      const user = {id: authUser.id, email: authUser.email, aud: 'authenticated', role: 'authenticated', app_metadata: authUser.app_metadata, user_metadata: authUser.user_metadata};
      const encode = data => Buffer.from(JSON.stringify(data)).toString('base64url');
      const access_token = encode({alg: 'HS256', typ: 'JWT'}) + '.' + encode({sub: user.id, email: user.email, role: 'authenticated', exp: Math.floor(Date.now()/1000) + 3600}) + '.dGVzdA';
      return json({access_token, refresh_token: 'refresh-test-only', expires_in: 3600, token_type: 'bearer', user});
    }}};
  const sdk = createClient('https://db.example', 'public.anon.key', sdkOptions);
  c.DB._waitForClient = async () => sdk;
  const result = await c.connectWallet({redirect: false});
  assert.equal(result.ok, true);
  assert.ok(memory.get('wallet-login-test'));
  // A new client instance reads persisted Auth storage, as a reloaded page does.
  const reloaded = createClient('https://db.example', 'public.anon.key', sdkOptions);
  const {data, error} = await reloaded.auth.getSession();
  assert.equal(error, null);
  assert.equal(data.session.user.id, result.user.uid);
  assert.equal(data.session.user.email, s.users[0].email);
  assert.equal(s.users.length, 1);
  sdk.auth.stopAutoRefresh(); reloaded.auth.stopAutoRefresh();
});

for (const status of [404, 401, 403, 405]) test('failed browser preflight reveals real server status ' + status, async () => {
  const s = server(), c = client(s, {preflightStatus: status});
  const result = await c.connectWallet({redirect: false});
  assert.equal(result.ok, false);
  assert.equal(c.diagnostics, 1);
  assert.equal(c.sent.length, 1, 'diagnosis never retries a sign-in POST');
  assert.equal(c.signed.length, 0);
  assert.equal(c.activated.length, 0);
  assert.equal(s.users.length, 0);
  assert.doesNotMatch(result.msg, /check your connection/i);
  assert.match(result.msg, status === 404 ? /not set up|not been enabled/ : (status === 405 ? /reachable.*blocked/ : /access is not configured/));
});
