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
      this._initPromise = new Promise(function (resolve) {
        // The session has to resolve before the first load: a query issued with
        // no JWT returns nothing, and under RLS "nothing" is a successful empty
        // result rather than an error, so a premature load would look like an
        // empty database and leave the page blank.
        self_._awaitClientAndSession().then(function () {
          // Must be awaited. Resolving this promise before the first load
          // finished reported "ready" while connected was still false, so a
          // caller gating on ready() then had to wait on the separate 'ready'
          // event -- against a timeout that had already started counting.
          return self_._bootstrap();
        }).then(function () {
          self_._startRealtime();
          resolve(true);
        }).catch(function (e) {
          console.warn('TrustDB init problem:', e && e.message);
          self_._bootstrap();
          resolve(false);
        });
      });

      return true;
    },

    ready: function () {
      return this._initPromise || Promise.resolve(false);
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
            self_._adoptSession(session);
            // The visible dataset changes wholesale on sign-in and sign-out, so
            // reload rather than merge, and tell every page to re-render.
            self_._bootstrap();
          });
        });
      });
    },

    _adoptSession: function (session) {
      this._session = session || null;
      this._authUser = session && session.user ? session.user : null;

      // is_admin lives in the profile table, not the JWT, and the token is not
      // re-issued when it changes. Read it from the row we already cache, and
      // fall back to false so an admin-only control is never briefly shown.
      var row = this._authUser ? this._cache.users.find(function (u) { return u.id === self._authUser.id; }) : null;
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

      var headers = {
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
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
          self_._refreshTable(path.split('?')[0]);
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

    // v1 signature: register(account, password) -> { ok, user }
    //
    // Supabase Auth addresses accounts by email, so `account` must be an email
    // address here. A username or a 0x wallet would need a different provider
    // configured in the dashboard; it is not supported by this flow.
    register: function (account, password, extra) {
      var self_ = this;
      var email = String(account || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return Promise.reject(new Error('Enter a valid email address'));
      }
      if (!password || String(password).length < 8) {
        return Promise.reject(new Error('Password must be at least 8 characters'));
      }

      return this._waitForClient().then(function (lib) {
        return lib.auth.signUp({
          email: email,
          password: password,
          options: { data: extra || {} }
        });
      }).then(function (res) {
        if (res.error) throw new Error(res.error.message);

        // With "Confirm email" on, GoTrue returns a user but no session. Say so
        // rather than letting the caller treat it as a successful sign-in and
        // then fail on the first protected query.
        if (!res.data.session) {
          return {
            ok: true,
            needsEmailConfirm: true,
            message: 'Check your email to confirm the account, then sign in.'
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

    // v1 signature: login(account, password) -> { ok, user }
    login: function (account, password) {
      var self_ = this;
      var email = String(account || '').trim().toLowerCase();

      return this._waitForClient().then(function (lib) {
        return lib.auth.signInWithPassword({ email: email, password: password });
      }).then(function (res) {
        if (res.error) {
          // Do not distinguish "no such account" from "wrong password": saying
          // which one it was turns the sign-in form into an account enumerator.
          throw new Error('Incorrect email or password');
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
        if (!u || !u.email) throw new Error('Please login first');
        return lib.auth.reauthenticate({ email: u.email, password: currentPassword });
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
        account: (u.email || u.id).toLowerCase(),
        email: u.email,
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

    _toV1Trade: function (c) {
      if (!c) return null;
      return {
        id: c.id,
        uid: c.uid,
        product_id: c.product_id,
        coin: c.coin,
        side: c.side,
        amount: parseFloat(c.amount),
        entry_price: parseFloat(c.entry_price),
        sell_price: c.settle_price == null ? null : parseFloat(c.settle_price),
        sellPrice: c.settle_price == null ? null : parseFloat(c.settle_price),
        payout: c.payout == null ? null : parseFloat(c.payout),
        // v1 'open' / 'won' / 'lost' mapped directly.
        status: c.status,
        opened_at: c.opened_at,
        closed_at: c.settled_at,
        settled_at: c.settled_at,
        expires_at: c.expires_at,
        duration_sec: c.duration_sec
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

      // Always public, always safe to try.
      var publicTables = ['coin_addresses', 'app_settings', 'products', 'investment_products'];
      var privateTables = ['users', 'balances', 'verifications', 'loans', 'transactions', 'contracts', 'investments', 'chat_messages'];
      var tables = signedIn ? publicTables.concat(privateTables) : publicTables;

      var jobs = tables.map(function (t) {
        return self_._loadTable(t).then(function () {
          self_._dispatchTrustSync(t);
        }).catch(function (e) {
          // A refused table is normal, not fatal: RLS rejecting a read returns
          // an empty set, and a genuine network error should not stop the rest
          // of the page from rendering.
          if (e && /HTTP 40[13]/.test(e.message)) return;
          console.warn('TrustDB load failed for ' + t + ':', e.message || e);
        });
      });

      return Promise.all(jobs).then(function () {
        self_.connected = true;
        self_.lastSync = Date.now();
        self_._adoptSession(self_._session);
        self_._notify('ready');
      });
    },

    _loadTable: function (table, keyField) {
      var self_ = this;
      self_._loadSeq = self_._loadSeq || {};
      var mySeq = (self_._loadSeq[table] || 0) + 1;
      self_._loadSeq[table] = mySeq;
      var startTs = Date.now();

      var q = this._query(table);
      return this.q(q.path, {}).then(function (rows) {
        if (self_._loadSeq[table] !== mySeq) return (rows || []).length;
        rows = rows || [];
        self_._applyRows(table, rows, startTs);
        self_._stashRows(table, rows);
        return rows.length;
      });
    },

    // v1 name, kept because app.js calls it 35 times.
    pullBlob: function (table) {
      var self_ = this;
      return this._loadTable(table).then(function () {
        self_._dispatchTrustSync(table);
        return true;
      });
    },

    fetchBlob: function (table) { return this.pullBlob(table); },
    enqueue: function (table) { return this.pullBlob(table); },

    _applyRows: function (table, rows, startTs) {
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
        Object.keys(incoming).forEach(function (u0) {
          var list = self._cache.chatMessages[u0] = self._cache.chatMessages[u0] || [];
          var byId = {};
          incoming[u0].forEach(function (r) { byId[r.id] = r; });
          for (var i0 = list.length - 1; i0 >= 0; i0--) {
            var m0 = list[i0];
            if (m0.id in byId) { list[i0] = byId[m0.id]; delete byId[m0.id]; }
            else if ((self._rowAt['chat_messages:' + m0.id] || 0) <= startTs) list.splice(i0, 1);
          }
          for (var k0 in byId) {
            list.push(byId[k0]);
            self._rowAt['chat_messages:' + byId[k0].id] = Date.now();
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
      // Only the tables a signed-in viewer can see. Subscribing to all of them
      // while signed out produces nothing but 401s on the channel.
      if (!this._uid()) return;
      ['balances', 'transactions', 'contracts', 'investments', 'loans', 'chat_messages', 'verifications']
        .forEach(function (t) { self_._subscribeTable(t); });
    },

    _stopRealtime: function () {
      var self_ = this;
      var lib = window.supabase;
      Object.keys(this._channels).forEach(function (name) {
        try { if (lib) lib.removeChannel(self_._channels[name]); } catch (e) {}
      });
      this._channels = {};
    },

    _subscribeTable: function (table) {
      var self_ = this;
      if (typeof window === 'undefined' || !window.supabase) return;
      try {
        var channel = window.supabase.channel('db2_' + table)
          .on('postgres_changes', { event: '*', schema: 'public', table: table }, function (payload) {
            self_._handleRealtime(table, payload);
          })
          .subscribe(function (status) {
            if (status === 'SUBSCRIBED') console.log('Realtime: ' + table + ' subscribed');
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
          var cl = this._cache.chatMessages[rec.uid] = this._cache.chatMessages[rec.uid] || [];
          if (eventType === 'DELETE') {
            this._cache.chatMessages[rec.uid] = cl.filter(function (m) { return m.id !== old.id; });
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
    _profitKey: function (uid) { return 'profit_mode:' + (uid || this._uid()); },
    setUserProfitMode: function (uid, on) {
      return this.setSetting(this._profitKey(uid), !!on);
    },
    getUserProfitMode: function (uid) {
      return !!this.getSetting(this._profitKey(uid));
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
        type: data.type,
        coin: data.coin,
        amount: data.amount,
        // v1 accepted whatever status the client sent. The insert policy only
        // accepts 'pending', which is the point: a client cannot file its own
        // deposit as already approved.
        status: 'pending',
        reference_id: data.reference || data.referenceId || null,
        proof_url: data.proof || data.proofUrl || null,
        proof_name: data.proof_name || data.proofName || null,
        note: data.note || data.description || null
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

    getTrades: function () {
      return this._cache.trades.map(this._toV1Trade)
        .sort(function (a, b) { return new Date(b.opened_at || 0) - new Date(a.opened_at || 0); });
    },
    getTradesForUser: function (uid) {
      return this._cache.trades
        .filter(function (t) { return String(t.uid) === String(uid); })
        .map(this._toV1Trade);
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
    // perform, so it is gone: scripts/settle.mjs does it with the service key.
    updateTrade: function (id) {
      return Promise.reject(new Error(
        'Trades are settled by the server, not the browser. Run scripts/settle.mjs ' +
        '(or wait for the scheduled job) to settle ' + id + '.'
      ));
    },

    // ---- AI Quant investments ----

    getAIOrders: function () {
      return this._cache.aiOrders.map(this._toV1AIOrder)
        .sort(function (a, b) { return new Date(b.created_at || 0) - new Date(a.created_at || 0); });
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
        return Promise.reject(new Error('Only settled_days can be updated; use admin_settle_investment to pay out'));
      }
      return this.rpc('update_investment_progress', {
        p_investment_id: Number(id), p_settled_days: Number(days)
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
      var target = String(uid || this._needUid());
      var payload = {
        uid: target,
        full_name: data.fullName != null ? data.fullName : data.full_name,
        email: data.email,
        id_number: data.idNumber != null ? data.idNumber : data.id_number,
        phone: data.phone,
        id_front_url: data.idFrontUrl != null ? data.idFrontUrl : data.id_front_url,
        id_back_url: data.idBackUrl != null ? data.idBackUrl : data.id_back_url,
        status: 'pending',
        submitted_at: new Date().toISOString()
      };
      return this.q('verifications', { method: 'POST', body: payload })
        .then(function (rows) { return rows[0]; });
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
      var target = String(uid || this._needUid());
      var e = extra || {};
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
