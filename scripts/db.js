/*
 * TrustDB — backend v2 adapter.
 *
 * Keeps the v1 public API (method names, argument order, return shapes, the
 * `trustsync:<name>` events) so app.js needs only a small set of targeted edits
 * rather than a rewrite. Everything underneath is different: Supabase Auth
 * instead of the sessions table, RLS-scoped reads instead of a full-table
 * fetch, and RPCs instead of direct writes.
 *
 * ---------------------------------------------------------------------------
 * What changed underneath, and why
 * ---------------------------------------------------------------------------
 * Identity. v1 had a `sessions` table holding a token the browser minted itself
 * and a `users` table holding a password that was base64, not hashed. Both are
 * gone. Supabase Auth (GoTrue) owns credentials and signs a JWT the browser
 * cannot forge, so `auth.uid()` is trustworthy and every policy keys off it.
 * The v1 `uid` was a 6-digit number; the v2 primary key is a uuid. Every method
 * that took a uid now takes that uuid as a string, and callers that used to do
 * `parseInt(uid)` must stop.
 *
 * Reads. v1 pulled every row of every table on boot, because the anon key could
 * read them all. RLS makes that impossible now, and correctly so: a non-admin
 * sees their own rows, an admin sees everything. So a signed-out visitor gets
 * coin addresses, products and settings, and nothing else, and the signed-in
 * user's own data arrives after the session resolves.
 *
 * Writes. v1 wrote balances by reading a row, adding a delta in JavaScript, and
 * posting the total back — the classic lost-update race, and the reason the
 * comments in the old file were full of defensive workarounds. v2 has no INSERT
 * or UPDATE policy on balances at all. Money moves only through
 * post_ledger, reachable solely through the audited RPCs. The client no longer
 * computes a balance; it states an intent and the database does the arithmetic
 * under a row lock.
 *
 * Settlement. `settle_contract` is service-role only. If a client could settle,
 * a user would simply declare their losing contract a winner. scripts/settle.mjs
 * settles on a timer with the service key, so `updateTrade` here no longer pays
 * anything out.
 */
var TrustDB = (function () {
  'use strict';

  var self = {
    url: null,
    anon: null,
    service: null,
    ENABLED: false,
    READONLY: false,
    connected: false,
    lastSync: 0,

    // ---- diagnostics ----------------------------------------------------
    // Bumped whenever the auth/bootstrap path changes, so a page can prove
    // which build the browser actually loaded. A stale cached db.js was
    // indistinguishable from a bug that had not been fixed yet.
    VERSION: 'v2.6.2-wallet-deployment-diagnostics',
    _diag: [],
    _diagLog: function (msg) {
      try {
        var t = (typeof performance !== 'undefined' && performance.now)
          ? Math.round(performance.now()) : 0;
        this._diag.push(t + 'ms  ' + msg);
        if (this._diag.length > 80) this._diag.shift();
      } catch (e) {}
      return msg;
    },
    diag: function () { return (this._diag || []).slice(); },

    // The signed-in GoTrue user, or null. There is no numeric uid any more.
    _authUser: null,
    isAdmin: false,

      // Local caches, same shape as v1 so app.js's readers keep working.
      _cache: {
        users: [],
        userBalances: {},
        verifications: {},
        loans: [],
        transactions: [],
        trades: [],
        aiOrders: [],
        chatMessages: {},
        coinAddresses: {},
        adminSettings: {},
        // v2 names, kept separate from the v1 aliases above so a page reading
        // DB._cache.trades and a page reading DB._cache.contracts both work.
        contracts: [],
        investments: [],
        products: [],
        investmentProducts: []
      },

    _channels: {},
    _rowAt: {},
    _threadCache: {},

    // v1 table name -> v2 table name, for pullBlob and the trustsync events.
    _TABLE_MAP: {
      users: 'users',
      balances: 'balances',
      user_balances: 'balances',
      verifications: 'verifications',
      loans: 'loans',
      transactions: 'transactions',
      txns: 'transactions',
      trades: 'contracts',
      contracts: 'contracts',
      ai_orders: 'investments',
      investments: 'investments',
      chat_messages: 'chat_messages',
      chat: 'chat_messages',
      chats: 'chat_messages',
      coin_addresses: 'coin_addresses',
      admin_settings: 'app_settings',
      app_settings: 'app_settings',
      products: 'products',
      investment_products: 'investment_products'
    },

    // Init from config
    init: function (cfg) {
      if (!cfg) return false;
      this.url = cfg.url;
      this.anon = cfg.anon;
      this.service = cfg.service || '';
      this.READONLY = !!cfg.readonly;
      this.ENABLED = true;

      this._seedFromStash();

      var self_ = this;
      this._diag = [];
      this._diagLog('init: version=' + this.VERSION);
      this._diagLog('init: url=' + (this.url || '*** MISSING ***'));
      this._diagLog('init: anon key ' + (this.anon ? 'present (' + String(this.anon).slice(0, 12) + '...)' : '*** MISSING ***'));
      this._diagLog('init: SITE_CONFIG=' + (typeof SITE_CONFIG !== 'undefined' ? 'found' : '*** UNDEFINED ***'));
      this._diagLog('init: window.supabase ' + (window.supabase ? 'already present' : 'not loaded yet'));
      this._diagLog('init: starting (waiting for Supabase client)');

      this._initPromise = new Promise(function (resolve) {
        // Wrap resolve so the first outcome wins. The timeout below and the
        // init chain can both fire, and resolving twice is a no-op that would
        // otherwise hide whichever one lost the race.
        var settle = (function () {
          var done = false;
          return function (v) { if (!done) { done = true; resolve(v); } };
        })();

        // Hard ceiling on startup. Everything below is a network call with no
        // timeout of its own -- auth.getSession() and each table read. A
        // stalled request left this promise unsettled forever, so every
        // page that awaited ready() waited forever too, and the sign-in
        // button sat on "Loading..." with no way back. Whatever happens,
        // this promise settles.
        var guard = setTimeout(function () {
          self_._diagLog('init TIMED OUT after 20s (connected=' + self_.connected + '); giving up');
          settle(false);
        }, 20000);

        // The session has to resolve before the first load: a query issued with
        // no JWT returns nothing, and under RLS "nothing" is a successful empty
        // result rather than an error, so a premature load would look like an
        // empty database and leave the page blank.
        self_._awaitClientAndSession().then(function () {
          self_._diagLog('supabase client ready, session resolved; loading tables');
          // Must be awaited. Resolving this promise before the first load
          // finished reported "ready" while connected was still false, so a
          // caller gating on ready() then had to wait on the separate 'ready'
          // event -- against a timeout that had already started counting.
          return self_._bootstrap();
        }).then(function (ok) {
          // Pass the bootstrap result through. This callback used to end with
          // _startRealtime() and return undefined, so the final handler
          // received undefined and settled ready() as FALSE even when every
          // table had loaded. Callers that gate on that boolean therefore
          // treated a healthy backend as unavailable.
          self_._diagLog('tables loaded, starting realtime');
          self_._startRealtime();
          return ok;
        }).catch(function (e) {
          self_._diagLog('INIT PROBLEM: ' + (e && e.message ? e.message : String(e)));
          console.warn('TrustDB init problem:', e && e.message);
          // A second throw in here used to leave _initPromise permanently
          // unsettled. Nothing could ever await ready(), connected stayed
          // false, so every page reported the database unconfigured and the
          // sign-in buttons hung. Never rethrow out of this handler.
          try { return self_._bootstrap(); } catch (e2) {
            self_._diagLog('second bootstrap also threw: ' + (e2 && e2.message));
            return null;
          }
        }).then(function (ok) {
          clearTimeout(guard);
          self_._diagLog('init settled (connected=' + self_.connected + ')');
          settle(!!ok);
        }, function (e2) {
          clearTimeout(guard);
          self_._diagLog('init rejected: ' + (e2 && e2.message));
          settle(false);
        });
      });

      return true;
    },

    ready: function () {
      return this._initPromise || Promise.resolve(false);
    },

    // Signing in needs the Supabase client, not the table cache. Gating login
    // on the full bootstrap meant any slow, blocked or failed table load also
    // froze the sign-in button, even though sign-in would have worked fine.
    // This waits only for window.supabase, and always settles.
    authReady: function (ms) {
      var self_ = this;
      ms = ms || 20000;
      return new Promise(function (resolve) {
        var t0 = Date.now();
        (function poll() {
          if (window.supabase && window.supabase.auth) {
            self_._diagLog('authReady: Supabase client available');
            return resolve(true);
          }
          if (Date.now() - t0 > ms) {
            self_._diagLog('authReady: TIMED OUT after ' + ms + 'ms -- window.supabase is ' +
              (window.supabase ? 'present but has no .auth' : 'undefined (script blocked?)'));
            return resolve(false);
          }
          setTimeout(poll, 100);
        })();
      });
    },

    isReady: function () { return this.connected; },
    onReady: function (fn) { if (this.connected) fn(); else this.on('ready', fn); },

    // =====================================================================
    // Supabase plumbing
    // =====================================================================

    _waitForClient: function (tries) {
      tries = tries || 100;
      var self_ = this;
      if (window.supabase && window.supabase.auth) return Promise.resolve(window.supabase);
      if (tries <= 0) return Promise.reject(new Error('Supabase client never loaded'));
      return new Promise(function (r) { setTimeout(function () { r(self_._waitForClient(tries - 1)); }, 100); });
    },

    // Wait for the client AND the initial session, then keep the cache in step
    // with sign-in and sign-out for the life of the page.
    _awaitClientAndSession: function () {
      var self_ = this;
      return this._waitForClient().then(function (lib) {
        return lib.auth.getSession().then(function (res) {
          self_._adoptSession(res && res.data ? res.data.session : null);
          lib.auth.onAuthStateChange(function (_event, session) {
            var previousUid = self_._uid();
            self_._adoptSession(session);
            if (previousUid === self_._uid()) return;
            // The visible dataset changes wholesale on sign-in and sign-out, so
            // reload rather than merge, and tell every page to re-render.
            setTimeout(function () {
              self_._stopRealtime();
              self_._bootstrap().then(function () { self_._startRealtime(); });
            }, 0);
          });
        });
      });
    },

    _adoptSession: function (session) {
      var self_ = this;
      this._session = session || null;
      this._authUser = session && session.user ? session.user : null;

      // is_admin lives in the profile table, not the JWT, and the token is not
      // re-issued when it changes. Read it from the row we already cache, and
      // fall back to false so an admin-only control is never briefly shown.
      //
      // This closed over `self`, which in a browser is window, not this object.
      // self._authUser was therefore always undefined, no row ever matched, and
      // isAdmin was stuck at false -- so the admin pages could never tell an
      // admin apart from a normal user.
      var row = this._authUser ? this._cache.users.find(function (u) { return u.id === self_._authUser.id; }) : null;
      this.isAdmin = !!(row && row.is_admin);
    },

    _uid: function () {
      return this._authUser ? this._authUser.id : null;
    },

    // Require a signed-in caller, with a message aimed at whoever hit the button.
    _needUid: function () {
      var uid = this._uid();
      if (!uid) {
        var e = new Error('You need to sign in first');
        e.code = 'not_signed_in';
        throw e;
      }
      return uid;
    },

    // Core REST call, with the signed-in JWT attached. The v1 version hard-coded
    // the anon key in a header; that is what made every row world-readable.
    q: function (path, opts) {
      opts = opts || {};
      if (!this.ENABLED) return Promise.resolve(null);
      var self_ = this;
      var token = this._session && this._session.access_token;

      // PostgREST authenticates the anon role from the `apikey` header, and
      // rejects the request outright when it is missing -- even when a valid
      // user bearer token is also present:
      //   401 {"hint":"No 'apikey' request header or url param was found.",
      //        "message":"No API key found in request"}
      //
      // supabase-js sets this on every call it makes, but q() is a hand-rolled
      // fetch and bypasses the client, so it has to send the header itself.
      // This stayed hidden while ENABLED was false: q() returned early, so no
      // request was ever made and the missing header could not surface.
      if (!this.anon) {
        return Promise.reject(new Error(
          'No API key configured. Set DB_ANON_KEY in scripts/config.js ' +
          '(Supabase -> Project Settings -> API -> anon public).'
        ));
      }

      var headers = {
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        'apikey': this.anon
      };
      if (token) headers.Authorization = 'Bearer ' + token;

      var init = { method: opts.method || 'GET', headers: headers };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

      return fetch(this.url + '/rest/v1/' + path, init).then(function (res) {
        if (res.status === 204) return null;
        if (!res.ok) {
          return res.text().then(function (t) {
            throw new Error('HTTP ' + res.status + ' ' + path.split('?')[0] + ': ' + t.slice(0, 300));
          });
        }
        if (opts.text) return res.text();
        if (opts.noContent) return null;
        return res.json();
      }).then(function (data) {
        var method = (opts.method || 'GET').toUpperCase();
        if (method !== 'GET' && opts.refreshCache !== false) {
          return self_._refreshTable(path.split('?')[0]).then(function () { return data; });
        }
        return data;
      });
    },

    // Call a database function. Errors from a plpgsql `raise exception` arrive
    // as { message, code, details }; keep the message, drop the noise.
    rpc: function (name, args) {
      var self_ = this;
      return this.q('rpc/' + name, { method: 'POST', body: args || {} })
        .catch(function (e) {
          if (e && /HTTP 400/.test(e.message)) {
            var m = e.message.match(/: (.*)$/);
            throw new Error(m ? m[1] : e.message);
          }
          throw e;
        });
    },

    // =====================================================================
    // Auth
    // =====================================================================

    // Decide whether an account string is an email address or a phone number,
    // and normalise it for Supabase.
    //
    // Phone numbers are stored and compared in E.164 form (+14155550100).
    // Users type spaces, dashes, dots and brackets, and two people entering the
    // same number differently must resolve to one auth identity, so all of that
    // is stripped. A bare local number is rejected rather than guessed at,
    // because inventing a country code would silently create an account under
    // the wrong number.
    _authIdent: function (account, hint) {
      var raw = String(account == null ? '' : account).trim();
      if (!raw) return { kind: 'empty', value: '' };

      // An explicit choice from the Phone/Email toggle wins over inference.
      if (hint === 'phone') return _asPhone(raw);
      if (hint === 'email') return _asEmail(raw);

      // No hint: fall back to sniffing, which is fine for the login form where
      // there is no toggle.
      if (raw.indexOf('@') !== -1) return _asEmail(raw);
      return _asPhone(raw);

      function _asEmail(v) {
        var e = v.toLowerCase();
        return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)
          ? { kind: 'email', value: e }
          : { kind: 'invalid', value: e, msg: 'Enter a valid email address' };
      }
      function _asPhone(v) {
        var plus = v.charAt(0) === '+';
        var digits = v.replace(/\D/g, '');
        if (!digits) return { kind: 'invalid', value: v, msg: 'Enter a valid phone number' };
        if (!plus) {
          return {
            kind: 'invalid', value: v,
            msg: 'Phone numbers must include the country code, for example +14155550100'
          };
        }
        if (digits.length < 8 || digits.length > 15) {
          return { kind: 'invalid', value: v, msg: 'Enter a valid phone number with country code' };
        }
        return { kind: 'phone', value: '+' + digits };
      }
    },

    // v1 signature: register(account, password) -> { ok, user }
    //
    // Supabase Auth addresses an account by either email or phone, so
    // `account` may be either. The phone path additionally needs the Phone
    // provider enabled in the dashboard; without it GoTrue answers "Phone
    // logins are not enabled", which is passed straight through.
    // GoTrue reports quota problems with a 429 and a terse body. Passing
    // "email rate limit exceeded" through verbatim tells the visitor nothing
    // about what to do, and the usual root cause is a project setting rather
    // than anything the visitor did wrong, so name the actual fix.
    _authError: function (e, action) {
      var msg = (e && e.message) || String(e);
      var status = e && (e.status || e.status_code);
      var low = String(msg).toLowerCase();

      if (status === 429 || /rate limit|too many requests|over_email_send_rate_limit|over_sms_send_rate_limit/.test(low)) {
        if (action === 'signup') {
          return new Error(
            'Too many confirmation emails have been sent from this site. ' +
            'Wait about an hour and try again. To remove this limit entirely, ' +
            'the site owner can turn off "Confirm email" in Supabase under ' +
            'Authentication -> Sign In / Providers -> Email: new accounts are ' +
            'then signed in immediately and no email is sent at all.'
          );
        }
        return new Error('Too many attempts. Wait a few minutes, then try again.');
      }

      // Any trigger failure collapses into this one string, so pass on the
      // reference and where to read the cause instead of leaving a dead end.
      if (/database error saving new user/i.test(msg)) {
        return new Error(
          'The database rejected the new account: the on_auth_user_created ' +
          'trigger raised an error. Open Dashboard -> Logs -> Postgres Logs ' +
          'and read the entry at this time. (ref ' + ((e && (e.error_id || e.id)) || 'n/a') + ')'
        );
      }

      // The Phone provider ships disabled, so the Phone tab on the register
      // form fails with GoTrue's terse refusal. Say which setting is missing
      // instead of leaving a raw provider string on the form.
      //
      // GoTrue reports this as HTTP 422 with `error_code: phone_provider_disabled`
      // and, depending on the endpoint, the message "Phone signups are disabled"
      // (POST /signup) or "Phone logins are disabled" (POST /token).
      //
      // The structured code is matched first because it is stable; the messages
      // are matched as well because a gateway that drops the code still reports
      // the text. The previous pattern here asked for "signups are not allowed"
      // and "phone logins are not enabled", and GoTrue says neither - it says
      // "are disabled" - so every phone attempt put the bare
      // "Phone signups are disabled" on the form, which is the string reported
      // in the screenshot, and the explanation this function exists to give never
      // ran. A bare `not enabled` is still caught afterwards as a last resort.
      var code = String((e && (e.error_code || e.code)) || '');
      if (/phone_provider_disabled/.test(code) ||
          /phone (sign-?ups?|log-?ins?) (are|is) disabled|phone (sign-?ups?|log-?ins?) (is|are) not enabled/i.test(low)) {
        return new Error(
          'That sign-in method is not enabled on this site. Phone numbers need the ' +
          'Phone provider switched on in Supabase (Authentication -> Sign In / Providers -> ' +
          'Phone) and connected to an SMS service. Email sign-up works without any ' +
          'of that.'
        );
      }

      // An "Invalid API key" from the gateway means the anon key in
      // scripts/config.js does not belong to the project in DB_URL, or was
      // rotated. Nothing on the site can work until that is corrected, and the
      // gateway's hint does not survive to the form, so name it.
      if (/invalid api key|unauthorized_invalid_api_key/i.test(String(code) + ' ' + low)) {
        return new Error(
          'This site cannot reach its database: the Supabase API key in ' +
          'scripts/config.js is not valid for the project URL configured beside it. ' +
          'Copy the current anon key from Dashboard -> Project Settings -> API. ' +
          'No sign-in, sign-up or wallet request can succeed until it matches.'
        );
      }

      if (/not enabled/i.test(low)) {
        return new Error(
          'That sign-in method is not enabled on this site. Phone numbers need the ' +
          'Phone provider switched on in Supabase (Authentication -> Sign In / Providers -> ' +
          'Phone) and connected to an SMS service. Email sign-up works without any ' +
          'of that.'
        );
      }

      return new Error(msg);
    },

    register: function (account, password, extra, accountType) {
      var self_ = this;
      var id = this._authIdent(account, accountType);
      if (id.kind === 'invalid' || id.kind === 'empty') {
        return Promise.reject(new Error(id.msg || 'Enter a valid email or phone number'));
      }
      if (!password || String(password).length < 8) {
        return Promise.reject(new Error('Password must be at least 8 characters'));
      }

      // Only one of email/phone may be sent, and which one tells GoTrue which
      // identity to create.
      var creds = { password: password, options: { data: extra || {} } };
      if (id.kind === 'phone') { creds.phone = id.value; creds.options.data = extra || {}; creds.options.data.login_method = 'phone'; }
      else { creds.email = id.value; creds.options.data = extra || {}; creds.options.data.login_method = 'email'; }

      return this._waitForClient().then(function (lib) {
        return lib.auth.signUp(creds);
      }).then(function (res) {
        if (res.error) {
          throw self_._authError(res.error, 'signup');
        }

        // With "Confirm email" on, GoTrue returns a user but no session. Say so
        // rather than letting the caller treat it as a successful sign-in and
        // then fail on the first protected query. The phone provider behaves
        // the same way when SMS confirmation is on.
        //
        // Reaching either branch means the site is configured to require
        // confirmation, which is a project setting rather than anything the
        // visitor can act on. Both messages say so, and name the toggle,
        // instead of telling someone to go and check an inbox that will
        // either never arrive or arrive too slowly to be usable.
        if (!res.data.session) {
          if (id.kind === 'phone') {
            return {
              ok: true,
              needsPhoneConfirm: true,
              message: 'Your account was created, but this site still asks for a ' +
                'phone confirmation code. To sign up with no code at all, turn off ' +
                'phone confirmation in Supabase under Authentication -> Providers -> ' +
                'Phone. (The Phone provider also has to be enabled and connected to a ' +
                'SMS provider first.)'
            };
          }
          return {
            ok: true,
            needsEmailConfirm: true,
            message: 'Your account was created, but this site still asks you to ' +
              'confirm by email, so you are not signed in yet. To make sign-up ' +
              'instant with no email, turn off "Confirm email" in Supabase under ' +
              'Authentication -> Sign In / Providers -> Email, then sign in again.'
          };
        }

        self_._authUser = res.data.user;
        self_._session = res.data.session;
        self_._bootstrap();

        // The profile is created by the auth trigger, so fetch it rather than
        // assembling one here.
        return self_._loadTable('users', 'id').then(function () {
          var row = self_._cache.users.find(function (u) { return u.id === self_._authUser.id; });
          return { ok: true, user: self_._toV1User(row || self_._synthUser(self_._authUser)) };
        });
      });
    },

    // ---- Wallet sign-in ---------------------------------------------------
    // The signature is checked by the wallet-login Edge Function, not here. The
    // page cannot be trusted with that job: it would be verifying its own lie.
    // This only moves the challenge and the signature to and from that function,
    // and turns the one-time token it returns into a real session.
    walletAuthUrl: function () {
      var configured = '';
      try { configured = String((typeof SITE_CONFIG !== 'undefined' && SITE_CONFIG.WALLET_AUTH_URL) || '').trim(); } catch (e) {}
      if (configured) return configured.replace(/\/+$/, '');
      // Where `supabase functions deploy wallet-login` puts it.
      return String(this.url || '').replace(/\/+$/, '') + '/functions/v1/wallet-login';
    },

    // action: 'nonce'  -> { message, nonce, expires_at }
    // action: 'verify' -> { token_hash, email, address }
    walletAuth: function (action, payload) {
      var self_ = this;
      if (!this.ENABLED) return Promise.reject(new Error('Database not configured'));
      var body = Object.assign({ action: action }, payload || {});
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 20000);
      var headers = { 'Content-Type': 'application/json', apikey: this.anon };
      // Publishable keys are not JWTs. The function authenticates a signature,
      // and its gateway verification is disabled in supabase/config.toml.
      if (String(this.anon || '').split('.').length === 3) headers.Authorization = 'Bearer ' + this.anon;
      return fetch(this.walletAuthUrl(), {
        method: 'POST',
        headers: headers,
        signal: controller.signal,
        body: JSON.stringify(body)
      }).then(function (res) {
        return res.text().then(function (text) {
          var json = null;
          try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
          if (!res.ok || !json || json.ok !== true) {
            var msg = (json && (json.error || json.msg || json.message)) || ('Wallet sign-in failed (' + res.status + ')');
            if (res.status === 404) {
              msg = 'Wallet sign-in has not been enabled on this server. Please contact support.';
            }
            if (res.status === 401 || res.status === 403) {
              var detail = (json && (json.error || json.msg || json.message)) || '';
              msg = detail || 'Wallet sign-in is unavailable. Please contact support.';
            }
            var e = new Error(msg);
            e.status = res.status;
            throw e;
          }
          return json;
        });
      }).catch(function (e) {
        if (e && e.name === 'AbortError') throw new Error('The sign-in server took too long to respond. Try again.');
        if (e && e.status) throw e;
        // A missing Edge Function returns a failing OPTIONS response. Browsers
        // hide that response and reject POST as "Failed to fetch", even when
        // the network is fine. A simple GET needs no preflight and can reveal
        // the gateway's real status. It sends no signature, address or API key.
        return self_.walletAuthReachability().then(function (diagnosis) {
          if (diagnosis.status === 404) {
            var missing = new Error('Wallet sign-in has not been enabled on this server. Please use email login or contact support.');
            missing.status = 404;
            throw missing;
          }
          if (diagnosis.status === 401 || diagnosis.status === 403) {
            var blocked = new Error('Wallet sign-in server access is not configured. Please use email login or contact support.');
            blocked.status = diagnosis.status;
            throw blocked;
          }
          if (diagnosis.reachable) {
            throw new Error('The server is reachable, but wallet sign-in is blocked. Please contact support.');
          }
          throw e;
        });
      }).finally(function () { clearTimeout(timer); });
    },

    // Diagnostics only: a 405 from an older deployed function also proves that
    // it exists. No no-cors requests, proxy services, or automatic POST retries.
    walletAuthReachability: function () {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 6000);
      return fetch(this.walletAuthUrl(), {
        method: 'GET', credentials: 'omit', cache: 'no-store', signal: controller.signal
      }).then(function (res) {
        return { reachable: true, status: res.status };
      }).catch(function () { return { reachable: false, status: 0 }; })
        .finally(function () { clearTimeout(timer); });
    },

    // The Edge Function hands back a one-time token rather than a password, so
    // no long-lived credential is ever in the browser's hands. verifyOtp turns
    // it into a session, and from there this is the same session any other
    // sign-in produces.
    adoptWalletSession: function (email, tokenHash, expectedAddress) {
      var self_ = this;
      if (!email || !tokenHash) return Promise.reject(new Error('Wallet sign-in did not return a session'));
      return this._waitForClient().then(function (lib) {
        return lib.auth.verifyOtp({ token_hash: String(tokenHash), type: 'email' }).then(function (res) {
          if (res.error) throw new Error(res.error.message || 'Wallet sign-in could not be completed');
          var user = res.data && res.data.user;
          var session = res.data && res.data.session;
          if (!user || !session || !session.access_token || !session.user || session.user.id !== user.id ||
              String(user.email || '').toLowerCase() !== String(email).toLowerCase()) {
            throw new Error('Wallet sign-in did not create an authenticated session. Try again.');
          }
          self_._adoptSession(session);
          // Read the saved profile explicitly. A synthetic user can make login
          // look successful even though no row exists for the administrator.
          return self_.q('users?id=eq.' + encodeURIComponent(user.id) + '&select=*', {}).then(function (rows) {
            var row = rows && rows[0];
            if (!row || row.id !== user.id || row.login_method !== 'wallet' || row.is_guest ||
                (expectedAddress && String(row.account).toLowerCase() !== String(expectedAddress).toLowerCase())) {
              throw new Error('Your wallet profile could not be loaded. Try again or contact support.');
            }
            self_._cache.users = self_._cache.users.filter(function (u) { return u.id !== row.id; }).concat([row]);
            self_._dispatchTrustSync('users');
            self_._bootstrap().catch(function () {});
            return { ok: true, user: self_._toV1User(row) };
          }).catch(function (error) {
            return lib.auth.signOut({ scope: 'local' }).catch(function () {}).then(function () {
              self_._adoptSession(null);
              throw error;
            });
          });
        });
      });
    },

    // v1 signature: login(account, password) -> { ok, user }
    login: function (account, password) {
      var self_ = this;
      var id = this._authIdent(account);
      if (id.kind === 'invalid' || id.kind === 'empty') {
        return Promise.reject(new Error(id.msg || 'Enter a valid email or phone number'));
      }

      // Same either way, but the key differs: GoTrue looks the identity up by
      // whichever field is present.
      var creds = { password: password };
      if (id.kind === 'phone') creds.phone = id.value;
      else creds.email = id.value;

      return this._waitForClient().then(function (lib) {
        return lib.auth.signInWithPassword(creds);
      }).then(function (res) {
        if (res.error) {
          // A quota rejection is not a wrong password. Falling through to the
          // generic message below told someone with the right password that
          // their password was wrong, purely because they had tried a few
          // times. Check the status first, then apply the anti-enumeration rule.
          if (res.error.status === 429 || /rate limit|too many requests/i.test(res.error.message || '')) {
            throw self_._authError(res.error, 'login');
          }
          // Do not distinguish "no such account" from "wrong password": saying
          // which one it was turns the sign-in form into an account enumerator.
          throw new Error(id.kind === 'phone'
            ? 'Incorrect phone number or password'
            : 'Incorrect email or password');
        }
        self_._authUser = res.data.user;
        self_._session = res.data.session;
        self_._bootstrap();
        return self_._loadTable('users', 'id').then(function () {
          var row = self_._cache.users.find(function (u) { return u.id === self_._authUser.id; });
          return { ok: true, user: self_._toV1User(row || self_._synthUser(self_._authUser)) };
        });
      });
    },

    // v1 signature: changePassword(currentPassword, newPassword) -> { ok }
    //
    // GoTrue reissues the session on updateUser, so the caller's JWT stays
    // valid and no re-login is needed. The current password is proven with
    // reauthenticate instead of by reading a hash: in v2 the hash is bcrypt,
    // server-side, and never reaches the browser.
    changePassword: function (currentPassword, newPassword) {
      var self_ = this;
      if (!currentPassword || !newPassword) return Promise.resolve({ ok: false, msg: 'Please fill in all fields' });
      if (String(newPassword).length < 6) return Promise.resolve({ ok: false, msg: 'New password must be at least 6 characters' });
      return this._waitForClient().then(function (lib) {
        var u = self_._authUser;
        if (!u) throw new Error('Please login first');
        // A phone account has no email, so reauthenticate against whichever
        // identifier the identity actually owns. Passing email: null made
        // GoTrue answer "invalid login credentials" for every phone user.
        var who = u.email
          ? { email: u.email, password: currentPassword }
          : { phone: u.phone, password: currentPassword };
        return lib.auth.reauthenticate(who);
      }).then(function (res) {
        if (res && res.error) throw new Error('Current password is incorrect');
        return self_._waitForClient();
      }).then(function (lib) {
        return lib.auth.updateUser({ password: newPassword });
      }).then(function (res) {
        if (res && res.error) throw new Error(res.error.message || 'Failed to update password');
        return { ok: true };
      }).catch(function (e) { return { ok: false, msg: e.message }; });
    },

    logout: function () {
      var self_ = this;
      return this._waitForClient().then(function (lib) {
        return lib.auth.signOut();
      }).then(function () {
        self_._authUser = null;
        self_._session = null;
        self_.isAdmin = false;
        self_._cache.users = [];
        self_._cache.userBalances = {};
        self_._cache.verifications = {};
        self_._cache.loans = [];
        self_._cache.transactions = [];
        self_._cache.trades = [];
        self_._cache.aiOrders = [];
        self_._cache.chatMessages = {};
        self_._threadCache = {};
        self_._bootstrap();
        return true;
      });
    },

    // A profile row for a moment before the cache has caught up.
    _synthUser: function (u) {
      return {
        id: u.id,
        uid: u.id,                       // v1 callers that still read .uid
        account: String(u.email || u.phone || u.id).toLowerCase(),
        email: u.email || null,
        phone: u.phone || null,
        is_admin: false,
        is_guest: false,
        status: 'active',
        created_at: u.created_at,
        language: null,
        greeted: false
      };
    },

    // v1 kept a token row so a guest could browse. A guest is no longer a
    // database row: there is nothing to store, and nothing to leak.
    isGuest: function () { return false; },

    // =====================================================================
    // Shape adapters — v1 field names in, v2 rows out
    // =====================================================================

    // v1 app.js reads user.uid as a number in ~200 places. Kept as the uuid
    // string so the comparison `String(uid) === String(row.uid)` still holds.
    _toV1User: function (u) {
      if (!u) return null;
      var out = Object.assign({}, u);
      out.uid = u.id;
    // v1 stored profit_mode / greeted as columns; v2 has greeted but not
    // profit_mode, so carry it in app_settings under the user's key.
    return out;
  },

    // products are cached with their durations and are readable while signed
    // out, so the market name for a contract is a lookup rather than another
    // embed in the contracts query.
    _productById: function (id) {
      var list = this._cache.products || [];
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) return list[i];
      }
      return null;
    },

    _toV1Trade: function (c) {
      if (!c) return null;
      var p = this._productById(c.product_id) || {};
      var amount = parseFloat(c.amount) || 0;
      var payout = c.payout == null ? null : parseFloat(c.payout);
      // v2 is stake-and-payout: the stake leaves the wallet when the contract
      // opens and the payout comes back at settlement. So the profit the user
      // made is payout - amount on a win, and the whole -amount on a loss.
      // Deriving it here means the history, the record list and the result
      // modal all quote the same number instead of each doing its own maths.
      var profit = 0;
      if (c.status === 'won') profit = (payout == null ? 0 : payout) - amount;
      else if (c.status === 'lost') profit = -amount;
      else if (c.status === 'void') profit = 0;
      var quote = p.quote_coin || 'USDT';
      return {
        id: c.id,
        uid: c.uid,
        product_id: c.product_id,
        pair: p.symbol ? (p.symbol + '/' + quote) : '',
        symbol: p.symbol || '',
        coin: c.coin,
        side: c.side,
        amount: amount,
        entry_price: parseFloat(c.entry_price) || 0,
        price: parseFloat(c.entry_price) || 0,
        payout_pct: parseFloat(c.payout_pct) || 0,
        payout: payout,
        // v1 'open' / 'won' / 'lost' mapped directly.
        status: c.status,
        opened_at: c.opened_at,
        closed_at: c.settled_at,
        settled_at: c.settled_at,
        expires_at: c.expires_at,
        duration_sec: c.duration_sec,
        sell_price: c.settle_price == null ? null : parseFloat(c.settle_price),
        sellPrice: c.settle_price == null ? null : parseFloat(c.settle_price),
        profit: profit
      };
    },


    _toV1Transaction: function (t) {
      if (!t) return null;
      var out = Object.assign({}, t);
      // v1 stored the uploaded image inline in `proof`.
      out.proof = t.proof_url;
      out.reference = t.reference_id;
      return out;
    },

    _toV1Loan: function (l) {
      if (!l) return null;
      return Object.assign({}, l, {
        principal: parseFloat(l.principal),
        interest: parseFloat(l.interest),
        rate: parseFloat(l.rate)
      });
    },

    _toV1AIOrder: function (i) {
      if (!i) return null;
      return Object.assign({}, i, {
        principal: parseFloat(i.principal),
        profit: parseFloat(i.profit),
        rate: parseFloat(i.rate),
        settledDays: i.settled_days,
        settled_days: i.settled_days,
        endAt: i.end_at,
        startAt: i.start_at
      });
    },

    _toV1Chat: function (m) {
      if (!m) return null;
      return Object.assign({}, m, { message: m.body });
    },

    // =====================================================================
    // Loading
    // =====================================================================

    _canonical: function (table) {
      return this._TABLE_MAP[table] || table;
    },

    _keyField: function (table) {
      table = this._canonical(table);
      return table === 'users' ? 'id' :
             table === 'balances' ? 'uid' :
             table === 'verifications' ? 'uid' :
             table === 'loans' ? 'id' :
             table === 'transactions' ? 'id' :
             table === 'contracts' ? 'id' :
             table === 'investments' ? 'id' :
             table === 'products' ? 'id' :
             table === 'investment_products' ? 'id' :
             table === 'chat_messages' ? 'id' :
             table === 'coin_addresses' ? 'coin' :
             'key';
    },

    // What to pull for a table. Some need an embed, a filter, or a different
    // sort, and `products` / `app_settings` are readable while signed out.
    _query: function (table) {
      switch (this._canonical(table)) {
        case 'balances':
          return { path: 'balances?select=*&order=coin.asc', anonOk: false };
        case 'contracts':
          return { path: 'contracts?select=*&order=opened_at.desc', anonOk: false };
        case 'investments':
          return { path: 'investments?select=*,investment_products(code,name)&order=created_at.desc', anonOk: false };
        case 'loans':
          return { path: 'loans?select=*&order=created_at.desc', anonOk: false };
        case 'transactions':
          return { path: 'transactions?select=*&order=created_at.desc', anonOk: false };
        case 'chat_messages':
          return { path: 'chat_messages?select=*&order=created_at.asc', anonOk: false };
        case 'users':
          return { path: 'users?select=*&order=created_at.desc', anonOk: false };
        case 'verifications':
          return { path: 'verifications?select=*', anonOk: false };
        case 'coin_addresses':
          return { path: 'coin_addresses?select=*&order=coin.asc', anonOk: true };
        case 'app_settings':
          return { path: 'app_settings?select=*', anonOk: true };
        case 'products':
          return { path: 'products?select=*,product_durations(*)&order=sort_order.asc', anonOk: true };
        case 'investment_products':
          return { path: 'investment_products?select=*', anonOk: true };
        default:
          return { path: this._canonical(table) + '?select=*', anonOk: false };
      }
    },

    _bootstrap: function () {
      var self_ = this;
      var signedIn = !!this._authUser;
      // Resolve the signed-in account's server role before considering a stored
      // shared-password token. An expired token must not override a real admin.
      if (this._rolePromise) return this._rolePromise.then(function () { return self_._bootstrap(); });
      var roleSession = signedIn && this._session && this._session.access_token;
      if (signedIn && this._roleCheckedSession !== roleSession) {
        this._roleCheckedSession = roleSession;
        this._rolePromise = this.q('users?id=eq.' + encodeURIComponent(this._authUser.id) + '&select=id,is_admin', {}).then(function (rows) {
          self_.isAdmin = !!(rows && rows[0] && rows[0].is_admin);
        }, function (error) {
          self_.isAdmin = false;
          console.warn('Could not resolve account role:', error.message);
        }).then(function () { self_._rolePromise = null; });
        return this._rolePromise.then(function () { return self_._bootstrap(); });
      }

      // Always public, always safe to try.
      var publicTables = ['coin_addresses', 'app_settings', 'products', 'investment_products'];
      var privateTables = this._pageTables();
      var tables = signedIn ? publicTables.concat(privateTables) : publicTables;

      var jobs = tables.map(function (t) {
        // A synchronous throw in _loadTable escapes .map, rejecting the whole
        // _bootstrap before a single promise exists. Wrapping it keeps one bad
        // table from taking down the connection for every other table.
        try {
          return Promise.resolve(self_._loadTable(t)).then(function () {
            self_._dispatchTrustSync(t);
          }).catch(function (e) {
            // A refused table is normal, not fatal: RLS rejecting a read returns
            // an empty set, and a genuine network error should not stop the rest
            // of the page from rendering.
            if (e && /HTTP 40[13]/.test(e.message)) return;
            console.warn('TrustDB load failed for ' + t + ':', e.message || e);
          });
        } catch (e) {
          console.warn('TrustDB load threw for ' + t + ':', e && (e.message || e));
          return Promise.resolve();
        }
      });

      return Promise.all(jobs).then(function () {
        self_._markConnected();
        return true;
      });
    },

    // True once the first load attempt has finished, either way. Callers that
    // gate on this must never be left waiting: a data layer that reports
    // itself unconfigured forever strands every page.
    _markConnected: function () {
      this.connected = true;
      this.lastSync = Date.now();
      try { this._adoptSession(this._session); } catch (e) {}
      this._notify('ready');
    },

    _loadTable: function (table, keyField) {
      table = this._canonical(table);
      var self_ = this;
      self_._liveTables = self_._liveTables || {};
      self_._loadSeq = self_._loadSeq || {};
      var mySeq = (self_._loadSeq[table] || 0) + 1;
      self_._loadSeq[table] = mySeq;
      var startTs = Date.now();

      var q = this._query(table);
      var token = '';
      try {
        if (/\/admin(?:-[a-z]+)?\.html$/.test(window.location.pathname)) token = sessionStorage.getItem('trustAdminToken') || '';
      } catch (e) {}
      var canonical = this._canonical(table);
      var privateTables = ['users', 'balances', 'verifications', 'loans', 'transactions', 'contracts', 'investments', 'chat_messages'];
      var read;
      if (token && !this.isAdmin && privateTables.indexOf(canonical) !== -1) {
        // Read-only, allowlisted RPC validates the existing signed admin token.
        var page = function (offset, collected) {
          return self_.rpc('admin_read_rows', {tok: token, table_name: canonical, row_offset: offset}).then(function (rows) {
            rows = rows || [];
            var all = collected.concat(rows);
            return rows.length === 500 ? page(offset + 500, all) : all;
          });
        };
        read = page(0, []);
      } else {
        var page = function (offset, collected) {
          return self_.q(q.path + '&limit=500&offset=' + offset, {}).then(function (rows) {
            rows = rows || [];
            var all = collected.concat(rows);
            return rows.length === 500 ? page(offset + 500, all) : all;
          });
        };
        read = page(0, []);
      }
      return read.then(function (rows) {
        if (self_._loadSeq[table] !== mySeq) return (rows || []).length;
        rows = rows || [];
        self_._snapshots = self_._snapshots || {};
        self_._changed = self_._changed || {};
        var snapshot = JSON.stringify(rows);
        self_._changed[table] = self_._snapshots[table] !== snapshot;
        self_._snapshots[table] = snapshot;
        self_._applyRows(table, rows, startTs);
        if (table === 'users') self_._adoptSession(self_._session);
        if (['coin_addresses','app_settings','products','investment_products'].indexOf(table) !== -1) self_._stashRows(table, rows);
        return rows.length;
      });
    },

    // v1 name, kept because app.js calls it 35 times.
    pullBlob: function (table) {
      table = this._canonical(table);
      var self_ = this;
      this._pulls = this._pulls || {};
      if (this._pulls[table]) return this._pulls[table];
      this._pulls[table] = this._loadTable(table).then(function () {
        if (!self_._changed || self_._changed[table] !== false) self_._dispatchTrustSync(table);
        return true;
      }).finally(function () { delete self_._pulls[table]; });
      return this._pulls[table];
    },

    fetchBlob: function (table) { return this.pullBlob(table); },
    enqueue: function (table) { return this.pullBlob(table); },

    _applyRows: function (table, rows, startTs) {
      var self_ = this;
      self_._liveTables = self_._liveTables || {};
      self_._liveTables[table] = true;
      var keyField = this._keyField(table);
      // Map the table onto its cache slot. This has to cover every table in
      // _query(), not just the v1 names: an unmapped name lands in the
      // Object.assign branch below with an undefined target and throws.
      var SLOTS = {
        balances: 'userBalances',
        user_balances: 'userBalances',
        coin_addresses: 'coinAddresses',
        app_settings: 'adminSettings',
        admin_settings: 'adminSettings',
        chat_messages: 'chatMessages',
        contracts: 'trades',
        trades: 'trades',
        investments: 'aiOrders',
        ai_orders: 'aiOrders',
        investment_products: 'investmentProducts'
      };
      var c = SLOTS[table] || table;
      var cache = this._cache[c];

      if (table === 'balances' || table === 'user_balances') {
        // v2 adds locked_amount, so key on coin as well as uid.
        var map = {};
        rows.forEach(function (r) {
          (map[r.uid] = map[r.uid] || {})[r.coin] = parseFloat(r.amount) || 0;
        });
        this._cache.userBalances = map;
      } else if (table === 'chat_messages') {
        var incoming = {};
        rows.forEach(function (r) { (incoming[r.uid] = incoming[r.uid] || []).push(r); });
        Object.keys(Object.assign({}, self_._cache.chatMessages, incoming)).forEach(function (u0) {
          // self_ , not self: in a browser `self` is window, so self._cache was
          // undefined and the first chat message threw a TypeError here, which
          // aborted the merge and left the chat list empty.
          var list = self_._cache.chatMessages[u0] = self_._cache.chatMessages[u0] || [];
          var byId = {};
          (incoming[u0] || []).forEach(function (r) { byId[r.id] = r; });
          for (var i0 = list.length - 1; i0 >= 0; i0--) {
            var m0 = list[i0];
            if (m0.id in byId) { list[i0] = byId[m0.id]; delete byId[m0.id]; }
            else if ((self_._rowAt['chat_messages:' + m0.id] || 0) <= startTs) list.splice(i0, 1);
          }
          for (var k0 in byId) {
            list.push(byId[k0]);
            self_._rowAt['chat_messages:' + byId[k0].id] = Date.now();
          }
        });
      } else if (table === 'app_settings' || table === 'admin_settings') {
        var smap = {};
        rows.forEach(function (r) { smap[r.key] = r.value; });
        this._cache.adminSettings = smap;
      } else if (Array.isArray(cache)) {
        // Merge, never replace, so a row that arrived over realtime while this
        // snapshot was in flight is not dropped by the older snapshot landing
        // after it.
        var incomingRows = {};
        rows.forEach(function (r) { incomingRows[r[keyField]] = r; });
        for (var i = cache.length - 1; i >= 0; i--) {
          var curKey = cache[i][keyField];
          if (curKey in incomingRows) {
            cache[i] = incomingRows[curKey];
            this._rowAt[table + ':' + curKey] = Date.now();
            delete incomingRows[curKey];
          } else if ((this._rowAt[table + ':' + curKey] || 0) <= startTs) {
            cache.splice(i, 1);
          }
        }
        for (var nk in incomingRows) {
          cache.push(incomingRows[nk]);
          this._rowAt[table + ':' + nk] = Date.now();
        }
      } else {
        var kmap = {};
        rows.forEach(function (r) { kmap[r[keyField] || r.uid] = r; });
        Object.assign(cache, kmap);
      }
    },

    _stashRows: function (table, rows) {
      try {
        if (typeof localStorage === 'undefined' || !localStorage.setItem) return;
        var json = JSON.stringify(rows);
        if (json.length > 400000) return;
        // Namespaced under v2: v1's localStorage mirror is keyed the same way
        // but holds rows with the old columns, and reading it back would
        // resurrect a shape the v2 adapters do not understand.
        localStorage.setItem('trustdb2_mirror_' + table, json);
      } catch (e) {}
    },

    _seedFromStash: function () {
      try {
        if (typeof localStorage === 'undefined' || !localStorage.getItem) return;
        var self_ = this;
        ['coin_addresses', 'app_settings', 'products', 'investment_products'].forEach(function (table) {
          try {
            var json = localStorage.getItem('trustdb2_mirror_' + table);
            if (!json) return;
            var rows = JSON.parse(json);
            if (rows && rows.length) self_._applyRows(table, rows, 0);
          } catch (e) {}
        });
      } catch (e) {}
    },

    _refreshTable: function (table) {
      var self_ = this;
      var known = ['users', 'balances', 'verifications', 'loans', 'transactions',
                   'contracts', 'investments', 'chat_messages', 'coin_addresses',
                   'app_settings', 'products', 'investment_products'];
      if (known.indexOf(this._canonical(table)) === -1) return Promise.resolve(true);
      return this._loadTable(table).then(function () {
        self_._dispatchTrustSync(table);
        return true;
      }).catch(function () { return false; });
    },

    _dispatchTrustSync: function (table) {
      if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
      var names = [table];
      var canonical = this._canonical(table);
      // v1 aliases, so existing listeners still fire.
      var aliases = {
        txns: 'transactions', transactions: 'transactions',
        balances: 'balances', user_balances: 'balances',
        chats: 'chat_messages', chat: 'chat_messages', chat_messages: 'chat_messages',
        aiorders: 'investments', ai_orders: 'investments', investments: 'investments',
        trades: 'contracts', contracts: 'contracts',
        admin_settings: 'app_settings', app_settings: 'app_settings'
      };
      for (var a in aliases) if (aliases[a] === canonical && names.indexOf(a) === -1) names.push(a);
      names.forEach(function (n) {
        try { window.dispatchEvent(new window.CustomEvent('trustsync:' + n, { detail: {} })); } catch (e) {}
      });
    },

    // =====================================================================
    // Realtime
    // =====================================================================

    _startRealtime: function () {
      var self_ = this;
      this._startLiveSync();
      // Only the tables a signed-in viewer can see. Subscribing to all of them
      // while signed out produces nothing but 401s on the channel.
      if (!this._uid()) return;
      this._pageTables().forEach(function (t) { self_._subscribeTable(t); });
    },

    _adminTokenForPage: function () {
      try { return /\/admin(?:-[a-z]+)?\.html$/.test(window.location.pathname) ? sessionStorage.getItem('trustAdminToken') || '' : ''; }
      catch (e) { return ''; }
    },

    _startLiveSync: function () {
      if (this._liveTimer) return;
      var self_ = this;
      this._liveTimer = setInterval(function () { self_._syncVisible(); }, 1000);
      window.addEventListener('online', function () { self_._syncVisible(); });
      document.addEventListener('visibilitychange', function () { if (!document.hidden) self_._syncVisible(); });
      this._syncVisible();
    },

    _pageTables: function () {
      var path = window.location.pathname;
      if (/chat|service/.test(path)) return ['users','chat_messages'];
      if (/admin-users/.test(path)) return ['users','balances','verifications','app_settings'];
      if (/funds/.test(path)) return ['users','transactions','balances','verifications','loans'];
      if (/admin-adjust/.test(path)) return ['users','balances','transactions'];
      if (/loan/.test(path)) return ['users','loans','balances'];
      if (/authentication|advanced-auth|admin-verify/.test(path)) return ['users','verifications'];
      if (/admin\.html$/.test(path)) return ['users','transactions','loans','verifications','chat_messages','balances'];
      // products carries the real payout odds and the minimum stake, which the
      // order form has to show before an order is placed; without it the page
      // falls back to hard-coded numbers and then fails at settlement.
      if (/trade|orders|admin-feed/.test(path)) return ['users','balances','contracts','products'];
      // investment_products carries the plan name and rate, so the order shows
      // which product it belongs to instead of a bare "AI Quant".
      if (/ai\.html|admin-quants/.test(path)) return ['users','balances','investments','investment_products'];
      return ['users','balances'];
    },

    _syncVisible: function () {
      if (document.hidden || this._liveBusy || (!this._uid() && !this._adminTokenForPage())) return;
      var tables = this._pageTables();
      var self_ = this;
      this._liveBusy = true;
      var token = this._adminTokenForPage();
      var job;
      if (token && !this.isAdmin) {
        job = this.rpc('admin_live_revisions',{tok:token}).then(function (versions) {
          self_._liveVersions = self_._liveVersions || {};
          return Promise.allSettled(tables.filter(function (t) { return self_._liveVersions[t] !== versions[t]; }).map(function (t) {
            return self_.pullBlob(t).then(function () { self_._liveVersions[t] = versions[t]; });
          }));
        });
      } else {
        this._lastPoll = this._lastPoll || {};
        job = Promise.allSettled(tables.filter(function (t) {
          var interval = self_._rtReady && self_._rtReady[t] ? 15000 : (t === 'chat_messages' ? 1500 : 5000);
          return Date.now() - (self_._lastPoll[t] || 0) > interval;
        }).map(function (t) { return self_.pullBlob(t).then(function () { self_._lastPoll[t] = Date.now(); }); }));
      }
      return job.catch(function () { /* The admin access refresh reports expired credentials. */ })
        .finally(function () { self_._liveBusy = false; });
    },


    _stopRealtime: function () {
      var self_ = this;
      var lib = window.supabase;
      Object.keys(this._channels).forEach(function (name) {
        try { if (lib) lib.removeChannel(self_._channels[name]); } catch (e) {}
      });
      this._channels = {};
      this._rtReady = {};
      this._liveVersions = {};
    },

    _subscribeTable: function (table) {
      var self_ = this;
      if (typeof window === 'undefined' || !window.supabase) return;
      if (this._channels[table]) return;
      try {
        var channel = window.supabase.channel('db2_' + table)
          .on('postgres_changes', { event: '*', schema: 'public', table: table }, function (payload) {
            self_._handleRealtime(table, payload);
          })
          .subscribe(function (status) {
            self_._rtReady = self_._rtReady || {};
            self_._rtReady[table] = status === 'SUBSCRIBED';
            if (status === 'SUBSCRIBED') self_.pullBlob(table).catch(function () {});
            if (status === 'CHANNEL_ERROR') console.warn('Realtime: ' + table + ' channel error');
          });
        this._channels[table] = channel;
      } catch (e) { console.warn('Realtime subscribe failed for ' + table, e); }
    },

    _handleRealtime: function (table, payload) {
      var eventType = payload.eventType;
      var rec = payload.new || {};
      var old = payload.old || {};

      switch (table) {
        case 'balances':
          if (eventType === 'DELETE') {
            if (this._cache.userBalances[old.uid]) delete this._cache.userBalances[old.uid][old.coin];
          } else {
            this._cache.userBalances[rec.uid] = this._cache.userBalances[rec.uid] || {};
            this._cache.userBalances[rec.uid][rec.coin] = parseFloat(rec.amount) || 0;
          }
          break;
        case 'verifications':
          if (eventType === 'DELETE') delete this._cache.verifications[old.uid];
          else this._cache.verifications[rec.uid] = rec;
          break;
        case 'users':
        case 'loans':
        case 'transactions':
        case 'contracts':
        case 'investments': {
          var list = this._cache[table === 'contracts' ? 'trades' : table === 'investments' ? 'aiOrders' : table];
          if (Array.isArray(list)) {
            if (eventType === 'DELETE') {
              this._cache[table === 'contracts' ? 'trades' : table === 'investments' ? 'aiOrders' : table] =
                list.filter(function (x) { return x.id !== old.id; });
            } else {
              var idx = list.findIndex(function (x) { return x.id === rec.id; });
              if (idx >= 0) list[idx] = rec;
              else list.push(rec);
            }
          }
          this._rowAt[table + ':' + rec.id] = Date.now();
          break;
        }
        case 'chat_messages': {
          var chatUid = rec.uid || old.uid;
          var cl = this._cache.chatMessages[chatUid] = this._cache.chatMessages[chatUid] || [];
          if (eventType === 'DELETE') {
            this._cache.chatMessages[chatUid] = cl.filter(function (m) { return m.id !== old.id; });
          } else {
            var mi = cl.findIndex(function (m) { return m.id === rec.id; });
            if (mi >= 0) {
              // Merge: an UPDATE payload can omit columns, and a blind swap
              // makes an attachment vanish until the next full pull.
              var merged = Object.assign({}, cl[mi], rec);
              cl[mi] = merged;
            } else {
              cl.push(rec);
            }
          }
          this._rowAt['chat_messages:' + rec.id] = Date.now();
          break;
        }
        case 'coin_addresses':
          if (eventType === 'DELETE') delete this._cache.coinAddresses[old.coin + ':' + old.network];
          else this._cache.coinAddresses[rec.coin + ':' + rec.network] = rec;
          break;
      }

      this._notify('change:' + table, { event: eventType, record: rec, old: old });
      this._notify('change', { table: table, event: eventType });
      this._dispatchTrustSync(table);
    },

    // =====================================================================
    // Events
    // =====================================================================

    _listeners: {},
    on: function (event, fn) { (this._listeners[event] = this._listeners[event] || []).push(fn); },
    off: function (event, fn) {
      var a = this._listeners[event];
      if (a) this._listeners[event] = a.filter(function (f) { return f !== fn; });
    },
    _notify: function (event, data) {
      var a = this._listeners[event];
      if (a) a.forEach(function (f) { try { f(data); } catch (e) {} });
    },

    // =====================================================================
    // Public API — v1 names and shapes
    // =====================================================================

    // ---- users ----

    getUsers: function () {
      return this._cache.users.slice()
        .map(this._toV1User)
        .sort(function (a, b) { return new Date(b.created_at || 0) - new Date(a.created_at || 0); });
    },
    getUser: function (uid) {
      var r = this._cache.users.find(function (u) { return String(u.id) === String(uid); });
      return this._toV1User(r);
    },
    getUserStr: function (uid) {
      var r = this._cache.users.find(function (u) { return String(u.id) === String(uid); });
      return this._toV1User(r);
    },
    usersList: function () { return this._cache.users.slice().map(this._toV1User); },
    getUserByReferralCode: function (code) {
      var r = this._cache.users.find(function (u) { return u.referral_code === code; });
      return this._toV1User(r);
    },
    me: function () { return this._toV1User(this.getUserStr(this._uid())); },

    // v1 let anyone create a user row directly. v2 has no INSERT policy on
    // users, so accounts exist only through Supabase Auth. Calls register().
    createUser: function () {
      return Promise.reject(new Error(
        'Users are created through Supabase Auth now - call TrustDB.register() instead'
      ));
    },

    // v1 generated a 6-digit uid client-side. The uuid comes from GoTrue.
    _genUid: function () {
      return this._uid() || '';
    },

    // v1 hashed with base64. GoTrue hashes with bcrypt server-side and the
    // hash never reaches this code, so there is nothing to compute here.
    _hashPassword: function () {
      throw new Error(
        'Passwords are handled by Supabase Auth and are never hashed in the browser'
      );
    },
    _verifyPassword: function () {
      throw new Error(
        'Password verification happens in Supabase Auth. To change a password use ' +
        'supabase.auth.updateUser({ password }) after re-authenticating.'
      );
    },

    updateUser: function (uid, patch) {
      var self_ = this;
      var target = String(uid || this._uid());
      if (target !== String(this._uid()) && !this.isAdmin) {
        return Promise.reject(new Error('You can only edit your own profile'));
      }
      // Columns the client may never set directly: is_admin and status are
      // privilege and moderation state, guarded by a trigger in 02_rls.sql.
      var safe = {};
      ['display_name', 'phone', 'language', 'greeted'].forEach(function (k) {
        if (patch && patch[k] !== undefined) safe[k] = patch[k];
      });
      if (patch && patch.language !== undefined) safe.language = patch.language;
      if (patch && patch.greeted !== undefined) safe.greeted = !!patch.greeted;

      return this.q('users?id=eq.' + encodeURIComponent(target), { method: 'PATCH', body: safe })
        .then(function (rows) { return self_._toV1User(rows && rows[0]); });
    },

    setUserLanguage: function (uid, lang) { return this.updateUser(uid, { language: lang }); },
    setUserGreeted: function (uid) { return this.updateUser(uid, { greeted: true }); },
    getUserLanguage: function (uid) {
      var u = this.getUserStr(uid || this._uid());
      return (u && u.language) || 'en';
    },
    getUserGreeted: function (uid) {
      var u = this.getUserStr(uid || this._uid());
      return !!(u && u.greeted);
    },

    // v1 stored profit_mode on the user row; v2 has no such column, so it lives
    // in app_settings under a per-user key. Same call signature as v1.
    //
    // app_settings is insert-only for client roles, so the switch cannot be
    // written from the browser: admin_set_profit_mode (migration 17) is the
    // only writer, and it takes the admin credential. 'profit_mode:all' is the
    // switch for every user; a per-user key overrides it.
    _profitKey: function (uid) { return 'profit_mode:' + (uid || this._uid()); },
    _profitAllKey: 'profit_mode:all',

    _profitFlag: function (key) {
      var v = this.getSetting(key);
      if (v === null || v === undefined) return false;
      if (v === true || v === 'true' || v === 1 || v === '1') return true;
      if (typeof v === 'string') return v.toLowerCase() === 'true';
      if (typeof v === 'object') return v.value === true || v.on === true;
      return false;
    },

    getUserProfitMode: function (uid) {
      if (uid && String(uid) !== String(this._uid())) {
        // Only an admin page may read another account's switch; the cache is
        // filled from app_settings, which RLS exposes as public read.
        return this._profitFlag(this._profitKey(uid));
      }
      return this._profitFlag(this._profitAllKey) || this._profitFlag(this._profitKey(null));
    },

    // The account's own key only, with no fallback to the global switch.
    getOwnProfitMode: function (uid) {
      return this._profitFlag(this._profitKey(uid || this._uid()));
    },

    isGlobalProfitMode: function () { return this._profitFlag(this._profitAllKey); },

    setUserProfitMode: function (uid, on) {
      var self_ = this;
      var key = uid ? this._profitKey(uid) : this._profitAllKey;
      var token = this._adminTokenForPage();
      if (!token && !this.isAdmin) {
        return Promise.reject(new Error('Administrator access is required to change Profit Mode'));
      }
      return this.rpc('admin_set_profit_mode', {
        tok: token || null, p_uid: uid ? String(uid) : null, p_on: !!on
      }).then(function (res) {
        if (on) self_._cache.adminSettings[key] = true;
        else delete self_._cache.adminSettings[key];
        return res;
      });
    },

    // v1 guests upgraded in place, keeping their uid and balances. v2 has no
    // guest accounts, so there is nothing to convert.
    convertGuest: function () {
      return Promise.reject(new Error('Guest accounts no longer exist in v2'));
    },

    // v1 had a soft delete that cascaded manually. v2 deactivates instead:
    // deleting the profile would cascade away ledger entries, and the money
    // history has to outlive the account.
    deleteUser: function (uid) {
      var target = String(uid);
      if (!this.isAdmin) return Promise.reject(new Error('Admin only'));
      return this.rpc('admin_set_user_status', {
        p_uid: target, p_status: 'banned', p_note: 'account removed'
      });
    },

    // ---- balances ----

    _balanceMap: function (uid) {
      var b = this._cache.userBalances;
      if (!b) return null;
      return b[uid] || b[String(uid)] || null;
    },
    getBalance: function (uid, coin) {
      var b = this._balanceMap(uid || this._uid());
      return b ? (parseFloat(b[coin]) || 0) : 0;
    },
    getAllBalances: function (uid) { return this._balanceMap(uid || this._uid()) || {}; },

    // v1 did read-modify-write in JavaScript: read the row, add the delta,
    // post the total. Two concurrent calls each read the pre-write value and
    // the second erases the first's delta. v2's post_ledger takes a row lock
    // and writes a ledger entry, so the arithmetic happens once, in the
    // database, and the whole thing is atomic.
    //
    // This is an ADMIN operation: the delta is applied server-side and cannot be
    // restricted to "your own balance", because the ledger function itself is
    // not reachable by a client at all. A note is mandatory.
    addBalance: function (uid, coin, delta, note) {
      var self_ = this;
      var target = String(uid || this._uid());
      var d = parseFloat(delta) || 0;
      if (!d) return Promise.reject(new Error('Adjustment cannot be zero'));
      if (!note || !String(note).trim()) {
        return Promise.reject(new Error('A written reason is required for every adjustment'));
      }
      return this.rpc('admin_adjust_balance', {
        p_uid: target, p_coin: coin, p_delta: d, p_note: String(note).trim()
      }).then(function (balance) {
        return self_._refreshTable('balances').then(function () { return parseFloat(balance); });
      });
    },

    setBalance: function (uid, coin, amount, note) {
      var cur = this.getBalance(uid, coin);
      return this.addBalance(uid, coin, (parseFloat(amount) || 0) - cur, note || 'set balance');
    },

    // ---- transactions (deposits / withdrawals) ----

    getTransactions: function () { return this._cache.transactions.map(this._toV1Transaction); },
    getTransactionsForUser: function (uid) {
      return this._cache.transactions
        .filter(function (t) { return String(t.uid) === String(uid); })
        .map(this._toV1Transaction);
    },

    addTransaction: function (data) {
      var self_ = this;
      var uid = this._needUid();
      var payload = {
        uid: uid,
        type: data.type === 'withdraw' ? 'withdrawal' : data.type,
        coin: data.coin,
        amount: data.amount,
        // v1 accepted whatever status the client sent. The insert policy only
        // accepts 'pending', which is the point: a client cannot file its own
        // deposit as already approved.
        status: 'pending',
        reference_id: data.reference || data.referenceId || null,
        proof_url: data.proof || data.proofUrl || null,
        proof_name: data.proof_name || data.proofName || null,
        note: data.note || data.description || null,
        request_details: data.request_details || {}
      };
      return this.q('transactions', { method: 'POST', body: payload })
        .then(function (rows) { return self_._toV1Transaction(rows[0]); });
    },

    setTransactionStatus: function (id, status, note) {
      // Approval credits the balance inside the same transaction as the status
      // change, so the client must not write the status itself.
      return this.rpc('admin_set_transaction_status', {
        p_txn_id: Number(id), p_status: status, p_note: note || null
      }).then(function () { return true; });
    },

    // ---- trades / contracts ----

    // _toV1Trade needs `this` for the product lookup, so it is called as a
    // method rather than handed to map() unbound.
    _trade: function (c) { return this._toV1Trade(c); },

    getTrades: function () {
      var self_ = this;
      return this._cache.trades.map(function (c) { return self_._toV1Trade(c); })
        .sort(function (a, b) { return new Date(b.opened_at || 0) - new Date(a.opened_at || 0); });
    },
    getTradesForUser: function (uid) {
      var self_ = this;
      return this._cache.trades
        .filter(function (t) { return String(t.uid) === String(uid); })
        .map(function (c) { return self_._toV1Trade(c); });
    },

    addTrade: function (data) {
      var self_ = this;
      this._needUid();
      // payout_pct is read from product_durations by the function, never taken
      // from the request, so a crafted call cannot promise itself a 10x payout.
      return this.rpc('open_contract', {
        p_product_id: Number(data.product_id != null ? data.product_id : data.productId),
        p_coin: data.coin || 'USDT',
        p_side: data.side,
        p_amount: data.amount,
        p_duration_sec: Number(data.duration_sec != null ? data.duration_sec : data.durationSec),
        p_entry_price: data.entry_price != null ? data.entry_price : data.entryPrice
      }).then(function (id) {
        return self_._refreshTable('contracts').then(function () {
          return self_._toV1Trade(self_._cache.trades.find(function (c) { return c.id === id; }));
        });
      });
    },

    // v1's updateTrade settled the trade and credited the balance from the
    // browser. That is exactly the operation a client must not be able to
    // perform, so the money moved server-side. The browser still owns the
    // countdown, so it calls settle_trade, which locks the contract, refuses
    // to settle a contract it does not own, decides the outcome against the
    // quoted odds, and posts the payout through post_ledger.
    updateTrade: function (id) {
      return Promise.reject(new Error(
        'Trades are settled with settleTrade(id, exitPrice). The browser must not ' +
        'post a status or a balance itself.'
      ));
    },

    // Whether a table has actually been read yet. The difference matters for
    // the public reference tables: an empty `products` array means "not loaded
    // yet" on first paint, and a page must not conclude from that no markets
    // exist and block a legitimate order.
    hasTable: function (table) {
      return !!(this._liveTables && this._liveTables[this._canonical(table)]);
    },

    // Odds and the minimum stake, read from products/product_durations, so the
    // modal can show what the order will actually pay before it is placed.
    // The database stays the authority: open_trade re-reads the same rows.
    getProductTerms: function (symbol, seconds) {
      var list = this._cache.products || [];
      // Strip the quote first: the pages link with "ETH/USDT" and a products row
      // is keyed on the base currency alone, so comparing the raw pair found
      // nothing and the order was refused as an unknown market.
      var want = String(symbol == null ? '' : symbol).toUpperCase().split('/')[0].replace(/[^A-Z0-9]/g, '');
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (String(p.symbol || '').toUpperCase() !== want) continue;
        var ds = p.product_durations || [];
        for (var j = 0; j < ds.length; j++) {
          if (Number(ds[j].seconds) !== Number(seconds)) continue;
          if (ds[j].is_active === false) continue;
          return {
            product_id: p.id,
            symbol: p.symbol,
            name: p.name,
            coin: p.quote_coin || 'USDT',
            min_amount: parseFloat(p.min_amount) || 0,
            payout_pct: parseFloat(ds[j].payout_pct) || 0,
            seconds: Number(ds[j].seconds)
          };
        }
        return { product_id: p.id, symbol: p.symbol, name: p.name,
                 coin: p.quote_coin || 'USDT',
                 min_amount: parseFloat(p.min_amount) || 0, payout_pct: null, seconds: null };
      }
      return null;
    },

    // Opens the contract and debits the stake in one server transaction. The
    // market is named by symbol, not by product_id, so the front end cannot
    // pick a row that does not exist or quote itself a multiplier.
    openTrade: function (data) {
      var self_ = this;
      this._needUid();
      return this.rpc('open_trade', {
        p_symbol: String(data.symbol || data.pair || '').toUpperCase().split('/')[0].replace(/[^A-Z0-9]/g, ''),
        p_coin: data.coin || 'USDT',
        p_side: data.side,
        p_amount: Number(data.amount),
        p_duration_sec: Number(data.duration_sec != null ? data.duration_sec : data.durationSec),
        p_entry_price: Number(data.entry_price != null ? data.entry_price : data.entryPrice)
      }).then(function (res) {
        return Promise.all([self_._refreshTable('contracts'), self_._refreshTable('balances')])
          .then(function () { return res; });
      });
    },

    // Ends the contract. Idempotent on the server: a retry after a timeout
    // returns the stored result instead of paying twice.
    settleTrade: function (id, settlePrice) {
      var self_ = this;
      this._needUid();
      return this.rpc('settle_trade', {
        p_contract_id: String(id),
        p_settle_price: Number(settlePrice)
      }).then(function (res) {
        return Promise.all([self_._refreshTable('contracts'), self_._refreshTable('balances')])
          .then(function () { return res; });
      });
    },

    // Cancels a running order and returns the stake. The refund is posted by
    // cancel_contract through post_ledger, so it is atomic with the status change
    // and a member closing an order never has money stuck in an unsettled
    // contract. Idempotent: a second call returns the stored row and pays nothing.
    cancelTrade: function (id) {
      var self_ = this;
      return this.rpc('cancel_contract', { p_contract_id: String(id) }).then(function (row) {
        var res = self_._toV1Trade(self_._cache.trades.find(function (c) { return String(c.id) === String(id); }));
        return Promise.all([self_._refreshTable('contracts'), self_._refreshTable('balances')])
          .then(function () { return res || row; });
      });
    },

    // ---- AI Quant investments ----

    // The plan catalogue, with the bounds open_investment enforces. The AI page
    // draws its cards from this instead of carrying its own copy, which is what
    // let the page and the database disagree about which plans exist.
    getInvestmentProducts: function () {
      return (this._cache.investmentProducts || []).map(function (p) {
        return {
          id: p.id,
          code: p.code,
          name: p.name,
          period_days: parseInt(p.period_days, 10) || 0,
          rate_min: parseFloat(p.rate_min) || 0,
          rate_max: parseFloat(p.rate_max) || 0,
          min_principal: p.min_principal == null ? null : parseFloat(p.min_principal),
          max_principal: p.max_principal == null ? null : parseFloat(p.max_principal),
          is_active: p.is_active !== false
        };
      }).filter(function (p) { return p.is_active; })
        .sort(function (a, b) { return a.period_days - b.period_days; });
    },

    getAIOrders: function () {
      return this._cache.aiOrders.map(this._toV1AIOrder)
        .sort(function (a, b) { return new Date(b.created_at || 0) - new Date(a.created_at || 0); });
    },

    // addAIOrder kept its v1 field names, and open_investment needs the product
    // CODE, which those names never carried - so every call was rejected with
    // "unknown investment product" and the page reported success anyway. The
    // code-keyed entry point is what the AI page uses now.
    openInvestment: function (code, principal, coin) {
      var self_ = this;
      this._needUid();
      return this.rpc('open_investment', {
        p_product_code: String(code),
        p_principal: Number(principal),
        p_coin: coin || 'USDT'
      }).then(function (id) {
        return self_._refreshTable('investments').then(function () { return id; });
      });
    },

    addAIOrder: function (data) {
      var self_ = this;
      this._needUid();
      var code = data.product_code || data.productCode ||
                 (data.investment_products && data.investment_products.code);
      if (!code) return Promise.reject(new Error('Unknown investment product'));
      return this.rpc('open_investment', {
        p_product_code: code,
        p_principal: data.principal != null ? data.principal : data.amount,
        p_coin: data.coin || 'USDT'
      }).then(function () {
        return self_._refreshTable('investments');
      });
    },

    updateAIOrder: function (id, patch) {
      var days = patch && (patch.settledDays != null ? patch.settledDays : patch.settled_days);
      if (days == null) {
        return Promise.reject(new Error('Only settled_days can be updated; use settleInvestmentDay to pay out'));
      }
      return this.settleInvestmentDay(id, days, (patch && patch.note) || null);
    },

    // Settles the days up to p_settledDays and pays them through the ledger.
    // The database advances the counter, so this cannot pay the same day twice.
    settleInvestmentDay: function (id, settledDays, note) {
      var self_ = this;
      return this.rpc('settle_investment_day', {
        p_investment_id: Number(id),
        p_settled_days: Number(settledDays),
        p_note: note || null
      }).then(function (res) {
        return Promise.all([self_._refreshTable('investments'), self_._refreshTable('balances')])
          .then(function () { return res; });
      });
    },

    // Cancels and refunds the principal plus the unsettled days. Admin only.
    cancelInvestment: function (id, note) {
      var self_ = this;
      return this.rpc('cancel_investment', {
        p_investment_id: Number(id), p_note: note || null
      }).then(function (res) {
        return Promise.all([self_._refreshTable('investments'), self_._refreshTable('balances')])
          .then(function () { return res; });
      });
    },

    // ---- loans ----

    getLoans: function () {
      return this._cache.loans.map(this._toV1Loan)
        .sort(function (a, b) { return new Date(b.created_at || 0) - new Date(a.created_at || 0); });
    },
    getLoansForUser: function (uid) {
      return this._cache.loans
        .filter(function (l) { return String(l.uid) === String(uid); })
        .map(this._toV1Loan);
    },
    getLoan: function (id) {
      return this._toV1Loan(this._cache.loans.find(function (l) { return String(l.id) === String(id); }));
    },

    addLoan: function (data) {
      var self_ = this;
      var uid = this._needUid();
      return this.q('loans', {
        method: 'POST',
        body: {
          uid: uid,
          principal: data.principal != null ? data.principal : data.amount,
          days: Number(data.days),
          // rate and interest are sent as 0: the insert trigger pins a
          // non-admin's interest to 0 anyway, and an operator sets the real
          // terms at approval.
          rate: 0,
          interest: 0,
          status: 'pending',
          note: data.note || null
        }
      }).then(function (rows) { return self_._toV1Loan(rows[0]); });
    },

    updateLoanStatus: function (id, status, extra) {
      var e = extra || {};
      return this.rpc('admin_set_loan_status', {
        p_loan_id: Number(id),
        p_status: status,
        p_note: e.note || null,
        p_interest: e.interest != null ? e.interest : null
      }).then(function () { return true; });
    },

    // ---- KYC ----

    getVerification: function (uid) {
      return this._cache.verifications[uid || this._uid()] || null;
    },
    getAllVerifications: function () { return Object.values(this._cache.verifications); },

    submitVerification: function (uid, data) {
      var self_ = this;
      this._needUid();
      return this.rpc('customer_submit_kyc', {
        p_name:data.fullName || data.full_name || data.name || '', p_email:data.email || '',
        p_number:data.idNumber || data.id_number || '',p_phone:data.phone || '',
        p_front:data.idFront || data.idFrontUrl || data.id_front_url || data.id_front || '',
        p_back:data.idBack || data.idBackUrl || data.id_back_url || data.id_back || ''
      }).then(function (row) {
        self_._handleRealtime('verifications',{eventType:'INSERT',new:row,old:{}});return row;
      });
    },

    submitAdvancedKyc: function (image) {
      var self_ = this;
      this._needUid();
      return this.rpc('customer_submit_advanced_kyc',{p_image:image}).then(function (row) {
        self_._handleRealtime('verifications',{eventType:'UPDATE',new:row,old:{}});return row;
      });
    },

    updateVerificationStatus: function (uid, status, extra) {
      var e = extra || {};
      return this.rpc('admin_review_verification', {
        p_uid: String(uid),
        p_status: status,
        p_reason: e.reason || e.rejectionReason || null
      }).then(function () { return true; });
    },

    // The second KYC tier. v2 keeps advanced status in dedicated columns, and a
    // trigger blocks a non-admin from touching them.
    updateVerificationAdvanced: function (uid, fields) {
      var f = fields || {};
      var allowed = ['advanced', 'advanced_note', 'advanced_submitted_at'];
      var body = {};
      allowed.forEach(function (k) { if (f[k] !== undefined) body[k] = f[k]; });
      if (f.advancedStatus != null) body.advanced_status = f.advancedStatus;
      if (f.advancedReviewedAt != null) body.advanced_reviewed_at = f.advancedReviewedAt;
      if (!Object.keys(body).length) return Promise.resolve(true);
      return this.q('verifications?uid=eq.' + encodeURIComponent(String(uid)), { method: 'PATCH', body: body })
        .then(function () { return true; });
    },

    // ---- chat ----

    // v2 splits a conversation into chat_threads + chat_messages, so posting
    // needs a thread id. The schema allows exactly one open thread per user, so
    // this either finds it or creates it.
    _ensureThread: function (uid) {
      var self_ = this;
      var key = String(uid);
      if (this._threadCache[key]) return Promise.resolve(this._threadCache[key]);

      return this.q('chat_threads?uid=eq.' + encodeURIComponent(key) +
                    '&closed_at=is.null&select=id&limit=1', {})
        .then(function (rows) {
          if (rows && rows.length) {
            self_._threadCache[key] = rows[0].id;
            return rows[0].id;
          }
          return self_._refreshTable('chat_messages').then(function () { return null; });
        })
        .then(function (id) {
          if (id) return id;
          return self_.q('chat_threads', { method: 'POST', body: { uid: key } })
            .then(function (rows) {
              var tid = rows[0].id;
              self_._threadCache[key] = tid;
              return tid;
            });
        });
    },

    getChat: function (uid) {
      var key = String(uid || this._uid());
      return (this._cache.chatMessages[key] || []).map(this._toV1Chat)
        .sort(function (a, b) { return new Date(a.created_at || 0) - new Date(b.created_at || 0); });
    },
    getChatUsers: function () {
      return Object.keys(this._cache.chatMessages);
    },

    sendChatMessage: function (uid, fromRole, message, extra) {
      var self_ = this;
      var token = this._adminTokenForPage();
      var e = extra || {};
      if (fromRole === 'admin' && token && !this.isAdmin) {
        return this.rpc('admin_support_send', {tok: token, p_uid: String(uid), p_body: message || '', p_attachments: e.attachments || []})
          .then(function (row) {
            self_._handleRealtime('chat_messages', {eventType:'INSERT',new:row,old:{}});
            return self_._toV1Chat(row);
          });
      }
      var target = String(uid || this._needUid());
      // from_role is forced to 'user' by an insert trigger for non-admins, so
      // whatever the client sends here cannot make this look like a support
      // reply. Sending 'admin' from the admin page is legitimate and allowed.
      return this._ensureThread(target).then(function (threadId) {
        return self_.q('chat_messages', {
          method: 'POST',
          body: {
            thread_id: threadId,
            uid: target,
            from_role: fromRole || 'user',
            body: message || '',
            attachments: e.attachments || []
          }
        });
      }).then(function (rows) { return self_._toV1Chat(rows[0]); });
    },

    markChatRead: function (uid) {
      var token = this._adminTokenForPage();
      if (token && !this.isAdmin) return this.rpc('admin_support_read', {tok:token,p_uid:String(uid)}).then(function () { return this.pullBlob('chat_messages'); }.bind(this));
      var target = String(uid || this._uid());
      var msgs = this._cache.chatMessages[target] || [];
      var unread = msgs
        .filter(function (m) { return m.from_role === 'user' && !m.read_at; })
        .map(function (m) { return m.id; });
      if (!unread.length) return Promise.resolve(true);
      return this.q('chat_messages?uid=eq.' + encodeURIComponent(target) +
                    '&id=in.(' + unread.join(',') + ')', { method: 'PATCH', body: { read_at: new Date().toISOString() } })
        .then(function () { return true; });
    },

    editChatMessage: function (uid, id, text) {
      return this.q('chat_messages?uid=eq.' + encodeURIComponent(String(uid)) +
                    '&id=eq.' + Number(id), { method: 'PATCH', body: { body: text } })
        .then(function () { return true; });
    },

    // Soft delete. The column is `deleted`, and a non-admin may not touch a
    // message once support has replied under it.
    deleteChatMessage: function (uid, id) {
      return this.q('chat_messages?uid=eq.' + encodeURIComponent(String(uid)) +
                    '&id=eq.' + Number(id), { method: 'PATCH', body: { deleted: true } })
        .then(function () { return true; });
    },

    // ---- coin addresses ----

    getCoinAddresses: function () {
      var out = {};
      Object.keys(this._cache.coinAddresses).forEach(function (k) {
        var a = this._cache.coinAddresses[k];
        out[k] = a;
      }, this);
      return out;
    },
    getCoinAddress: function (coin, network) {
      if (network) return this._cache.coinAddresses[coin + ':' + network] || null;
      // v1 keyed by coin alone. v2's key is (coin, network), so a single match
      // is returned but an ambiguous coin returns the first one found, which is
      // what v1 callers expect.
      var hit = null;
      Object.keys(this._cache.coinAddresses).forEach(function (k) {
        if (!hit && this._cache.coinAddresses[k].coin === coin) hit = this._cache.coinAddresses[k];
      }, this);
      return hit;
    },

    // v2 keys on (coin, network), so callers must say which network. A default
    // is picked when the caller does not, to keep the old one-argument shape
    // working.
    saveCoinAddress: function (coin, net, addr) {
      var network = net || 'DEFAULT';
      var body = { coin: coin, network: network, address: addr, is_active: true };
      var self_ = this;
      return this.q('coin_addresses', { method: 'POST', body: body })
        .then(function (rows) {
          if (rows && rows.length) return rows[0];
          throw new Error('no row inserted');
        })
        .catch(function () {
          return self_.q('coin_addresses?coin=eq.' + encodeURIComponent(coin) +
                         '&network=eq.' + encodeURIComponent(network),
                         { method: 'PATCH', body: { address: addr, is_active: true } })
            .then(function (rows) {
              if (!rows || !rows.length) throw new Error('coin address write failed');
              return rows[0];
            });
        });
    },

    deleteCoinAddress: function (coin, network) {
      var net = network || 'DEFAULT';
      var self_ = this;
      return this.q('coin_addresses?coin=eq.' + encodeURIComponent(coin) +
                    '&network=eq.' + encodeURIComponent(net), { method: 'DELETE' })
        .then(function () { return self_.addDisabledCoin(coin + ':' + net); });
    },

    // v1 kept a "disabled coins" list in admin_settings. v2 uses app_settings;
    // the key and the shape are unchanged so the admin page keeps working.
    addDisabledCoin: function (coin) {
      var list = this._cache.adminSettings['disabled_coin_addresses'];
      if (Array.isArray(list) && list.indexOf(coin) !== -1) return Promise.resolve(list);
      var next = (Array.isArray(list) ? list.slice() : []).concat([coin]);
      return this.setSetting('disabled_coin_addresses', next).then(function () {
        this._cache.adminSettings['disabled_coin_addresses'] = next;
        this._dispatchTrustSync('coin_addresses');
        return next;
      }.bind(this));
    },
    enableCoin: function (coin) {
      var list = this._cache.adminSettings['disabled_coin_addresses'];
      if (!Array.isArray(list) || list.indexOf(coin) === -1) return Promise.resolve(list);
      var next = list.filter(function (c) { return c !== coin; });
      return this.setSetting('disabled_coin_addresses', next).then(function () {
        this._cache.adminSettings['disabled_coin_addresses'] = next;
        this._dispatchTrustSync('coin_addresses');
        return next;
      }.bind(this));
    },

    // ---- settings ----

    getSetting: function (key) {
      var v = this._cache.adminSettings[key];
      return v === undefined ? null : v;
    },
    setSetting: function (key, value) {
      var self_ = this;
      return this.q('app_settings', { method: 'POST', body: { key: key, value: value } })
        .catch(function () {
          return self_.q('app_settings?key=eq.' + encodeURIComponent(key),
                         { method: 'PATCH', body: { value: value } });
        })
        .then(function (rows) {
          self_._cache.adminSettings[key] = value;
          return value;
        });
    },

    // =====================================================================
    // Sessions
    // =====================================================================
    // v1 minted a token in the browser and stored a matching row, so anyone
    // could mint one. v2's session is the GoTrue JWT and it cannot be forged.
    //
    // app.js still passes its own local `tok` around as a UI handle. These
    // shims keep that plumbing working by resolving it to the live Supabase
    // session, so most of app.js's session code does not have to change at
    // once. The token argument is accepted and ignored.
    //
    // TODO(app.js): replace the local token entirely and read
    // supabase.auth.getSession() directly. These shims are a bridge, not a
    // permanent interface.

    createSession: function (tok, uid, extra) {
      var self_ = this;
      var e = extra || {};
      // No session row to write. Persist the app-specific bits on the profile
      // instead, which is where they belong.
      var patch = {};
      if (e.language != null) patch.language = e.language;
      if (e.is_guest != null) patch.is_guest = !!e.is_guest;
      var p = Object.keys(patch).length
        ? this.updateUser(uid || this._uid(), patch).catch(function () { return null; })
        : Promise.resolve(null);

      return p.then(function () { return { token: tok, uid: self_._uid(), language: e.language || null }; });
    },

    getSession: function (tok) {
      var self_ = this;
      return this._waitForClient().then(function (lib) {
        return lib.auth.getSession();
      }).then(function (res) {
        var s = res && res.data ? res.data.session : null;
        self_._adoptSession(s);
        if (!s) return null;
        var row = self_._cache.users.find(function (u) { return u.id === s.user.id; });
        return {
          token: tok || s.access_token,
          uid: s.user.id,
          // v1 read `admin` off its own session row. is_admin lives in the
          // profile, which is why this is the cached flag.
          admin: self_.isAdmin,
          is_guest: !!(row && row.is_guest),
          language: (row && row.language) || null,
          expires_at: s.expires_at
        };
      });
    },

    updateSession: function (tok, patch) {
      // Route anything session-shaped onto the profile.
      var body = {};
      var p = patch || {};
      if (p.language != null) body.language = p.language;
      if (p.is_guest != null) body.is_guest = !!p.is_guest;
      if (!Object.keys(body).length) return Promise.resolve(true);
      return this.updateUser(this._uid(), body).then(function () { return true; });
    },

    deleteSession: function () {
      return this.logout();
    },

    // v1 trusted a `p_admin` flag on its own session row. v2 has no such thing:
    // is_admin is read from the database, so a client cannot grant itself
    // admin by writing a session field.
    isAdminSession: function () { return this.isAdmin; }
  };

  return self;
})();

// Backward compat: expose as DB
var DB = TrustDB;

// Auto-init from config
if (typeof SITE_CONFIG !== 'undefined') {
  DB.init({
    url: SITE_CONFIG.DB_URL,
    anon: SITE_CONFIG.DB_ANON_KEY,
    service: SITE_CONFIG.DB_SERVICE_KEY,
    readonly: SITE_CONFIG.READONLY
  });
}
