/* TrustCom static clone — shared config & utilities (trustcom.vip) */
(function (global) {
  'use strict';

  function dbSync(key) {
    try {
      if (global.DB && global.DB.ENABLED && typeof global.DB.enqueue === 'function') global.DB.enqueue(key);
    } catch (e) {}
  }

  var DEFAULT_CONFIG = {
    apiBaseUrl: 'https://trustcom.vip',
    appTitle: 'Trust',
    logoPath: 'img/logo.png',
    defaultLanguage: 'en',
    adminPassword: 'admin123',
    walletLoginEnabled: true,
    disablePasswordLogin: false,
    advancedAuthEnabled: false,
    aiQuantEnabled: true,
    metalTabFirst: false,
    showMinOrderAmount: true,
    showCountdownCurrentStatus: true,
    disableWeekendTradingForNonCrypto: false,
    withdrawalFeeRate: 0,
    minRechargeAmount: 100,
    minWithdrawAmount: 20,
    aiQuantAutoApproveMin: 1,
    aiQuantSettleIntervalHours: 24,
    customerServiceUrl: 'service.html',
    walletConnectProjectId: '',
    walletConnectRedirectTrust: true
  };

  var DEFAULT_COIN_ADDRESSES = {
    USDT: { net: 'ERC-20', addr: '0x8b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e' },
    BTC: { net: 'Bitcoin', addr: 'bc1q9kz5y2p3v7hjm4x8nrdwct6e5fasd0g1h2j3k4l5' },
    ETH: { net: 'ERC-20', addr: '0x7f2a8b3c4d5e6f708192a3b4c5d6e7f8091a2b3c' },
    SOL: { net: 'Solana', addr: '4h1Zq9Wx2Tp3VcA8kLd5Nm6rBs7Jg1Kt2Yu3Uw4Xq5Ro' }
  };

  // uid -> { coin: balance } map used by guessVip (DB-backed).
  function getBalanceMap() {
    var map = {};
    if (dbReadable() && DB && DB._cache && DB._cache.userBalances) {
      try {
        Object.keys(DB._cache.userBalances).forEach(function (u) {
          map[u] = DB._cache.userBalances[u] || {};
        });
      } catch (e) {}
    }
    return map;
  }

  function guessVip(uid) {
    var b = getBalanceMap();
    var m = b[uid] || {};
    var usdt = parseFloat(m.USDT) || 0;
    var total = usdt;
    ['BTC', 'ETH', 'LTC', 'XRP', 'DOGE', 'TON', 'ADA', 'BNB', 'SOL', 'TRX', 'UNI', 'AVAX', 'DOT', 'LINK', 'BCH', 'BSV', 'IOTA', 'ETC', 'USDC', 'TUSD'].forEach(function (sym) {
      var bal = parseFloat(m[sym]) || 0;
      if (!bal) return;
      var d = marketFlat[sym];
      total += bal * (d ? (parseFloat(d.price) || 0) : 0);
    });
    if (total >= 500000) return { tier: 'VIP5', label: 'VIP 5', color: '#7c3aed' };
    if (total >= 100000) return { tier: 'VIP4', label: 'VIP 4', color: '#1652f0' };
    if (total >= 50000) return { tier: 'VIP3', label: 'VIP 3', color: '#059669' };
    if (total >= 10000) return { tier: 'VIP2', label: 'VIP 2', color: '#d97706' };
    if (total >= 1000) return { tier: 'VIP1', label: 'VIP 1', color: '#0ea5e9' };
    return { tier: 'VIP0', label: 'VIP 0', color: '#94a3b8' };
  }

  function isNonCryptoWeekend(symbol) {
    var sym = String(symbol || '').split('/')[0].toUpperCase();
    var crypto = COIN_KEYS.indexOf(sym) !== -1;
    if (crypto) return false;
    var d = new Date();
    var day = d.getDay();
    return day === 0 || day === 6;
  }

  function weekendTradingEnabled(symbol) {
    var cfg = getConfig();
    if (cfg.disableWeekendTradingForNonCrypto) {
      if (isNonCryptoWeekend(symbol)) return false;
    }
    return true;
  }

  function getConfigDefaults() {
    var copy = {};
    Object.keys(DEFAULT_CONFIG).forEach(function (k) { copy[k] = DEFAULT_CONFIG[k]; });
    return copy;
  }

  function mergeConfig(saved) {
    var cfg = getConfigDefaults();
    if (saved && typeof saved === 'object') {
      Object.keys(DEFAULT_CONFIG).forEach(function (k) {
        if (saved[k] !== undefined) cfg[k] = saved[k];
      });
    }
    return cfg;
  }

  // DB-backed brand config (admin_settings 'config' key); defaults apply
  // until Supabase connects, then the database version wins.
  function getConfig() {
    var saved = null;
    try {
      if (dbReadable() && DB.getSetting) {
        saved = DB.getSetting('config');
        if (typeof saved === 'string') { try { saved = JSON.parse(saved) || null; } catch (e) { saved = null; } }
      }
    } catch (e) {}
    return mergeConfig(saved);
  }

  function reloadConfigFromDb() {
    var cfg = getConfig();
    global.AppConfig = cfg;
    try {
      if (document.title && cfg.appTitle && document.title.indexOf('Trust') !== -1 && document.title.indexOf(cfg.appTitle) === -1) {
        document.title = document.title.split('Trust').join(cfg.appTitle);
      }
    } catch (e) {}
    return cfg;
  }

  function saveConfig(cfg) {
    var out = {};
    Object.keys(DEFAULT_CONFIG).forEach(function (k) {
      if (cfg[k] !== undefined) out[k] = cfg[k];
    });
    if (dbActive() && DB.setSetting) DB.setSetting('config', JSON.stringify(out)).catch(function () {});
    global.AppConfig = mergeConfig(out);
    return out;
  }

  function resetConfig() {
    if (dbActive() && DB.setSetting) DB.setSetting('config', JSON.stringify({})).catch(function () {});
    global.AppConfig = getConfigDefaults();
  }

  global.AppConfig = mergeConfig(null);

  // Needed by restoreSession() which runs during boot below (before the
  // session-layer `var` statements further down execute).
  var SESSION_COOKIE = 'trsstok';
  // One-time legacy-trade migration guard. MUST be declared before
  // bootDbHooks() runs: onReady fires mid-eval and would otherwise be
  // reset to false by the later `var` initialization, letting a second
  // trustsync event run the migration again (duplicate rows).
  var _migTradesDone = false;

  (function bootDbHooks() {
    if (typeof DB === 'undefined' || !DB) return;
    function hook() {
      try { reloadConfigFromDb(); } catch (e) {}
      try { applyI18n(); } catch (e) {}
      try { updateMenuUser(); } catch (e) {}
      try { migrateLegacyTrades(); } catch (e) {}
      setTimeout(function () { try { settleExpiredTrades(); } catch (e) {} }, 0);
    }
    if (DB.onReady) DB.onReady(hook);
    if (typeof window !== 'undefined') {
      window.addEventListener('trustsync:admin_settings', hook);
      window.addEventListener('trustsync:users', function () { try { updateMenuUser(); } catch (e) {} });
      // Balances arriving late (async bootstrap) should refresh the header
      // wallet figure; admin flag may also arrive with the users table.
      window.addEventListener('trustsync:user_balances', function () { try { updateMenuUser(); } catch (e) {} });
    }
    if (typeof document !== 'undefined') {
      restoreSession().then(function () {
        try { applyI18n(); updateMenuUser(); } catch (e) {}
      });
    }
  })();

  (function applyAppTitle() {
    try {
      if (!AppConfig.appTitle) return;
      var t = document.title;
      if (t && t.indexOf('Trust') !== -1 && t.indexOf(AppConfig.appTitle) === -1) {
        document.title = t.split('Trust').join(AppConfig.appTitle);
      }
    } catch (e) {}
  })();

  var ICON_MAP = {
    USDT: 'usdt.png', BTC: 'btc.png', ETH: 'eth.png', LTC: 'ltc.png', XRP: 'xrp.png', DOGE: 'DOGE.png',
    TON: 'TON.png', ADA: 'ADA.png', BNB: 'BNB.png', TRX: 'TRX.png', UNI: 'UNI.png',
    AVAX: 'AVAX.png', USDC: 'USDC.png', DOT: 'DOT.png', LINK: 'LINK.png',
    BCH: 'BCH.png', BSV: 'BSV.png', IOTA: 'IOTA.png', ETC: 'ETC.png', TUSD: 'TUSD.png',
    SOL: 'SOL.png',
    XAU: 'XAU.svg', XAG: 'XAG.svg', XPD: 'XPD.svg', XPT: 'XPT.svg',
    COMEXAU: 'XAU.svg', COMEXAG: 'XAG.svg', MAUTD: 'XAU.svg', AUTD: 'XAU.svg',
    AU999: 'XAU.svg', PTUSD: 'XPT.svg',
    EUR: 'EUR.svg', AUD: 'AUD.svg', GBP: 'GBP.svg', USD: 'USD_CNY.svg',
    NZD: 'NZD.svg', EURCHF: 'EUR.svg'
  };
  var ICON_BY_NAME = { 'CNY': 'USD_CNY.svg', 'JPY': 'USD_JPY.svg' };

  function trim(s) { return (s || '').trim(); }

  function decimalsFor(price) {
    var p = parseFloat(price);
    if (!isFinite(p)) return 2;
    if (p >= 1000) return 2;
    if (p >= 100) return 3;
    if (p >= 10) return 4;
    if (p >= 1) return 5;
    return 6;
  }

  function parseItem(row, tab) {
    var sym = trim(row.symbol);
    var name = trim(row.name);
    var price = parseFloat(row.price);
    var change = parseFloat(row.change);
    return {
      s: sym,
      n: name,
      price: price,
      change: change,
      dec: decimalsFor(price),
      i: (sym === 'USD' ? (ICON_BY_NAME[name] || 'USD_CNY.svg') : (ICON_MAP[sym] || null)),
      pid: row.pid,
      tab: tab,
      isUp: row.isUp === 1 || row.isUp === true
    };
  }

  function fallbackMarket() {
    return {
      crypto: [
        { s: 'BTC', n: 'USDT', price: 77000, change: 1.98, dec: 2, i: 'btc.png' },
        { s: 'ETH', n: 'USDT', price: 1879.76, change: 3.17, dec: 2, i: 'eth.png' },
        { s: 'LTC', n: 'USDT', price: 44.709, change: 2.45, dec: 3, i: 'ltc.png' },
        { s: 'XRP', n: 'USDT', price: 1.11647, change: 6.33, dec: 5, i: 'xrp.png' },
        { s: 'DOGE', n: 'USDT', price: 0.107112, change: 57.83, dec: 6, i: 'DOGE.png' },
        { s: 'TON', n: 'USDT', price: 1.8333, change: 8.78, dec: 4, i: 'TON.png' },
        { s: 'ADA', n: 'USDT', price: 0.195501, change: 15.06, dec: 6, i: 'ADA.png' },
        { s: 'BNB', n: 'USDT', price: 583.786, change: 1.70, dec: 3, i: 'BNB.png' },
        { s: 'TRX', n: 'USDT', price: 0.315165, change: -3.64, dec: 6, i: 'TRX.png' },
        { s: 'UNI', n: 'USDT', price: 4.2006, change: 4.18, dec: 4, i: 'UNI.png' },
        { s: 'AVAX', n: 'USDT', price: 6.3588, change: 5.14, dec: 4, i: 'AVAX.png' },
        { s: 'DOT', n: 'USDT', price: 0.8288, change: 8.43, dec: 6, i: 'DOT.png' },
        { s: 'LINK', n: 'USDT', price: 8.2402, change: 4.32, dec: 4, i: 'LINK.png' },
        { s: 'BCH', n: 'USDT', price: 209.218, change: 1.56, dec: 3, i: 'BCH.png' },
        { s: 'BSV', n: 'USDT', price: 12.6931, change: 2.72, dec: 4, i: 'BSV.png' },
        { s: 'IOTA', n: 'USDT', price: 0.0686, change: 115.05, dec: 6, i: 'IOTA.png' },
        { s: 'ETC', n: 'USDT', price: 6.5757, change: 2.42, dec: 4, i: 'ETC.png' },
        { s: 'USDC', n: 'USDT', price: 1.0029, change: 0.25, dec: 4, i: 'USDC.png' },
        { s: 'TUSD', n: 'USDT', price: 0.95985, change: -3.59, dec: 5, i: 'TUSD.png' }
      ],
      metal: [
        { s: 'XAU', n: 'USD', price: 4043.60, change: 0.56, dec: 2, i: 'XAU.svg' },
        { s: 'XAG', n: 'USD', price: 57.575, change: 0.98, dec: 3, i: 'XAG.svg' },
        { s: 'XPD', n: 'USD', price: 1281.22, change: 1.88, dec: 2, i: 'XPD.svg' },
        { s: 'XPT', n: 'USD', price: 1647.52, change: 2.03, dec: 2, i: 'XPT.svg' }
      ],
      forex: [
        { s: 'EUR', n: 'USD', price: 1.1281, change: -1.52, dec: 4, i: 'EUR.svg' },
        { s: 'AUD', n: 'USD', price: 0.7127, change: 1.96, dec: 4, i: 'AUD.svg' },
        { s: 'GBP', n: 'USD', price: 1.3433, change: 0.25, dec: 4, i: 'GBP.svg' },
        { s: 'USD', n: 'CNY', price: 6.7289, change: -0.24, dec: 4, i: 'USD_CNY.svg' },
        { s: 'USD', n: 'JPY', price: 111.467, change: 0.08, dec: 3, i: 'USD_JPY.svg' }
      ]
    };
  }

  var MARKET = fallbackMarket();
  var marketFlat = {};
  var marketLive = false;

  function rebuildFlat() {
    marketFlat = {};
    ['crypto', 'metal', 'forex'].forEach(function (tab) {
      (MARKET[tab] || []).forEach(function (d) {
        d.pair = d.s + '/' + d.n;
        d.base = d.price;
        d.baseChange = d.change;
        marketFlat[d.pair] = d;
        if (!marketFlat[d.s]) marketFlat[d.s] = d;
      });
    });
  }
  rebuildFlat();

  function fmtPrice(n, dec) {
    return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  function pricePrefix(d) {
    if (d.n === 'USDT' || d.n === 'USD' || d.tab === 'crypto') return 'US$';
    return '';
  }

  function toast(type, msg) {
    var box = document.getElementById('toastBox');
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'toast-message toast-' + type;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, 2500);
  }

  function toggleMenu() {
    var m = document.getElementById('sideMenu');
    if (m) m.style.display = 'flex';
  }

  function closeMenu(ev) {
    var m = document.getElementById('sideMenu');
    if (!m) return;
    if (ev && ev.target !== m) return;
    m.style.display = 'none';
  }

  function service() {
    location.href = AppConfig.customerServiceUrl || 'service.html';
  }

  var _wallet = null; // in-memory only; sessions persist in the DB

  function getWallet() {
    return _wallet;
  }

  function genWalletAddress() {
    var h = '0x';
    var chars = '0123456789abcdef';
    for (var i = 0; i < 40; i++) h += chars[Math.floor(Math.random() * 16)];
    return h;
  }

  var WC_FALLBACK_PROJECT_ID = '8f0b6d9a5f4a7274bf5518ebb1948e3f';

  function wcProjectId() {
    try {
      var id = String((AppConfig && AppConfig.walletConnectProjectId) || '').trim();
      if (id && id.length >= 10 && id !== 'YOUR_PROJECT_ID') return id;
    } catch (e) {}
    return WC_FALLBACK_PROJECT_ID;
  }

  var wcAnnounced = {};
  try {
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('eip6963:announceProvider', function (e) {
        var d = e.detail;
        if (d && d.info && d.provider) {
          try { wcAnnounced[String(d.info.uuid || (d.info.rdns || d.info.name) || Math.random())] = { info: d.info, provider: d.provider }; } catch (e2) {}
        }
      });
    }
  } catch (e) {}

  function requestEip6963() {
    try { if (typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (e) {}
  }

  function eip6963List() {
    return Object.keys(wcAnnounced).map(function (k) { return wcAnnounced[k]; });
  }

  function providerRequestable(p) {
    return !!(p && typeof p.request === 'function');
  }

  function isTrustProvider(p) {
    return !!(p && (p.isTrust || p.isTrustWallet || p.isTrustWalletProvider || p.isTrustWalletProviderInjected));
  }

  function providerInfoMatchesTrust(info) {
    if (!info) return false;
    var n = String(info.name || '').toLowerCase();
    var r = String(info.rdns || '').toLowerCase();
    return r === 'com.trustwallet.app' || r.indexOf('trustwallet') !== -1 || r.indexOf('trust.wallet') !== -1 || n.indexOf('trust') !== -1;
  }

  function providerDisplayName(p, info) {
    if (info && info.name) return String(info.name);
    if (!p) return 'Unknown';
    if (isTrustProvider(p)) return 'Trust Wallet';
    if (p.isMetaMask) return 'MetaMask';
    if (p.isOkxWallet || p.isOKExWallet) return 'OKX Wallet';
    if (p.isTokenPocket) return 'TokenPocket';
    if (p.isCoinbaseWallet) return 'Coinbase Wallet';
    if (p.isBitKeep || p.isBitgetWallet) return 'Bitget / BitKeep Wallet';
    if (p.isImToken) return 'imToken';
    if (p.isWalletConnect) return 'WalletConnect v2';
    return 'EVM Wallet';
  }

  function firstTrustEip6963() {
    var list = eip6963List();
    for (var i = 0; i < list.length; i++) {
      if (providerInfoMatchesTrust(list[i].info) && providerRequestable(list[i].provider)) {
        return { provider: list[i].provider, source: 'EIP-6963 Trust provider', info: list[i].info };
      }
    }
    return null;
  }

  function firstEip6963() {
    var list = eip6963List();
    return list.length ? { provider: list[0].provider, source: 'EIP-6963 first provider', info: list[0].info } : null;
  }

  function pickInjectedProvider() {
    var t = firstTrustEip6963();
    if (t) return t;
    try {
      if (window.trustwallet && window.trustwallet.ethereum && providerRequestable(window.trustwallet.ethereum)) {
        return { provider: window.trustwallet.ethereum, source: 'window.trustwallet.ethereum', info: { name: 'Trust Wallet' } };
      }
    } catch (e) {}
    try {
      if (window.ethereum && Array.isArray(window.ethereum.providers)) {
        var arr = window.ethereum.providers;
        for (var i = 0; i < arr.length; i++) {
          if (isTrustProvider(arr[i]) && providerRequestable(arr[i])) return { provider: arr[i], source: 'window.ethereum.providers Trust', info: { name: 'Trust Wallet' } };
        }
        var e1 = firstEip6963();
        if (e1 && providerRequestable(e1.provider)) return e1;
        for (var j = 0; j < arr.length; j++) {
          if (providerRequestable(arr[j])) return { provider: arr[j], source: 'window.ethereum.providers first available', info: null };
        }
      }
    } catch (e) {}
    try { if (window.ethereum && providerRequestable(window.ethereum)) return { provider: window.ethereum, source: 'window.ethereum', info: null }; } catch (e) {}
    var e2 = firstEip6963();
    if (e2 && providerRequestable(e2.provider)) return e2;
    try {
      if (window.okxwallet) {
        if (window.okxwallet.ethereum && providerRequestable(window.okxwallet.ethereum)) {
          return { provider: window.okxwallet.ethereum, source: 'window.okxwallet.ethereum', info: { name: 'OKX Wallet' } };
        }
        if (providerRequestable(window.okxwallet)) return { provider: window.okxwallet, source: 'window.okxwallet', info: { name: 'OKX Wallet' } };
      }
    } catch (e) {}
    return null;
  }

  function waitForInjectedProvider(timeoutMs) {
    requestEip6963();
    return new Promise(function (resolve) {
      var started = Date.now();
      (function poll() {
        var p = pickInjectedProvider();
        if (p) return resolve(p);
        if (Date.now() - started > (timeoutMs || 4500)) return resolve(null);
        setTimeout(poll, 120);
      })();
    });
  }

  function isMobileUA() {
    try { return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || ''); } catch (e) { return false; }
  }

  var wcSdkPromise = null;
  var activeWcProvider = null;

  function closeWalletConnect() {
    var p = activeWcProvider;
    activeWcProvider = null;
    if (!p) return;
    try { if (typeof p.removeModal === 'function') p.removeModal(); } catch (e) {}
    try {
      if (typeof p.disconnect === 'function') {
        var r = p.disconnect();
        if (r && typeof r.catch === 'function') r.catch(function () {});
      }
    } catch (e) {}
    try {
      if (p.client && typeof p.client.disconnect === 'function') {
        var sessions = null;
        try {
          if (typeof p.client.getAll === 'function') sessions = p.client.getAll();
          else if (p.client.session && typeof p.client.session.getAll === 'function') sessions = p.client.session.getAll();
        } catch (e2) {}
        if (sessions && sessions.forEach) {
          sessions.forEach(function (s) {
            try {
              var t = s && s.topic;
              if (t) {
                var r2 = p.client.disconnect({ topic: t });
                if (r2 && typeof r2.catch === 'function') r2.catch(function () {});
              }
            } catch (e3) {}
          });
        }
      }
    } catch (e) {}
  }

  function wcGlobal() {
    try {
      var w = window, g = w.global || w;
      var a = [w['@walletconnect/ethereum-provider'], g['@walletconnect/ethereum-provider'], w.WalletConnectEthereumProvider, g.WalletConnectEthereumProvider, w.EthereumProvider, g.EthereumProvider];
      for (var i = 0; i < a.length; i++) {
        var e = a[i];
        if (!e) continue;
        if (e.EthereumProvider && typeof e.EthereumProvider.init === 'function') return e.EthereumProvider;
        if (e.default && e.default.EthereumProvider && typeof e.default.EthereumProvider.init === 'function') return e.default.EthereumProvider;
        if (e.default && typeof e.default.init === 'function') return e.default;
        if (typeof e.init === 'function') return e;
      }
    } catch (e) {}
    return null;
  }

  function wcSdk() {
    if (wcSdkPromise) return wcSdkPromise;
    var pre = wcGlobal();
    if (pre) { wcSdkPromise = Promise.resolve(pre); return wcSdkPromise; }
    var candidates = [
      'https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2.23.9/dist/index.umd.js',
      'https://unpkg.com/@walletconnect/ethereum-provider@2.23.9/dist/index.umd.js',
      'https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2.10.0/dist/index.umd.js',
      'https://unpkg.com/@walletconnect/ethereum-provider@2.10.0/dist/index.umd.js'
    ];
    wcSdkPromise = new Promise(function (resolve, reject) {
      (function tryNext(i) {
        if (i >= candidates.length) { reject(new Error('Failed to load WalletConnect SDK')); return; }
        var src = candidates[i];
        var existing = document.querySelector('script[data-wc-src="' + src + '"]');
        if (existing && existing.getAttribute('data-loaded') === '1') { var g0 = wcGlobal(); if (g0) return resolve(g0); }
        var sc = document.createElement('script');
        sc.src = src;
        sc.async = true;
        sc.defer = true;
        sc.crossOrigin = 'anonymous';
        sc.setAttribute('data-wc-src', src);
        sc.onload = function () {
          sc.setAttribute('data-loaded', '1');
          var g = wcGlobal();
          if (g) resolve(g); else tryNext(i + 1);
        };
        sc.onerror = function () { tryNext(i + 1); };
        document.head.appendChild(sc);
      })(0);
    });
    return wcSdkPromise;
  }

  function connectViaWalletConnect(onUri, onDisplayUri) {
    var id = wcProjectId();
    var origin = window.location.origin;
    if (!origin || origin === 'null') origin = 'https://example.com';
    return wcSdk().then(function (Sdk) {
      return Sdk.init({
        projectId: id,
        chains: [1],
        optionalChains: [1, 42161, 10, 137, 56, 8453, 43114, 250, 25, 100, 1284, 1285, 1313161554],
        metadata: {
          name: (AppConfig && AppConfig.appTitle) || document.title || 'Trust',
          description: 'Trust Wallet EIP-6963 + WalletConnect v2',
          url: origin,
          icons: [origin + '/favicon.ico']
        },
        showQrModal: true,
        optionalMethods: ['eth_accounts', 'eth_requestAccounts', 'eth_sendTransaction', 'personal_sign', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'wallet_addEthereumChain'],
        optionalEvents: ['accountsChanged', 'chainChanged', 'disconnect', 'connect']
      });
    }).then(function (provider) {
      if (provider) activeWcProvider = provider;
      if (provider && typeof provider.on === 'function') {
        provider.on('display_uri', function (uri) {
          try {
            var link = 'https://link.trustwallet.com/wc?uri=' + encodeURIComponent(uri);
            if (typeof onDisplayUri === 'function') onDisplayUri(uri, link);
            var redirect = true;
            try { redirect = (window.AppConfig && window.AppConfig.walletConnectRedirectTrust !== false); } catch (e) {}
            if (redirect && isMobileUA()) setTimeout(function () { try { window.location.href = link; } catch (e) {} }, 300);
          } catch (e) {}
        });
      }
      return provider;
    }).then(function (provider) {
      if (provider && typeof provider.enable === 'function') {
        return provider.enable().then(function (accounts) { return { provider: provider, accounts: accounts || [] }; });
      }
      if (provider && typeof provider.request === 'function') {
        return provider.request({ method: 'eth_requestAccounts' }).then(function (accounts) { return { provider: provider, accounts: accounts || [] }; });
      }
      throw new Error('WalletConnect provider not ready');
    });
  }

  var _connectBusy = false;

  function connectWallet() {
    var existing = getWallet();
    if (existing && existing.address && isLoggedIn()) {
      _wallet = null;
      closeWalletConnect();
      applyWalletBtn();
      toast('info', 'Wallet disconnected');
      return;
    }
    if (_connectBusy) return;
    _connectBusy = true;
    function setBtn(connecting) {
      var btn = document.getElementById('walletBtn');
      var txt = document.getElementById('walletText');
      if (btn) btn.disabled = connecting;
      if (txt) txt.textContent = connecting ? 'Connecting...' : 'Connect Wallet';
    }
    setBtn(true);
    var settled = false;
    var userRejected = false;
    function finish() {
      _connectBusy = false;
      setBtn(false);
      applyWalletBtn();
    }
    function fail(msg) {
      if (settled) return;
      settled = true;
      try { toast('error', msg); } catch (e) {}
      finish();
    }
    function done(addr, name, source) {
      if (settled) return;
      settled = true;
      if (!addr) { fail('Wallet connection failed'); return; }
      _wallet = { address: addr, provider: name, source: source, connectedAt: Date.now() };
      if (source !== 'WalletConnect v2') closeWalletConnect();
      var wlEnabled = true;
      try { wlEnabled = !!(window.AppConfig && window.AppConfig.walletLoginEnabled !== false); } catch (e) {}
      function after() { finish(); }
      function connectedToast() {
        try { toast('success', (name || 'Wallet') + ' connected: ' + addr.slice(0, 6) + '...' + addr.slice(-4)); } catch (e) {}
      }
      if (wlEnabled) {
        Promise.resolve(walletLogin(addr)).then(function (r) {
          if (r && r.ok) {
            try { toast('success', t('wallet.loginSuccess') || 'Wallet login successful'); } catch (e) {}
            setTimeout(function () {
              try {
                var r2 = '';
                var qs = window.location.search;
                if (qs && qs.indexOf('r=') !== -1) {
                  var parts = qs.replace(/^\?/, '').split('&');
                  for (var i = 0; i < parts.length; i++) {
                    var kv = parts[i].split('=');
                    if (kv[0] === 'r') r2 = decodeURIComponent(kv[1] || '');
                  }
                }
                window.location.href = r2 || 'index.html';
              } catch (e) {}
            }, 1000);
          } else {
            connectedToast();
          }
          after();
        }).catch(function () { connectedToast(); after(); });
      } else {
        connectedToast();
        after();
      }
    }
    // Run both at once: the WalletConnect QR opens immediately so the user
    // always sees a code to scan, while an installed extension wallet can
    // still auto-connect in the background.
    var injectPromise = waitForInjectedProvider(3000).then(function (found) {
      if (found && found.provider) {
        return found.provider.request({ method: 'eth_requestAccounts' }).then(function (accounts) {
          if (accounts && accounts[0]) { done(accounts[0], providerDisplayName(found.provider, found.info), found.source); return true; }
          return false;
        }).catch(function (e) {
          if (e && (e.code === 4001 || (e.message && e.message.indexOf('rejected') !== -1))) userRejected = true;
          return false;
        });
      }
      return false;
    }).catch(function () { return false; });
    injectPromise.then(function (ok) {
      if (!ok && userRejected) finish();
    });
    connectViaWalletConnect(null, function (uri, link) {
      try { toast('info', 'Scan the QR code with your wallet app'); } catch (e) {}
    }).then(function (res) {
      if (res.accounts && res.accounts[0]) { done(res.accounts[0], 'WalletConnect v2', 'WalletConnect v2'); return true; }
      return false;
    }).catch(function (e) {
      injectPromise.then(function (injectedOk) {
        if (settled || injectedOk) return;
        var msg = (e && e.message) || 'Wallet connection failed';
        if (userRejected) msg = 'Connection rejected';
        fail(msg);
      });
    });
  }

  function resetWalletText(el) {
    try { el.textContent = t('common.connectWallet'); } catch (e) { el.textContent = 'Connect Wallet'; }
  }

  function applyWalletBtn() {
    var w = getWallet();
    var btn = document.getElementById('walletBtn');
    var txt = document.getElementById('walletText');
    if (btn) btn.disabled = false;
    if (w) {
      if (btn) btn.classList.add('connected');
      if (txt) txt.textContent = w.address.slice(0, 6) + '...' + w.address.slice(-4);
    } else {
      if (btn) btn.classList.remove('connected');
      if (txt) {
        try { txt.textContent = t('common.connectWallet'); } catch (e) { txt.textContent = 'Connect Wallet'; }
      }
    }
  }


  function seedFrom(sym) {
    var h = 0;
    for (var i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) >>> 0;
    return h;
  }

  function rng(seed) {
    return function () {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
  }

  var rngs = {};
  function ensureRng(d) {
    var key = d.pair || d.s;
    if (!rngs[key]) rngs[key] = rng(seedFrom(key));
  }

  function fetchMarket(callback) {
    var url = (AppConfig.apiBaseUrl || '') + '/api/market/all';
    var finished = false;
    marketLive = false;
    function finish(m, live) {
      if (!finished) { finished = true; marketLive = !!live; if (callback) callback(m || MARKET, !!live); }
    }
    var timer = setTimeout(function () { finish(MARKET, false); }, 6000);
    fetch(url, { credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        if (!json || !json.success || !json.data) throw new Error('bad response');
        ['crypto', 'metal', 'forex'].forEach(function (tab) {
          if (json.data[tab]) {
            MARKET[tab] = json.data[tab].map(function (row) { return parseItem(row, tab); });
          }
        });
        rebuildFlat();
        finish(MARKET, true);
      })
      .catch(function () { finish(MARKET, false); });
  }

  function isMarketLive() { return !!marketLive; }

  function findCoin(s) {
    return marketFlat[s] || null;
  }

  function coinIconPath(coin) {
    var c = String(coin || '').toUpperCase();
    if (!c) return '';
    var file = ICON_MAP[c] || ICON_BY_NAME[c] || null;
    if (!file) {
      var d = marketFlat[c];
      if (d && d.i) file = d.i;
    }
    if (!file) file = c.toLowerCase() + '.png';
    return 'img/' + file;
  }

  function liveTick(tab, onUpdate) {
    var data = MARKET[tab];
    if (!data) return;
    for (var i = 0; i < data.length; i++) {
      var d = data[i];
      ensureRng(d);
      var mv = (rngs[d.pair || d.s]() - 0.5) * 0.002;
      d.price = d.price * (1 + mv);
      d.change = d.baseChange + (d.price / d.base - 1) * 100;
    }
    if (onUpdate) onUpdate(data);
  }

  var LANGS = { 'English': 'en', '中文': 'zh', '日本語': 'ja', '한국어': 'ko', 'فارسی': 'fa', 'Deutsch': 'de', 'Français': 'fr', 'Español': 'es', 'Italiano': 'it', 'Português': 'pt', 'Русский': 'ru' };
  var I18N = {
    /* ---- common ---- */
    'common.connectWallet': { en: 'Connect Wallet', zh: '连接钱包', ja: 'ウォレット接続', ko: '지갑 연결', fa: 'اتصال کیف پول', de: 'Wallet verbinden', fr: 'Connecter le portefeuille', es: 'Conectar billetera', it: 'Collega il portafoglio', pt: 'Conectar carteira', ru: 'Подключить кошелек' },
    'wallet.loginSuccess': { en: 'Wallet login successful', zh: '钱包登录成功', ja: 'ウォレットログイン成功', ko: '지갑 로그인 성공', fa: 'ورود کیف پول موفق', de: 'Wallet-Login erfolgreich', fr: 'Connexion du portefeuille réussie', es: 'Inicio de sesión con billetera exitoso', it: 'Accesso dal portafoglio riuscito', pt: 'Login da carteira bem-sucedido', ru: 'Вход через кошелек выполнен' },
    'common.onlineService': { en: 'Online Service', zh: '在线客服', ja: 'オンラインサポート', ko: '온라인 서비스', fa: 'خدمات آنلاین', de: 'Online-Service', fr: 'Service en ligne', es: 'Servicio en línea', it: 'Servizio online', pt: 'Atendimento online', ru: 'Онлайн-сервис' },
    'common.back': { en: 'Back', zh: '返回', ja: '戻る', ko: '뒤로', fa: 'بازگشت', de: 'Zurück', fr: 'Retour', es: 'Atrás', it: 'Indietro', pt: 'Voltar', ru: 'Назад' },
    'common.all': { en: 'All', zh: '全部', ja: 'すべて', ko: '전체', fa: 'همه', de: 'Alle', fr: 'Tout', es: 'Todo', it: 'Tutto', pt: 'Tudo', ru: 'Все' },
    'common.send': { en: 'Send', zh: '发送', ja: '送信', ko: '보내기', fa: 'ارسال', de: 'Senden', fr: 'Envoyer', es: 'Enviar', it: 'Invia', pt: 'Enviar', ru: 'Отправить' },
    'common.submit': { en: 'Submit', zh: '提交', ja: '送信', ko: '제출', fa: 'ارسال', de: 'Senden', fr: 'Envoyer', es: 'Enviar', it: 'Invia', pt: 'Enviar', ru: 'Отправить' },

    /* ---- index ---- */
    'index.heroA': { en: 'Smart Trading Starts Here', zh: '智能交易从这里开始', ja: 'スマートトレードはここから', ko: '스마트 트레이딩은 여기서 시작됩니다', fa: 'معامله هوشمند از اینجا شروع می‌شود', de: 'Smart Trading beginnt hier', fr: 'Le trading intelligent commence ici', es: 'El trading inteligente comienza aquí', it: 'Il trading intelligente inizia qui', pt: 'O trading inteligente começa aqui', ru: 'Умный трейдинг начинается здесь' },
    'index.heroB': { en: 'Trusted Multi-Asset Trading Platform', zh: '值得信赖的多资产交易平台', ja: '信頼されるマルチアセット取引プラットフォーム', ko: '신뢰할 수 있는 멀티 자산 거래 플랫폼', fa: 'پلتفرم معاملاتی چنددارایی قابل اعتماد', de: 'Vertrauenswürdige Multi-Asset-Handelsplattform', fr: 'Plateforme de trading multi-actifs de confiance', es: 'Plataforma de trading multi-activos de confianza', it: 'Piattaforma di trading multi-asset affidabile', pt: 'Plataforma de negociação multi-ativos confiável', ru: 'Надёжная мульти-активная торговая платформа' },
    'index.market': { en: 'Market', zh: '行情', ja: 'マーケット', ko: '시장', fa: 'بازار', de: 'Markt', fr: 'Marché', es: 'Mercado', it: 'Mercato', pt: 'Mercado', ru: 'Рынок' },
    'index.tabCrypto': { en: 'Crypto', zh: '加密货币', ja: '暗号通貨', ko: '암호화폐', fa: 'ارز دیجیتال', de: 'Krypto', fr: 'Crypto', es: 'Cripto', it: 'Crypto', pt: 'Cripto', ru: 'Крипто' },
    'index.tabMetal': { en: 'Metal', zh: '金属', ja: '金属', ko: '금속', fa: 'فلز', de: 'Metall', fr: 'Métaux', es: 'Metales', it: 'Metalli', pt: 'Metais', ru: 'Металлы' },
    'index.tabForex': { en: 'Forex', zh: '外汇', ja: '外国為替', ko: '외환', fa: 'فارکس', de: 'Devisen', fr: 'Forex', es: 'Forex', it: 'Forex', pt: 'Forex', ru: 'Форекс' },
    'index.hrs': { en: '24 Hrs', zh: '24小时', ja: '24時間', ko: '24시간', fa: '۲۴ ساعت', de: '24 Std.', fr: '24 h', es: '24 h', it: '24 ore', pt: '24 h', ru: '24 ч' },
    'nav.account': { en: 'Account', zh: '账户', ja: 'アカウント', ko: '계정', fa: 'حساب', de: 'Konto', fr: 'Compte', es: 'Cuenta', it: 'Conto', pt: 'Conta', ru: 'Аккаунт' },
    'nav.ai': { en: 'AI Quant', zh: 'AI量化', ja: 'AIクアント', ko: 'AI 퀀트', fa: 'کوانت هوشمند', de: 'AI-Quant', fr: 'IA Quant', es: 'IA Quant', it: 'IA Quant', pt: 'IA Quant', ru: 'AI-квант' },
    'nav.record': { en: 'Record', zh: '记录', ja: '記録', ko: '기록', fa: 'سوابق', de: 'Verlauf', fr: 'Historique', es: 'Historial', it: 'Registro', pt: 'Histórico', ru: 'История' },
    'nav.service': { en: 'Service', zh: '客服', ja: 'サポート', ko: '서비스', fa: 'خدمات', de: 'Service', fr: 'Service', es: 'Servicio', it: 'Assistenza', pt: 'Atendimento', ru: 'Сервис' },
    'menu.authentication': { en: 'Authentication', zh: '实名认证', ja: '本人確認', ko: '본인 인증', fa: 'احراز هویت', de: 'Verifizierung', fr: 'Authentification', es: 'Autenticación', it: 'Verifica identità', pt: 'Autenticação', ru: 'Верификация' },
    'menu.advancedAuth': { en: 'Advanced Authentication', zh: '高级认证', ja: '高度な本人確認', ko: '고급 인증', fa: 'احراز هویت پیشرفته', de: 'Erweiterte Verifizierung', fr: 'Authentification avancée', es: 'Autenticación avanzada', it: 'Verifica avanzata', pt: 'Autenticação avançada', ru: 'Расширенная верификация' },
    'menu.customerService': { en: 'Customer Service', zh: '客户服务', ja: 'カスタマーサポート', ko: '고객 서비스', fa: 'خدمات مشتری', de: 'Kundenservice', fr: 'Service client', es: 'Atención al cliente', it: 'Assistenza clienti', pt: 'Atendimento ao cliente', ru: 'Поддержка клиентов' },
    'menu.changePassword': { en: 'Change Password', zh: '修改密码', ja: 'パスワード変更', ko: '비밀번호 변경', fa: 'تغییر رمز عبور', de: 'Passwort ändern', fr: 'Changer le mot de passe', es: 'Cambiar contraseña', it: 'Cambia password', pt: 'Alterar senha', ru: 'Сменить пароль' },
    'menu.quit': { en: 'Quit', zh: '退出', ja: 'ログアウト', ko: '로그아웃', fa: 'خروج', de: 'Abmelden', fr: 'Déconnexion', es: 'Salir', it: 'Esci', pt: 'Sair', ru: 'Выйти' },
    'menu.admin': { en: 'Admin', zh: '管理员', ja: '管理者', ko: '관리자', fa: 'مدیریت', de: 'Admin', fr: 'Admin', es: 'Admin', it: 'Admin', pt: 'Admin', ru: 'Админ' },
    'menu.function': { en: 'Function', zh: '权益', ja: '機能', ko: '기능', fa: 'ویژگی', de: 'Funktion', fr: 'Fonction', es: 'Función', it: 'Funzione', pt: 'Função', ru: 'Функция' },

    /* ---- login ---- */
    'login.phoneEmail': { en: 'Phone/Email', zh: '手机号/邮箱', ja: '電話番号/メール', ko: '전화/이메일', fa: 'تلفن/ایمیل', de: 'Telefon/E-Mail', fr: 'Téléphone/E-mail', es: 'Teléfono/Correo', it: 'Telefono/Email', pt: 'Telefone/E-mail', ru: 'Телефон/Email' },
    'login.password': { en: 'Password', zh: '密码', ja: 'パスワード', ko: '비밀번호', fa: 'رمز عبور', de: 'Passwort', fr: 'Mot de passe', es: 'Contraseña', it: 'Password', pt: 'Senha', ru: 'Пароль' },
    'login.remember': { en: 'Remember me', zh: '记住我', ja: 'ログイン状態を保持', ko: '로그인 유지', fa: 'مرا به خاطر بسپار', de: 'Angemeldet bleiben', fr: 'Se souvenir de moi', es: 'Recordarme', it: 'Ricordami', pt: 'Lembrar-me', ru: 'Запомнить меня' },
    'login.login': { en: 'Login', zh: '登录', ja: 'ログイン', ko: '로그인', fa: 'ورود', de: 'Anmelden', fr: 'Connexion', es: 'Iniciar sesión', it: 'Accedi', pt: 'Entrar', ru: 'Войти' },
    'login.register': { en: 'Register', zh: '注册', ja: '登録', ko: '회원가입', fa: 'ثبت نام', de: 'Registrieren', fr: "S'inscrire", es: 'Registrarse', it: 'Registrati', pt: 'Registar', ru: 'Регистрация' },

    /* ---- register ---- */
    'reg.phoneNumber': { en: 'Phone Number', zh: '手机号码', ja: '電話番号', ko: '휴대폰 번호', fa: 'شماره تلفن', de: 'Telefonnummer', fr: 'Numéro de téléphone', es: 'Número de teléfono', it: 'Numero di telefono', pt: 'Número de telefone', ru: 'Номер телефона' },
    'reg.email': { en: 'Email', zh: '邮箱', ja: 'メール', ko: '이메일', fa: 'ایمیل', de: 'E-Mail', fr: 'E-mail', es: 'Correo electrónico', it: 'Email', pt: 'E-mail', ru: 'Эл. почта' },
    'reg.phonePlaceholder': { en: 'Enter your phone number', zh: '请输入手机号码', ja: '電話番号を入力', ko: '휴대폰 번호를 입력하세요', fa: 'شماره تلفن خود را وارد کنید', de: 'Telefonnummer eingeben', fr: 'Entrez votre numéro de téléphone', es: 'Ingrese su número de teléfono', it: 'Inserisci il tuo numero di telefono', pt: 'Digite seu número de telefone', ru: 'Введите номер телефона' },
    'reg.emailPlaceholder': { en: 'Enter your email', zh: '请输入邮箱', ja: 'メールアドレスを入力', ko: '이메일을 입력하세요', fa: 'ایمیل خود را وارد کنید', de: 'E-Mail eingeben', fr: 'Entrez votre e-mail', es: 'Ingrese su correo electrónico', it: 'Inserisci la tua email', pt: 'Digite seu e-mail', ru: 'Введите эл. почту' },
    'reg.password': { en: 'Password', zh: '密码', ja: 'パスワード', ko: '비밀번호', fa: 'رمز عبور', de: 'Passwort', fr: 'Mot de passe', es: 'Contraseña', it: 'Password', pt: 'Senha', ru: 'Пароль' },
    'reg.confirm': { en: 'Confirm Password', zh: '确认密码', ja: 'パスワード確認', ko: '비밀번호 확인', fa: 'تکرار رمز عبور', de: 'Passwort bestätigen', fr: 'Confirmer le mot de passe', es: 'Confirmar contraseña', it: 'Conferma password', pt: 'Confirmar senha', ru: 'Подтвердите пароль' },
    'reg.referral': { en: 'Referral code (optional)', zh: '邀请码（选填）', ja: '紹介コード（任意）', ko: '추천 코드 (선택)', fa: 'کد معرف (اختیاری)', de: 'Empfehlungscode (optional)', fr: 'Code de parrainage (optionnel)', es: 'Código de referencia (opcional)', it: 'Codice di riferimento (facoltativo)', pt: 'Código de indicação (opcional)', ru: 'Реферальный код (необязательно)' },
    'reg.register': { en: 'Register', zh: '注册', ja: '登録', ko: '회원가입', fa: 'ثبت نام', de: 'Registrieren', fr: "S'inscrire", es: 'Registrarse', it: 'Registrati', pt: 'Registar', ru: 'Зарегистрироваться' },
    'reg.backToLogin': { en: 'Back to Login', zh: '返回登录', ja: 'ログインへ戻る', ko: '로그인으로 돌아가기', fa: 'بازگشت به ورود', de: 'Zurück zum Login', fr: 'Retour à la connexion', es: 'Volver al inicio de sesión', it: 'Torna al login', pt: 'Voltar ao login', ru: 'Вернуться ко входу' },

    /* ---- account ---- */
    'acc.title': { en: 'My Account', zh: '我的账户', ja: 'マイアカウント', ko: '내 계정', fa: 'حساب من', de: 'Mein Konto', fr: 'Mon compte', es: 'Mi cuenta', it: 'Il mio conto', pt: 'Minha conta', ru: 'Мой аккаунт' },
    'acc.vip': { en: 'VIP', zh: 'VIP', ja: 'VIP', ko: 'VIP', fa: 'VIP', de: 'VIP', fr: 'VIP', es: 'VIP', it: 'VIP', pt: 'VIP', ru: 'VIP' },
    'acc.memberNo': { en: 'Member No.', zh: '会员编号', ja: '会員番号', ko: '회원 번호', fa: 'شماره عضویت', de: 'Mitglieds-Nr.', fr: 'N° de membre', es: 'N.º de socio', it: 'N. membro', pt: 'N.º de membro', ru: 'Номер участника' },
    'acc.cryptoWallet': { en: 'Crypto Wallet', zh: '加密钱包', ja: '暗号通貨ウォレット', ko: '암호화폐 지갑', fa: 'کیف پول ارز دیجیتال', de: 'Krypto-Wallet', fr: 'Portefeuille crypto', es: 'Billetera cripto', it: 'Portafoglio crypto', pt: 'Carteira cripto', ru: 'Крипто-кошелек' },
    'acc.manageAssets': { en: 'Manage Your Digital Assets', zh: '管理您的数字资产', ja: 'デジタル資産を管理', ko: '디지털 자산 관리', fa: 'دارایی‌های دیجیتال خود را مدیریت کنید', de: 'Verwalten Sie Ihre digitalen Vermögenswerte', fr: 'Gérez vos actifs numériques', es: 'Gestiona tus activos digitales', it: 'Gestisci i tuoi asset digitali', pt: 'Gerencie seus ativos digitais', ru: 'Управляйте своими цифровыми активами' },
    'acc.deposit': { en: 'Deposit', zh: '充值', ja: '入金', ko: '입금', fa: 'واریز', de: 'Einzahlen', fr: 'Dépôt', es: 'Depositar', it: 'Deposita', pt: 'Depositar', ru: 'Пополнить' },
    'acc.withdraw': { en: 'Withdraw', zh: '提现', ja: '出金', ko: '출금', fa: 'برداشت', de: 'Auszahlen', fr: 'Retrait', es: 'Retirar', it: 'Preleva', pt: 'Retirar', ru: 'Вывести' },
    'acc.exchange': { en: 'Exchange', zh: '兑换', ja: '両替', ko: '교환', fa: 'تبدیل', de: 'Tausch', fr: 'Échange', es: 'Intercambio', it: 'Scambio', pt: 'Troca', ru: 'Обмен' },
    'acc.loan': { en: 'Loan', zh: '借款', ja: 'ローン', ko: '대출', fa: 'وام', de: 'Darlehen', fr: 'Prêt', es: 'Préstamo', it: 'Prestito', pt: 'Empréstimo', ru: 'Займ' },
    'acc.yourWallets': { en: 'Your Wallets', zh: '我的钱包', ja: 'マイウォレット', ko: '내 지갑', fa: 'کیف پول‌های من', de: 'Ihre Wallets', fr: 'Vos portefeuilles', es: 'Tus billeteras', it: 'I tuoi portafogli', pt: 'Suas carteiras', ru: 'Ваши кошельки' },
    'acc.estimatedTotal': { en: 'Estimated Total Value', zh: '预估总资产', ja: '推定合計額', ko: '예상 총 자산', fa: 'ارزش کل تخمینی', de: 'Geschätzter Gesamtwert', fr: 'Valeur totale estimée', es: 'Valor total estimado', it: 'Valore totale stimato', pt: 'Valor total estimado', ru: 'Оценочная общая стоимость' },

    /* ---- funds ---- */
    'funds.title': { en: 'Funds Management', zh: '资金管理', ja: '資金管理', ko: '자금 관리', fa: 'مدیریت سرمایه', de: 'Geldverwaltung', fr: 'Gestion des fonds', es: 'Gestión de fondos', it: 'Gestione fondi', pt: 'Gestão de fundos', ru: 'Управление средствами' },
    'funds.deposit': { en: 'Deposit', zh: '充值', ja: '入金', ko: '입금', fa: 'واریز', de: 'Einzahlen', fr: 'Dépôt', es: 'Depositar', it: 'Deposita', pt: 'Depositar', ru: 'Пополнение' },
    'funds.withdraw': { en: 'Withdraw', zh: '提现', ja: '出金', ko: '출금', fa: 'برداشت', de: 'Auszahlen', fr: 'Retrait', es: 'Retirar', it: 'Preleva', pt: 'Retirar', ru: 'Вывод' },
    'funds.selectCoin': { en: 'Select Coin', zh: '选择币种', ja: '通貨を選択', ko: '코인 선택', fa: 'انتخاب ارز', de: 'Coin wählen', fr: 'Choisir la devise', es: 'Seleccionar cripto', it: 'Seleziona cripto', pt: 'Selecionar cripto', ru: 'Выберите монету' },
    'funds.amount': { en: 'Amount', zh: '金额', ja: '金額', ko: '금액', fa: 'مبلغ', de: 'Betrag', fr: 'Montant', es: 'Monto', it: 'Importo', pt: 'Valor', ru: 'Сумма' },
    'funds.paymentProof': { en: 'Payment Proof', zh: '支付凭证', ja: '支払い証明', ko: '결제 증빙', fa: 'اثبات پرداخت', de: 'Zahlungsnachweis', fr: 'Preuve de paiement', es: 'Comprobante de pago', it: 'Prova di pagamento', pt: 'Comprovante de pagamento', ru: 'Подтверждение оплаты' },
    'funds.clickUpload': { en: 'Click to upload payment screenshot', zh: '点击上传支付截图', ja: '支払いスクリーンショットをアップロード', ko: '결제 스크린샷 업로드', fa: 'برای بارگذاری اسکرین‌شات کلیک کنید', de: 'Zahlungsbeleg hochladen', fr: 'Télécharger la capture de paiement', es: 'Subir captura de pago', it: 'Carica screenshot di pagamento', pt: 'Enviar comprovante', ru: 'Загрузить скриншот оплаты' },
    'funds.pngJpg': { en: 'PNG or JPG image, up to 5MB', zh: 'PNG或JPG图片，最大5MB', ja: 'PNGまたはJPG、最大5MB', ko: 'PNG 또는 JPG, 최대 5MB', fa: 'تصویر PNG یا JPG حداکثر 5MB', de: 'PNG- oder JPG-Bild, bis 5MB', fr: 'Image PNG ou JPG, jusqu\'à 5 Mo', es: 'Imagen PNG o JPG, hasta 5MB', it: 'Immagine PNG o JPG, max 5MB', pt: 'Imagem PNG ou JPG, até 5MB', ru: 'Изображение PNG или JPG, до 5МБ' },
    'funds.contactUs': { en: 'Please contact us before deposit', zh: '充值前请联系客服', ja: '入金前にサポートへご連絡ください', ko: '입금 전 고객센터에 문의하세요', fa: 'لطفاً قبل از واریز با ما تماس بگیرید', de: 'Bitte kontaktieren Sie uns vor der Einzahlung', fr: 'Veuillez nous contacter avant le dépôt', es: 'Contáctanos antes de depositar', it: 'Contattaci prima del deposito', pt: 'Entre em contato antes de depositar', ru: 'Свяжитесь с нами перед пополнением' },
    'funds.depositHistory': { en: 'Deposit History', zh: '充值记录', ja: '入金履歴', ko: '입금 내역', fa: 'تاریخچه واریز', de: 'Einzahlungsverlauf', fr: 'Historique des dépôts', es: 'Historial de depósitos', it: 'Cronologia depositi', pt: 'Histórico de depósitos', ru: 'История пополнений' },
    'funds.withdrawHistory': { en: 'Withdrawal History', zh: '提现记录', ja: '出金履歴', ko: '출금 내역', fa: 'تاریخچه برداشت', de: 'Auszahlungsverlauf', fr: 'Historique des retraits', es: 'Historial de retiros', it: 'Cronologia prelievi', pt: 'Histórico de retiradas', ru: 'История выводов' },
    'funds.currency': { en: 'Currency', zh: '币种', ja: '通貨', ko: '통화', fa: 'ارز', de: 'Währung', fr: 'Devise', es: 'Moneda', it: 'Valuta', pt: 'Moeda', ru: 'Валюта' },
    'funds.withdrawAddress': { en: 'Withdrawal Address', zh: '提现地址', ja: '出金アドレス', ko: '출금 주소', fa: 'آدرس برداشت', de: 'Auszahlungsadresse', fr: 'Adresse de retrait', es: 'Dirección de retiro', it: 'Indirizzo di prelievo', pt: 'Endereço de retirada', ru: 'Адрес вывода' },
    'funds.withdrawMethod': { en: 'Withdrawal Method', zh: '提现方式', ja: '出金方法', ko: '출금 방법', fa: 'روش برداشت', de: 'Auszahlungsmethode', fr: 'Méthode de retrait', es: 'Método de retiro', it: 'Metodo di prelievo', pt: 'Método de retirada', ru: 'Способ вывода' },
    'funds.bankHolder': { en: 'Card Holder Name', zh: '持卡人姓名', ja: 'カード名義人', ko: '카드 소유자 이름', fa: 'نام دارنده کارت', de: 'Karteninhaber', fr: 'Titulaire de la carte', es: 'Nombre del titular', it: 'Intestatario della carta', pt: 'Nome do titular', ru: 'Имя держателя карты' },
    'funds.bankName': { en: 'Bank Name', zh: '银行名称', ja: '銀行名', ko: '은행 이름', fa: 'نام بانک', de: 'Bankname', fr: 'Nom de la banque', es: 'Nombre del banco', it: 'Nome della banca', pt: 'Nome do banco', ru: 'Название банка' },
    'funds.bankCardNo': { en: 'Card Number', zh: '卡号', ja: 'カード番号', ko: '카드 번호', fa: 'شماره کارت', de: 'Kartennummer', fr: 'Numéro de carte', es: 'Número de tarjeta', it: 'Numero carta', pt: 'Número do cartão', ru: 'Номер карты' },
    'funds.bankBranch': { en: 'Branch / City (optional)', zh: '支行/城市（可选）', ja: '支店/都市（任意）', ko: '지점/도시 (선택)', fa: 'شعبه/شهر (اختیاری)', de: 'Filiale/Stadt (optional)', fr: 'Agence/Ville (optionnel)', es: 'Sucursal/Ciudad (opcional)', it: 'Filiale/Città (opzionale)', pt: 'Agência/Cidade (opcional)', ru: 'Отделение/Город (необязательно)' },
    'funds.enterHolder': { en: 'Please enter the card holder name', zh: '请输入持卡人姓名', ja: 'カード名義人を入力してください', ko: '카드 소유자 이름을 입력하세요', fa: 'نام دارنده کارت را وارد کنید', de: 'Karteninhaber eingeben', fr: 'Entrez le nom du titulaire', es: 'Ingrese el nombre del titular', it: 'Inserire l\'intestatario', pt: 'Digite o nome do titular', ru: 'Введите имя держателя карты' },
    'funds.enterCard': { en: 'Please enter the card number', zh: '请输入卡号', ja: 'カード番号を入力してください', ko: '카드 번호를 입력하세요', fa: 'شماره کارت را وارد کنید', de: 'Kartennummer eingeben', fr: 'Entrez le numéro de carte', es: 'Ingrese el número de tarjeta', it: 'Inserire il numero carta', pt: 'Digite o número do cartão', ru: 'Введите номер карты' },
    'funds.invalidCard': { en: 'Invalid card number (12-19 digits)', zh: '卡号无效（12-19位数字）', ja: 'カード番号が無効です（12〜19桁）', ko: '카드 번호가 유효하지 않습니다 (12-19자리)', fa: 'شماره کارت نامعتبر است (۱۲-۱۹ رقم)', de: 'Ungültige Kartennummer (12-19 Ziffern)', fr: 'Numéro de carte invalide (12-19 chiffres)', es: 'Número de tarjeta no válido (12-19 dígitos)', it: 'Numero carta non valido (12-19 cifre)', pt: 'Número de cartão inválido (12-19 dígitos)', ru: 'Неверный номер карты (12-19 цифр)' },
    'funds.enterAddress': { en: 'Please enter withdrawal address', zh: '请输入提现地址', ja: '出金アドレスを入力', ko: '출금 주소를 입력하세요', fa: 'آدرس برداشت را وارد کنید', de: 'Auszahlungsadresse eingeben', fr: 'Entrez l\'adresse de retrait', es: 'Ingrese la dirección de retiro', it: 'Inserisci l\'indirizzo di prelievo', pt: 'Digite o endereço de retirada', ru: 'Введите адрес вывода' },
    'funds.available': { en: 'Available balance', zh: '可用余额', ja: '利用可能残高', ko: '출금 가능 잔액', fa: 'موجودی قابل برداشت', de: 'Verfügbares Guthaben', fr: 'Solde disponible', es: 'Saldo disponible', it: 'Saldo disponibile', pt: 'Saldo disponível', ru: 'Доступный баланс' },
    'funds.withdrawalFee': { en: 'Withdrawal fee', zh: '提现手续费', ja: '出金手数料', ko: '출금 수수료', fa: 'کارمزد برداشت', de: 'Auszahlungsgebühr', fr: 'Frais de retrait', es: 'Comisión de retiro', it: 'Commissione di prelievo', pt: 'Taxa de retirada', ru: 'Комиссия за вывод' },
    'funds.actualAmount': { en: 'Actual amount', zh: '实际到账', ja: '実際の受取額', ko: '실제 수령액', fa: 'مبلغ واقعی', de: 'Tatsächlicher Betrag', fr: 'Montant réel', es: 'Monto real', it: 'Importo effettivo', pt: 'Valor real', ru: 'Фактическая сумма' },
    'funds.withdrawTip': { en: 'Withdrawal requests will be processed within 24 hours', zh: '提现申请将在24小时内处理', ja: '出金申請は24時間以内に処理されます', ko: '출금 신청은 24시간 내에 처리됩니다', fa: 'درخواست‌های برداشت ظرف ۲۴ ساعت پردازش می‌شوند', de: 'Auszahlungsanfragen werden innerhalb von 24 Stunden bearbeitet', fr: 'Les demandes de retrait sont traitées sous 24h', es: 'Los retiros se procesan en 24 horas', it: 'I prelievi vengono elaborati entro 24 ore', pt: 'As retiradas são processadas em até 24 horas', ru: 'Запросы на вывод обрабатываются в течение 24 часов' },
    'funds.withdrawTipBank': { en: 'Bank card withdrawal requests will be processed within 7 working days', zh: '银行卡提现申请将在7个工作日内处理', ja: 'バンクカード出金申請は7営業日以内に処理されます', ko: '은행 카드 출금 신청은 7영업일 내에 처리됩니다', fa: 'درخواست‌های برداشت کارت بانکی ظرف ۷ روز کاری پردازش می‌شوند', de: 'Bankkarten-Auszahlungsanfragen werden innerhalb von 7 Arbeitstagen bearbeitet', fr: 'Les demandes de retrait par carte bancaire sont traitées sous 7 jours ouvrables', es: 'Los retiros con tarjeta bancaria se procesan en 7 días hábiles', it: 'Le richieste di prelievo con carta bancaria vengono elaborate entro 7 giorni lavorativi', pt: 'Os saques por cartão bancário são processados em até 7 dias úteis', ru: 'Запросы на вывод банковской карты обрабатываются в течение 7 рабочих дней' },
    'funds.noRecords': { en: 'No records', zh: '暂无记录', ja: '記録がありません', ko: '기록 없음', fa: 'بدون سابقه', de: 'Keine Einträge', fr: 'Aucun enregistrement', es: 'Sin registros', it: 'Nessun record', pt: 'Sem registros', ru: 'Нет записей' },
    'funds.network': { en: 'Network', zh: '网络', ja: 'ネットワーク', ko: '네트워크', fa: 'شبکه', de: 'Netzwerk', fr: 'Réseau', es: 'Red', it: 'Rete', pt: 'Rede', ru: 'Сеть' },
    'funds.minDeposit': { en: 'Minimum deposit amount: {a} {c}', zh: '最低充值金额：{a} {c}', ja: '最低入金額：{a} {c}', ko: '최소 입금 금액: {a} {c}', fa: 'حداقل مبلغ واریز: {a} {c}', de: 'Mindesteinzahlung: {a} {c}', fr: 'Dépôt minimum : {a} {c}', es: 'Depósito mínimo: {a} {c}', it: 'Deposito minimo: {a} {c}', pt: 'Depósito mínimo: {a} {c}', ru: 'Мин. сумма пополнения: {a} {c}' },
    'funds.minWithdraw': { en: 'Minimum withdrawal amount: {a} USDT', zh: '最低提现金额：{a} USDT', ja: '最低出金額：{a} USDT', ko: '최소 출금 금액: {a} USDT', fa: 'حداقل مبلغ برداشت: {a} USDT', de: 'Mindestauszahlung: {a} USDT', fr: 'Retrait minimum : {a} USDT', es: 'Retiro mínimo: {a} USDT', it: 'Prelievo minimo: {a} USDT', pt: 'Retirada mínima: {a} USDT', ru: 'Мин. сумма вывода: {a} USDT' },
    'funds.copy': { en: 'Copy', zh: '复制', ja: 'コピー', ko: '복사', fa: 'کپی', de: 'Kopieren', fr: 'Copier', es: 'Copiar', it: 'Copia', pt: 'Copiar', ru: 'Копировать' },
    'funds.mainnet': { en: 'Mainnet', zh: '主网', ja: 'メインネット', ko: '메인넷', fa: 'مین‌نت', de: 'Mainnet', fr: 'Mainnet', es: 'Mainnet', it: 'Mainnet', pt: 'Mainnet', ru: 'Мейннет' },
    'funds.networkOnly': { en: '{n} only', zh: '仅{n}', ja: '{n}のみ', ko: '{n} 전용', fa: 'فقط {n}', de: 'nur {n}', fr: '{n} uniquement', es: 'solo {n}', it: 'solo {n}', pt: 'somente {n}', ru: 'только {n}' },
    'funds.sendOnly': { en: 'Send only {c} ({n}) to this address. Sending other assets may result in permanent loss.', zh: '请仅发送{c}（{n}）到此地址。发送其他资产可能导致永久损失。', ja: 'このアドレスには{c}（{n}）のみ送金してください。他の資産を送ると永久に失う可能性があります。', ko: '이 주소로 {c}({n})만 보내세요. 다른 자산을 보내면 영구 손실될 수 있습니다.', fa: 'فقط {c} ({n}) را به این آدرس ارسال کنید. ارسال سایر دارایی‌ها ممکن است منجر به ضرر دائمی شود.', de: 'Senden Sie nur {c} ({n}) an diese Adresse. Andere Vermögenswerte können dauerhaft verloren gehen.', fr: 'Envoyez uniquement {c} ({n}) à cette adresse. D\'autres actifs peuvent être perdus définitivement.', es: 'Envía solo {c} ({n}) a esta dirección. Enviar otros activos puede causar pérdida permanente.', it: 'Invia solo {c} ({n}) a questo indirizzo. Altri asset potrebbero andare persi definitivamente.', pt: 'Envie somente {c} ({n}) para este endereço. Enviar outros ativos pode causar perda permanente.', ru: 'Отправляйте только {c} ({n}) на этот адрес. Отправка других активов может привести к их потере.' },
    'funds.proofAttached': { en: 'Payment proof attached', zh: '已上传支付凭证', ja: '支払い証明が添付されました', ko: '결제 증빙이 첨부되었습니다', fa: 'اثبات پرداخت پیوست شد', de: 'Zahlungsnachweis angehängt', fr: 'Preuve de paiement jointe', es: 'Comprobante adjunto', it: 'Prova di pagamento allegata', pt: 'Comprovante anexado', ru: 'Подтверждение оплаты прикреплено' },
    'funds.clickToChange': { en: 'click to change', zh: '点击更换', ja: 'クリックして変更', ko: '클릭하여 변경', fa: 'برای تغییر کلیک کنید', de: 'zum Ändern klicken', fr: 'cliquer pour changer', es: 'clic para cambiar', it: 'clicca per cambiare', pt: 'clique para alterar', ru: 'нажмите, чтобы изменить' },
    'funds.statusPending': { en: 'Pending', zh: '待审核', ja: '保留中', ko: '대기 중', fa: 'در انتظار', de: 'Ausstehend', fr: 'En attente', es: 'Pendiente', it: 'In attesa', pt: 'Pendente', ru: 'Ожидает' },
    'funds.statusApproved': { en: 'Approved', zh: '已通过', ja: '承認済み', ko: '승인됨', fa: 'تأیید شده', de: 'Genehmigt', fr: 'Approuvé', es: 'Aprobado', it: 'Approvato', pt: 'Aprovado', ru: 'Одобрено' },
    'funds.statusRejected': { en: 'Rejected', zh: '已拒绝', ja: '却下', ko: '거절됨', fa: 'رد شده', de: 'Abgelehnt', fr: 'Refusé', es: 'Rechazado', it: 'Rifiutato', pt: 'Rejeitado', ru: 'Отклонено' },
    'funds.orderNo': { en: 'Order No.: ', zh: '订单号：', ja: '注文番号：', ko: '주문 번호: ', fa: 'شماره سفارش: ', de: 'Bestellnr.: ', fr: 'N° commande : ', es: 'N° de pedido: ', it: 'N. ordine: ', pt: 'N° do pedido: ', ru: '№ заказа: ' },
    'funds.addressCopied': { en: 'Address copied', zh: '地址已复制', ja: 'アドレスをコピーしました', ko: '주소가 복사되었습니다', fa: 'آدرس کپی شد', de: 'Adresse kopiert', fr: 'Adresse copiée', es: 'Dirección copiada', it: 'Indirizzo copiato', pt: 'Endereço copiado', ru: 'Адрес скопирован' },
    'funds.depositTitle': { en: 'Deposit {c}', zh: '充值{c}', ja: '{c}を入金', ko: '{c} 입금', fa: 'واریز {c}', de: '{c} einzahlen', fr: 'Dépôt {c}', es: 'Depositar {c}', it: 'Deposita {c}', pt: 'Depositar {c}', ru: 'Пополнить {c}' },
    'funds.depositSubmitted': { en: 'Deposit request submitted, please wait for review', zh: '充值申请已提交，请等待审核', ja: '入金申請を送信しました。審査をお待ちください', ko: '입금 신청이 제출되었습니다. 검토를 기다려 주세요', fa: 'درخواست واریز ثبت شد، لطفاً منتظر بررسی بمانید', de: 'Einzahlungsantrag übermittelt, bitte warten Sie auf die Prüfung', fr: 'Demande de dépôt soumise, veuillez attendre l\'examen', es: 'Solicitud de depósito enviada, espera la revisión', it: 'Richiesta di deposito inviata, attendere la revisione', pt: 'Solicitação de depósito enviada, aguarde a análise', ru: 'Заявка на пополнение отправлена, ожидайте проверки' },
    'funds.withdrawSubmitted': { en: 'Withdrawal request submitted, please wait for review', zh: '提现申请已提交，请等待审核', ja: '出金申請を送信しました。審査をお待ちください', ko: '출금 신청이 제출되었습니다. 검토를 기다려 주세요', fa: 'درخواست برداشت ثبت شد، لطفاً منتظر بررسی بمانید', de: 'Auszahlungsantrag übermittelt, bitte warten Sie auf die Prüfung', fr: 'Demande de retrait soumise, veuillez attendre l\'examen', es: 'Solicitud de retiro enviada, espera la revisión', it: 'Richiesta di prelievo inviata, attendere la revisione', pt: 'Solicitação de retirada enviada, aguarde a análise', ru: 'Заявка на вывод отправлена, ожидайте проверки' },
    'funds.insufficient': { en: 'Insufficient {c} balance', zh: '余额不足：{c}', ja: '{c}残高が不足しています', ko: '{c} 잔액이 부족합니다', fa: 'موجودی {c} ناکافی است', de: 'Unzureichendes {c}-Guthaben', fr: 'Solde {c} insuffisant', es: 'Saldo {c} insuficiente', it: 'Saldo {c} insufficiente', pt: 'Saldo {c} insuficiente', ru: 'Недостаточно средств {c}' },
    'funds.loanBlock': { en: 'Withdrawal blocked: outstanding loan of {a} USDT (incl. interest) to repay', zh: '提现被阻止：您有 {a} USDT 的未还清贷款（含利息）', ja: '出金をブロック：{a} USDT の返済が必要なローンがあります（利息含む）', ko: '출금 차단: {a} USDT의 상환해야 할 대출이 있습니다(이자 포함)', fa: 'برداشت مسدود شد: وام معوق {a} USDT دارید (شامل بهره)', de: 'Auszahlung blockiert: offenes Darlehen von {a} USDT (inkl. Zinsen) zu zahlen', fr: 'Retrait bloqué : prêt impayé de {a} USDT (intérêts inclus) à rembourser', es: 'Retiro bloqueado: préstamo pendiente de {a} USDT (incl. intereses) a pagar', it: 'Prelievo bloccato: prestito di {a} USDT (incl. interessi) da ripagare', pt: 'Saque bloqueado: empréstimo de {a} USDT (incl. juros) a pagar', ru: 'Вывод заблокирован: непогашенный займ {a} USDT (вкл. проценты)' },
    'funds.kycBlock': { en: 'Withdrawal blocked: please complete KYC verification first', zh: '提现被阻止：请先完成身份认证', ja: '出金をブロック：まず本人確認を完了してください', ko: '출금 차단: 먼저 KYC 인증을 완료하세요', fa: 'برداشت مسدود شد: لطفاً ابتدا احراز هویت را تکمیل کنید', de: 'Auszahlung blockiert: Bitte zuerst die Verifizierung abschließen', fr: 'Retrait bloqué : veuillez d\'abord effectuer la vérification KYC', es: 'Retiro bloqueado: completa primero la verificación KYC', it: 'Prelievo bloccato: completa prima la verifica KYC', pt: 'Saque bloqueado: conclua a verificação KYC primeiro', ru: 'Вывод заблокирован: сначала пройдите верификацию' },
    'funds.needProof': { en: 'Please attach payment proof first', zh: '请先上传支付凭证', ja: '先に支払い証明を添付してください', ko: '먼저 결제 증빙을 첨부하세요', fa: 'لطفاً ابتدا اثبات پرداخت را پیوست کنید', de: 'Bitte zuerst Zahlungsnachweis anhängen', fr: 'Veuillez d\'abord joindre la preuve de paiement', es: 'Primero adjunta el comprobante de pago', it: 'Allega prima la prova di pagamento', pt: 'Anexe primeiro o comprovante de pagamento', ru: 'Сначала прикрепите подтверждение оплаты' },
    'funds.minAmountMsg': { en: 'Amount must be at least {a} {c}', zh: '金额至少为{a} {c}', ja: '金額は{a} {c}以上である必要があります', ko: '금액은 {a} {c} 이상이어야 합니다', fa: 'مبلغ باید حداقل {a} {c} باشد', de: 'Der Betrag muss mindestens {a} {c} betragen', fr: 'Le montant doit être d\'au moins {a} {c}', es: 'El monto debe ser al menos {a} {c}', it: 'L\'importo deve essere almeno {a} {c}', pt: 'O valor deve ser de pelo menos {a} {c}', ru: 'Сумма должна быть не менее {a} {c}' },

    /* ---- exchange ---- */
    'exch.title': { en: 'Exchange', zh: '兑换', ja: '両替', ko: '교환', fa: 'تبدیل', de: 'Tausch', fr: 'Échange', es: 'Intercambio', it: 'Scambio', pt: 'Troca', ru: 'Обмен' },
    'exch.from': { en: 'From', zh: '从', ja: '送り元', ko: '보내는', fa: 'از', de: 'Von', fr: 'De', es: 'De', it: 'Da', pt: 'De', ru: 'Отдаёте' },
    'exch.to': { en: 'To', zh: '到', ja: '送り先', ko: '받는', fa: 'به', de: 'Nach', fr: 'À', es: 'A', it: 'A', pt: 'Para', ru: 'Получаете' },
    'exch.enterAmount': { en: 'Please enter amount', zh: '请输入金额', ja: '金額を入力', ko: '금액을 입력하세요', fa: 'مبلغ را وارد کنید', de: 'Betrag eingeben', fr: 'Entrez le montant', es: 'Ingrese el monto', it: 'Inserisci l\'importo', pt: 'Digite o valor', ru: 'Введите сумму' },
    'exch.available': { en: 'Available Balance', zh: '可用余额', ja: '利用可能残高', ko: '사용 가능 잔액', fa: 'موجودی قابل استفاده', de: 'Verfügbares Guthaben', fr: 'Solde disponible', es: 'Saldo disponible', it: 'Saldo disponibile', pt: 'Saldo disponível', ru: 'Доступный баланс' },
    'exch.rate': { en: 'Exchange Rate', zh: '汇率', ja: '交換レート', ko: '환율', fa: 'نرخ تبدیل', de: 'Wechselkurs', fr: 'Taux de change', es: 'Tipo de cambio', it: 'Tasso di cambio', pt: 'Taxa de câmbio', ru: 'Курс обмена' },
    'exch.estimatedFee': { en: 'Estimated fee', zh: '预估手续费', ja: '推定手数料', ko: '예상 수수료', fa: 'کارمزد تخمینی', de: 'Geschätzte Gebühr', fr: 'Frais estimés', es: 'Comisión estimada', it: 'Commissione stimata', pt: 'Taxa estimada', ru: 'Оценочная комиссия' },
    'exch.now': { en: 'Exchange Now', zh: '立即兑换', ja: '今すぐ両替', ko: '지금 교환', fa: 'تبدیل کن', de: 'Jetzt tauschen', fr: 'Échanger', es: 'Intercambiar ahora', it: 'Scambia ora', pt: 'Trocar agora', ru: 'Обменять' },
    'exch.history': { en: 'Exchange History', zh: '兑换记录', ja: '両替履歴', ko: '교환 내역', fa: 'تاریخچه تبدیل', de: 'Tauschverlauf', fr: 'Historique des échanges', es: 'Historial de intercambios', it: 'Cronologia scambi', pt: 'Histórico de trocas', ru: 'История обменов' },
    'exch.calculating': { en: 'Calculating...', zh: '计算中...', ja: '計算中...', ko: '계산 중...', fa: 'در حال محاسبه...', de: 'Berechnung...', fr: 'Calcul...', es: 'Calculando...', it: 'Calcolo...', pt: 'Calculando...', ru: 'Расчёт...' },
    'exch.all': { en: 'ALL', zh: '全部', ja: 'すべて', ko: '전체', fa: 'همه', de: 'ALL', fr: 'TOUT', es: 'TODO', it: 'TUTTO', pt: 'TUDO', ru: 'ВСЕ' },
    'exch.sameCoin': { en: 'Please select different currencies', zh: '请选择不同的币种', ja: '異なる通貨を選択してください', ko: '다른 통화를 선택하세요', fa: 'لطفاً ارزهای متفاوت انتخاب کنید', de: 'Bitte wählen Sie verschiedene Währungen', fr: 'Veuillez sélectionner des devises différentes', es: 'Selecciona monedas diferentes', it: 'Seleziona valute diverse', pt: 'Selecione moedas diferentes', ru: 'Выберите разные валюты' },
    'exch.insufficient': { en: 'Insufficient {c} balance', zh: '{c}余额不足', ja: '{c}残高が不足しています', ko: '{c} 잔액이 부족합니다', fa: 'موجودی {c} ناکافی است', de: 'Unzureichendes {c}-Guthaben', fr: 'Solde {c} insuffisant', es: 'Saldo {c} insuficiente', it: 'Saldo {c} insufficiente', pt: 'Saldo {c} insuficiente', ru: 'Недостаточно средств {c}' },
    'exch.success': { en: 'Exchange successful', zh: '兑换成功', ja: '両替が完了しました', ko: '교환이 완료되었습니다', fa: 'تبدیل با موفقیت انجام شد', de: 'Tausch erfolgreich', fr: 'Échange réussi', es: 'Intercambio exitoso', it: 'Scambio riuscito', pt: 'Troca realizada', ru: 'Обмен выполнен' },
    'exch.noYet': { en: 'No exchanges yet', zh: '暂无兑换记录', ja: '両替履歴はありません', ko: '교환 내역이 없습니다', fa: 'هنوز تبادلی انجام نشده', de: 'Noch keine Tauschvorgänge', fr: 'Aucun échange pour l\'instant', es: 'Sin intercambios aún', it: 'Nessuno scambio ancora', pt: 'Nenhuma troca ainda', ru: 'Обменов пока нет' },

    /* ---- loan ---- */
    'loan.title': { en: 'Loan', zh: '借款', ja: 'ローン', ko: '대출', fa: 'وام', de: 'Darlehen', fr: 'Prêt', es: 'Préstamo', it: 'Prestito', pt: 'Empréstimo', ru: 'Займ' },
    'loan.limit': { en: 'Loan Limit', zh: '借款额度', ja: '融資限度額', ko: '대출 한도', fa: 'سقف وام', de: 'Darlehenslimit', fr: 'Plafond de prêt', es: 'Límite de préstamo', it: 'Limite prestito', pt: 'Limite do empréstimo', ru: 'Лимит займа' },
    'loan.period': { en: 'Loan Period', zh: '借款期限', ja: '借入期間', ko: '대출 기간', fa: 'دوره وام', de: 'Laufzeit', fr: 'Durée du prêt', es: 'Período del préstamo', it: 'Durata prestito', pt: 'Período do empréstimo', ru: 'Срок займа' },
    'loan.selectPeriod': { en: 'Please select loan period', zh: '请选择借款期限', ja: '借入期間を選択してください', ko: '대출 기간을 선택하세요', fa: 'لطفاً دوره وام را انتخاب کنید', de: 'Bitte Laufzeit wählen', fr: 'Veuillez choisir la durée', es: 'Seleccione el período', it: 'Seleziona la durata', pt: 'Selecione o período', ru: 'Выберите срок займа' },
    'loan.amount': { en: 'Amount', zh: '金额', ja: '金額', ko: '금액', fa: 'مبلغ', de: 'Betrag', fr: 'Montant', es: 'Monto', it: 'Importo', pt: 'Valor', ru: 'Сумма' },
    'loan.enterAmount': { en: 'Please enter loan amount', zh: '请输入借款金额', ja: '借入金額を入力', ko: '대출 금액을 입력하세요', fa: 'مبلغ وام را وارد کنید', de: 'Darlehensbetrag eingeben', fr: 'Entrez le montant du prêt', es: 'Ingrese el monto del préstamo', it: 'Inserisci l\'importo del prestito', pt: 'Digite o valor do empréstimo', ru: 'Введите сумму займа' },
    'loan.amountRange': { en: 'Amount Range', zh: '金额范围', ja: '金額範囲', ko: '금액 범위', fa: 'بازه مبلغ', de: 'Betragsbereich', fr: 'Plage de montants', es: 'Rango de monto', it: 'Intervallo importo', pt: 'Faixa de valor', ru: 'Диапазон сумм' },
    'loan.rate': { en: 'Overall Rate', zh: '综合利率', ja: '総合利率', ko: '종합 이율', fa: 'نرخ کلی', de: 'Gesamtzinssatz', fr: 'Taux global', es: 'Tasa general', it: 'Tasso complessivo', pt: 'Taxa geral', ru: 'Общая ставка' },
    'loan.totalInterest': { en: 'Total Interest', zh: '总利息', ja: '総利息', ko: '총 이자', fa: 'بهره کل', de: 'Gesamtzinsen', fr: 'Intérêts totaux', es: 'Interés total', it: 'Interesse totale', pt: 'Juros totais', ru: 'Общие проценты' },
    'loan.applyNow': { en: 'Apply Now', zh: '立即申请', ja: '今すぐ申込', ko: '지금 신청', fa: 'درخواست بدهید', de: 'Jetzt beantragen', fr: 'Demander', es: 'Solicitar ahora', it: 'Richiedi ora', pt: 'Solicitar agora', ru: 'Подать заявку' },
    'loan.history': { en: 'Loan History', zh: '借款记录', ja: 'ローン履歴', ko: '대출 내역', fa: 'تاریخچه وام', de: 'Darlehensverlauf', fr: 'Historique des prêts', es: 'Historial de préstamos', it: 'Cronologia prestiti', pt: 'Histórico de empréstimos', ru: 'История займов' },
    'loan.noRecords': { en: 'No loan records', zh: '暂无借款记录', ja: 'ローン記録がありません', ko: '대출 내역 없음', fa: 'بدون سابقه وام', de: 'Keine Darlehensaufzeichnungen', fr: 'Aucun historique de prêt', es: 'Sin historial de préstamos', it: 'Nessun prestito', pt: 'Sem empréstimos', ru: 'Нет записей о займах' },
    'loan.days': { en: 'Days', zh: '天', ja: '日', ko: '일', fa: 'روز', de: 'Tage', fr: 'Jours', es: 'Días', it: 'Giorni', pt: 'Dias', ru: 'дней' },
    'loan.time': { en: 'Time', zh: '时间', ja: '時間', ko: '시간', fa: 'زمان', de: 'Zeit', fr: 'Heure', es: 'Hora', it: 'Ora', pt: 'Horário', ru: 'Время' },
    'loan.plan7': { en: '7 Days - [100-5,000]', zh: '7天 - [100-5,000]', ja: '7日 - [100-5,000]', ko: '7일 - [100-5,000]', fa: '۷ روز - [۱۰۰-۵,۰۰۰]', de: '7 Tage - [100-5.000]', fr: '7 jours - [100-5 000]', es: '7 días - [100-5.000]', it: '7 giorni - [100-5.000]', pt: '7 dias - [100-5.000]', ru: '7 дней - [100-5 000]' },
    'loan.plan14': { en: '14 Days - [1,000-10,000]', zh: '14天 - [1,000-10,000]', ja: '14日 - [1,000-10,000]', ko: '14일 - [1,000-10,000]', fa: '۱۴ روز - [۱,۰۰۰-۱۰,۰۰۰]', de: '14 Tage - [1.000-10.000]', fr: '14 jours - [1 000-10 000]', es: '14 días - [1.000-10.000]', it: '14 giorni - [1.000-10.000]', pt: '14 dias - [1.000-10.000]', ru: '14 дней - [1 000-10 000]' },
    'loan.plan30': { en: '30 Days - [10,000-50,000]', zh: '30天 - [10,000-50,000]', ja: '30日 - [10,000-50,000]', ko: '30일 - [10,000-50,000]', fa: '۳۰ روز - [۱۰,۰۰۰-۵۰,۰۰۰]', de: '30 Tage - [10.000-50.000]', fr: '30 jours - [10 000-50 000]', es: '30 días - [10.000-50.000]', it: '30 giorni - [10.000-50.000]', pt: '30 dias - [10.000-50.000]', ru: '30 дней - [10 000-50 000]' },
    'loan.plan60': { en: '60 Days - [20,000-200,000]', zh: '60天 - [20,000-200,000]', ja: '60日 - [20,000-200,000]', ko: '60일 - [20,000-200,000]', fa: '۶۰ روز - [۲۰,۰۰۰-۲۰۰,۰۰۰]', de: '60 Tage - [20.000-200.000]', fr: '60 jours - [20 000-200 000]', es: '60 días - [20.000-200.000]', it: '60 giorni - [20.000-200.000]', pt: '60 dias - [20.000-200.000]', ru: '60 дней - [20 000-200 000]' },
    'loan.amountLabel': { en: 'Amount: $', zh: '金额：$', ja: '金額：$', ko: '금액: $', fa: 'مبلغ: $', de: 'Betrag: $', fr: 'Montant : $', es: 'Monto: $', it: 'Importo: $', pt: 'Valor: $', ru: 'Сумма: $' },
    'loan.outOfRange': { en: 'Amount out of range', zh: '金额超出范围', ja: '金額が範囲外です', ko: '금액이 범위를 벗어났습니다', fa: 'مبلغ خارج از محدوده است', de: 'Betrag außerhalb des Bereichs', fr: 'Montant hors plage', es: 'Monto fuera de rango', it: 'Importo fuori intervallo', pt: 'Valor fora do intervalo', ru: 'Сумма вне диапазона' },
    'loan.submitted': { en: 'Loan application submitted', zh: '借款申请已提交', ja: 'ローン申請を送信しました', ko: '대출 신청이 제출되었습니다', fa: 'درخواست وام ثبت شد', de: 'Darlehensantrag übermittelt', fr: 'Demande de prêt soumise', es: 'Solicitud de préstamo enviada', it: 'Richiesta di prestito inviata', pt: 'Solicitação de empréstimo enviada', ru: 'Заявка на займ отправлена' },

    /* ---- orders ---- */
    'orders.title': { en: 'Order List', zh: '订单列表', ja: '注文履歴', ko: '주문 목록', fa: 'لیست سفارشات', de: 'Auftragsliste', fr: 'Liste des commandes', es: 'Lista de pedidos', it: 'Lista ordini', pt: 'Lista de pedidos', ru: 'Список ордеров' },
    'orders.open': { en: 'Open', zh: '持仓中', ja: '保有中', ko: '진행 중', fa: 'باز', de: 'Offen', fr: 'Ouvert', es: 'Abierto', it: 'Aperto', pt: 'Aberto', ru: 'Открытые' },
    'orders.closed': { en: 'Closed', zh: '已结束', ja: '完了', ko: '종료', fa: 'بسته', de: 'Geschlossen', fr: 'Clos', es: 'Cerrado', it: 'Chiuso', pt: 'Fechado', ru: 'Закрытые' },
    'orders.noOrders': { en: 'No orders', zh: '暂无订单', ja: '注文がありません', ko: '주문 없음', fa: 'بدون سفارش', de: 'Keine Aufträge', fr: 'Aucune commande', es: 'Sin pedidos', it: 'Nessun ordine', pt: 'Sem pedidos', ru: 'Нет ордеров' },
    'orders.purchaseAmount': { en: 'Purchase Amount', zh: '购买金额', ja: '購入金額', ko: '구매 금액', fa: 'مبلغ خرید', de: 'Kaufbetrag', fr: 'Montant d\'achat', es: 'Monto de compra', it: 'Importo acquisto', pt: 'Valor de compra', ru: 'Сумма покупки' },
    'orders.direction': { en: 'Direction', zh: '方向', ja: '方向', ko: '방향', fa: 'جهت', de: 'Richtung', fr: 'Direction', es: 'Dirección', it: 'Direzione', pt: 'Direção', ru: 'Направление' },
    'orders.up': { en: 'Up', zh: '上涨', ja: '上昇', ko: '상승', fa: 'صعود', de: 'Aufwärts', fr: 'Hausse', es: 'Alza', it: 'Su', pt: 'Alta', ru: 'Вверх' },
    'orders.down': { en: 'Down', zh: '下跌', ja: '下落', ko: '하락', fa: 'نزول', de: 'Abwärts', fr: 'Baisse', es: 'Baja', it: 'Giù', pt: 'Baixa', ru: 'Вниз' },
    'orders.buyPrice': { en: 'Buy Price', zh: '买入价', ja: '買値', ko: '매수 가격', fa: 'قیمت خرید', de: 'Kaufpreis', fr: 'Prix d\'achat', es: 'Precio de compra', it: 'Prezzo di acquisto', pt: 'Preço de compra', ru: 'Цена покупки' },
    'orders.sellPrice': { en: 'Sell Price', zh: '卖出价', ja: '売値', ko: '매도 가격', fa: 'قیمت فروش', de: 'Verkaufspreis', fr: 'Prix de vente', es: 'Precio de venta', it: 'Prezzo di vendita', pt: 'Preço de venda', ru: 'Цена продажи' },
    'orders.deliveryTime': { en: 'Delivery Time', zh: '交割时间', ja: '決済時間', ko: '결제 시간', fa: 'زمان تسویه', de: 'Lieferzeit', fr: 'Heure de livraison', es: 'Hora de entrega', it: 'Ora di consegna', pt: 'Hora de entrega', ru: 'Время исполнения' },
    'orders.profitLoss': { en: 'Profit/Loss', zh: '盈亏', ja: '損益', ko: '손익', fa: 'سود/زیان', de: 'Gewinn/Verlust', fr: 'Profit/Perte', es: 'Ganancia/Pérdida', it: 'Profitto/Perdita', pt: 'Lucro/Perda', ru: 'Прибыль/Убыток' },
    'orders.statusProfit': { en: 'Profit', zh: '盈利', ja: '利益', ko: '수익', fa: 'سود', de: 'Gewinn', fr: 'Profit', es: 'Ganancia', it: 'Profitto', pt: 'Lucro', ru: 'Прибыль' },
    'orders.statusLoss': { en: 'Loss', zh: '亏损', ja: '損失', ko: '손실', fa: 'زیان', de: 'Verlust', fr: 'Perte', es: 'Pérdida', it: 'Perdita', pt: 'Perda', ru: 'Убыток' },

    /* ---- ai quant ---- */
    'ai.title': { en: 'AI Quantitative Trading', zh: 'AI量化交易', ja: 'AIクオンツ取引', ko: 'AI 퀀트 트레이딩', fa: 'معاملات کمی هوشمند', de: 'AI-Quant-Handel', fr: 'Trading quantitatif IA', es: 'Trading cuantitativo IA', it: 'Trading quantitativo IA', pt: 'Trading quantitativo IA', ru: 'AI-квантовая торговля' },
    'ai.bannerTitle': { en: 'AI Smart Quantitative', zh: 'AI智能量化', ja: 'AIスマートクオンツ', ko: 'AI 스마트 퀀트', fa: 'کوانت هوشمند AI', de: 'AI Smart Quant', fr: 'Quant intelligent IA', es: 'Quant inteligente IA', it: 'Quant intelligente AI', pt: 'Quant inteligente IA', ru: 'Умный AI-квант' },
    'ai.bannerSub': { en: 'Professional quantitative strategy, stable returns', zh: '专业量化策略，收益稳定', ja: 'プロのクオンツ戦略、安定した収益', ko: '전문 퀀트 전략, 안정적인 수익', fa: 'استراتژی کمی حرفه‌ای، بازدهی پایدار', de: 'Professionelle Quant-Strategie, stabile Renditen', fr: 'Stratégie quantitative professionnelle, rendements stables', es: 'Estrategia cuantitativa profesional, retornos estables', it: 'Strategia quantitativa professionale, rendimenti stabili', pt: 'Estratégia quantitativa profissional, retornos estáveis', ru: 'Профессиональная количественная стратегия, стабильная доходность' },
    'ai.dailyReturn': { en: 'Daily Return', zh: '日收益率', ja: '日次リターン', ko: '일일 수익률', fa: 'بازده روزانه', de: 'Tagesrendite', fr: 'Rendement journalier', es: 'Retorno diario', it: 'Rendimento giornaliero', pt: 'Retorno diário', ru: 'Дневная доходность' },
    'ai.minInvestment': { en: 'Min Investment', zh: '最低投资', ja: '最低投資額', ko: '최소 투자', fa: 'حداقل سرمایه‌گذاری', de: 'Mindestinvestition', fr: 'Investissement min.', es: 'Inversión mínima', it: 'Investimento minimo', pt: 'Investimento mínimo', ru: 'Мин. инвестиция' },
    'ai.settlement': { en: 'Settlement', zh: '结算方式', ja: '精算方式', ko: '정산 방식', fa: 'روش تسویه', de: 'Abrechnung', fr: 'Règlement', es: 'Liquidación', it: 'Regolamento', pt: 'Liquidação', ru: 'Расчёт' },
    'ai.dailySettle': { en: 'Daily Settle', zh: '每日结算', ja: '日次精算', ko: '일일 정산', fa: 'تسویه روزانه', de: 'Tägliche Abrechnung', fr: 'Règlement journalier', es: 'Liquidación diaria', it: 'Regolamento giornaliero', pt: 'Liquidação diária', ru: 'Ежедневный расчёт' },
    'ai.buyNow': { en: 'Buy Now', zh: '立即购买', ja: '今すぐ購入', ko: '지금 구매', fa: 'خرید کن', de: 'Jetzt kaufen', fr: 'Acheter', es: 'Comprar ahora', it: 'Acquista ora', pt: 'Comprar agora', ru: 'Купить' },
    'ai.myPositions': { en: 'My Positions', zh: '我的持仓', ja: 'マイポジション', ko: '내 포지션', fa: 'پوزیشن‌های من', de: 'Meine Positionen', fr: 'Mes positions', es: 'Mis posiciones', it: 'Le mie posizioni', pt: 'Minhas posições', ru: 'Мои позиции' },
    'ai.noPositions': { en: 'No positions yet', zh: '暂无持仓', ja: 'ポジションがありません', ko: '포지션 없음', fa: 'هنوز پوزیشنی ندارید', de: 'Noch keine Positionen', fr: 'Aucune position', es: 'Sin posiciones', it: 'Nessuna posizione', pt: 'Sem posições', ru: 'Позиций пока нет' },
    'ai.period': { en: 'Period', zh: '周期', ja: '期間', ko: '기간', fa: 'دوره', de: 'Laufzeit', fr: 'Durée', es: 'Período', it: 'Durata', pt: 'Período', ru: 'Период' },
    'ai.days': { en: 'Days', zh: '天', ja: '日', ko: '일', fa: 'روز', de: 'Tage', fr: 'Jours', es: 'Días', it: 'Giorni', pt: 'Dias', ru: 'дней' },
    'ai.profitMethod': { en: 'Profit Method', zh: '收益方式', ja: '収益方式', ko: '수익 방식', fa: 'روش سود', de: 'Gewinnmethode', fr: 'Méthode de profit', es: 'Método de ganancia', it: 'Metodo di profitto', pt: 'Método de lucro', ru: 'Метод прибыли' },
    'ai.investmentAmount': { en: 'Investment Amount (USDT)', zh: '投资金额（USDT）', ja: '投資額（USDT）', ko: '투자 금액(USDT)', fa: 'مبلغ سرمایه‌گذاری (USDT)', de: 'Investitionsbetrag (USDT)', fr: 'Montant d\'investissement (USDT)', es: 'Monto de inversión (USDT)', it: 'Importo investimento (USDT)', pt: 'Valor de investimento (USDT)', ru: 'Сумма инвестиции (USDT)' },
    'ai.enterInvestment': { en: 'Enter investment amount', zh: '请输入投资金额', ja: '投資額を入力', ko: '투자 금액을 입력하세요', fa: 'مبلغ سرمایه‌گذاری را وارد کنید', de: 'Investitionsbetrag eingeben', fr: 'Entrez le montant d\'investissement', es: 'Ingrese el monto de inversión', it: 'Inserisci l\'importo', pt: 'Digite o valor', ru: 'Введите сумму инвестиции' },
    'ai.estimatedProfit': { en: 'Estimated Profit', zh: '预计收益', ja: '予想収益', ko: '예상 수익', fa: 'سود تخمینی', de: 'Geschätzter Gewinn', fr: 'Profit estimé', es: 'Ganancia estimada', it: 'Profitto stimato', pt: 'Lucro estimado', ru: 'Оценочная прибыль' },
    'ai.estDailyProfit': { en: 'Est. Daily Profit', zh: '预计日收益', ja: '予想日次収益', ko: '예상 일일 수익', fa: 'سود روزانه تخمینی', de: 'Geschätzter Tagesgewinn', fr: 'Profit quotidien est.', es: 'Ganancia diaria est.', it: 'Profitto giornaliero est.', pt: 'Lucro diário est.', ru: 'Оцен. дневная прибыль' },
    'ai.estTotalProfit': { en: 'Est. Total Profit', zh: '预计总收益', ja: '予想総収益', ko: '예상 총 수익', fa: 'سود کل تخمینی', de: 'Geschätzter Gesamtgewinn', fr: 'Profit total est.', es: 'Ganancia total est.', it: 'Profitto totale est.', pt: 'Lucro total est.', ru: 'Оцен. общая прибыль' },
    'ai.confirmPurchase': { en: 'Confirm Purchase', zh: '确认购买', ja: '購入を確定', ko: '구매 확인', fa: 'تأیید خرید', de: 'Kauf bestätigen', fr: 'Confirmer l\'achat', es: 'Confirmar compra', it: 'Conferma acquisto', pt: 'Confirmar compra', ru: 'Подтвердить покупку' },
    'ai.orderDetails': { en: 'Order Details', zh: '订单详情', ja: '注文詳細', ko: '주문 상세', fa: 'جزئیات سفارش', de: 'Auftragsdetails', fr: 'Détails de la commande', es: 'Detalles del pedido', it: 'Dettagli ordine', pt: 'Detalhes do pedido', ru: 'Детали ордера' },
    'ai.basicInfo': { en: 'Basic Info', zh: '基本信息', ja: '基本情報', ko: '기본 정보', fa: 'اطلاعات پایه', de: 'Basisinformationen', fr: 'Informations de base', es: 'Información básica', it: 'Informazioni di base', pt: 'Informações básicas', ru: 'Основная информация' },
    'ai.product': { en: 'Product', zh: '产品', ja: '商品', ko: '상품', fa: 'محصول', de: 'Produkt', fr: 'Produit', es: 'Producto', it: 'Prodotto', pt: 'Produto', ru: 'Продукт' },
    'ai.investment': { en: 'Investment', zh: '投资金额', ja: '投資額', ko: '투자 금액', fa: 'مبلغ سرمایه‌گذاری', de: 'Investition', fr: 'Investissement', es: 'Inversión', it: 'Investimento', pt: 'Investimento', ru: 'Инвестиция' },
    'ai.currentPrincipal': { en: 'Current Principal', zh: '当前本金', ja: '現在の元本', ko: '현재 원금', fa: 'اصل سرمایه فعلی', de: 'Aktuelles Kapital', fr: 'Capital actuel', es: 'Capital actual', it: 'Capitale attuale', pt: 'Capital atual', ru: 'Текущий капитал' },
    'ai.cumulativeProfit': { en: 'Cumulative Profit', zh: '累计收益', ja: '累計収益', ko: '누적 수익', fa: 'سود تجمعی', de: 'Kumulierter Gewinn', fr: 'Profit cumulé', es: 'Ganancia acumulada', it: 'Profitto cumulato', pt: 'Lucro acumulado', ru: 'Совокупная прибыль' },
    'ai.startTime': { en: 'Start Time', zh: '开始时间', ja: '開始時間', ko: '시작 시간', fa: 'زمان شروع', de: 'Startzeit', fr: 'Heure de début', es: 'Hora de inicio', it: 'Ora di inizio', pt: 'Hora de início', ru: 'Время начала' },
    'ai.endTime': { en: 'End Time', zh: '结束时间', ja: '終了時間', ko: '종료 시간', fa: 'زمان پایان', de: 'Endzeit', fr: 'Heure de fin', es: 'Hora de fin', it: 'Ora di fine', pt: 'Hora de término', ru: 'Время окончания' },
    'ai.profitPlan': { en: 'Profit Plan', zh: '收益计划', ja: '収益プラン', ko: '수익 계획', fa: 'برنامه سود', de: 'Gewinnplan', fr: 'Plan de profit', es: 'Plan de ganancia', it: 'Piano di profitto', pt: 'Plano de lucro', ru: 'План прибыли' },
    'ai.day': { en: 'Day', zh: '第', ja: '日目', ko: '일차', fa: 'روز', de: 'Tag', fr: 'Jour', es: 'Día', it: 'Giorno', pt: 'Dia', ru: 'День' },
    'ai.profitRate': { en: 'Profit Rate', zh: '收益率', ja: '収益率', ko: '수익률', fa: 'نرخ سود', de: 'Gewinnrate', fr: 'Taux de profit', es: 'Tasa de ganancia', it: 'Tasso di profitto', pt: 'Taxa de lucro', ru: 'Ставка прибыли' },
    'ai.profit': { en: 'Profit', zh: '收益', ja: '収益', ko: '수익', fa: 'سود', de: 'Gewinn', fr: 'Profit', es: 'Ganancia', it: 'Profitto', pt: 'Lucro', ru: 'Прибыль' },
    'ai.settled': { en: 'Settled', zh: '已结算', ja: '精算済み', ko: '정산 완료', fa: 'تسویه شده', de: 'Abgerechnet', fr: 'Réglé', es: 'Liquidado', it: 'Regolato', pt: 'Liquidado', ru: 'Расчёт завершён' },
    'ai.pending': { en: 'Pending', zh: '待处理', ja: '保留中', ko: '대기 중', fa: 'در انتظار', de: 'Ausstehend', fr: 'En attente', es: 'Pendiente', it: 'In attesa', pt: 'Pendente', ru: 'Ожидает' },
    'ai.running': { en: 'Running', zh: '运行中', ja: '稼働中', ko: '운영 중', fa: 'در حال اجرا', de: 'Läuft', fr: 'En cours', es: 'En ejecución', it: 'In esecuzione', pt: 'Em execução', ru: 'Активен' },
    'ai.completed': { en: 'Completed', zh: '已完成', ja: '完了', ko: '완료', fa: 'تکمیل شده', de: 'Abgeschlossen', fr: 'Terminé', es: 'Completado', it: 'Completato', pt: 'Concluído', ru: 'Завершён' },
    'ai.rejected': { en: 'Rejected', zh: '已拒绝', ja: '却下', ko: '거절됨', fa: 'رد شده', de: 'Abgelehnt', fr: 'Refusé', es: 'Rechazado', it: 'Rifiutato', pt: 'Rejeitado', ru: 'Отклонён' },
    'ai.awaitingApproval': { en: 'Awaiting approval', zh: '等待审核', ja: '承認待ち', ko: '승인 대기', fa: 'در انتظار تأیید', de: 'Wartet auf Genehmigung', fr: 'En attente d\'approbation', es: 'Esperando aprobación', it: 'In attesa di approvazione', pt: 'Aguardando aprovação', ru: 'Ожидание одобрения' },
    'ai.min': { en: 'Min', zh: '最低', ja: '最小', ko: '최소', fa: 'حداقل', de: 'Min', fr: 'Min', es: 'Mín', it: 'Min', pt: 'Mín', ru: 'Мин.' },
    'ai.max': { en: 'Max', zh: '最高', ja: '最大', ko: '최대', fa: 'حداکثر', de: 'Max', fr: 'Max', es: 'Máx', it: 'Max', pt: 'Máx', ru: 'Макс.' },
    'ai.minimum': { en: 'Min', zh: '最低', ja: '最小', ko: '최소', fa: 'حداقل', de: 'Min', fr: 'Min', es: 'Mín', it: 'Min', pt: 'Mín', ru: 'Мин.' },
    'ai.maximum': { en: 'Max', zh: '最高', ja: '最大', ko: '최대', fa: 'حداکثر', de: 'Max', fr: 'Max', es: 'Máx', it: 'Max', pt: 'Máx', ru: 'Макс.' },
    'ai.available': { en: 'Available', zh: '可用', ja: '利用可能', ko: '사용 가능', fa: 'موجودی', de: 'Verfügbar', fr: 'Disponible', es: 'Disponible', it: 'Disponibile', pt: 'Disponível', ru: 'Доступно' },
    'ai.all': { en: 'All', zh: '全部', ja: 'すべて', ko: '전체', fa: 'همه', de: 'Alles', fr: 'Tout', es: 'Todo', it: 'Tutto', pt: 'Tudo', ru: 'Всё' },
    'ai.settlesIn': { en: 'Settles in', zh: '将在', ja: '精算まで', ko: '정산까지', fa: 'تسویه در', de: 'Abrechnung in', fr: 'Règlement dans', es: 'Se liquida en', it: 'Regolo in', pt: 'Liquida em', ru: 'Расчёт через' },
    'ai.startsIn': { en: 'Starts in', zh: '将在', ja: '開始まで', ko: '시작까지', fa: 'شروع در', de: 'Start in', fr: 'Commence dans', es: 'Comienza en', it: 'Inizia in', pt: 'Começa em', ru: 'Начало через' },
    'ai.p1Name': { en: 'AI Quant Demo', zh: 'AI量化体验', ja: 'AIクアント体験', ko: 'AI 퀀트 체험', fa: 'کوانت آزمایشی', de: 'AI-Quant Demo', fr: 'Démo IA Quant', es: 'Demo IA Quant', it: 'Demo IA Quant', pt: 'Demo IA Quant', ru: 'AI-квант Демо' },
    'ai.p1Desc': { en: '1-day demo plan, daily return 2.0%', zh: '1天体验计划，日收益2.0%', ja: '1日体験プラン、日次リターン2.0%', ko: '1일 체험 플랜, 일일 수익률 2.0%', fa: 'پلن آزمایشی ۱ روزه، بازده روزانه ۲.۰٪', de: '1-Tage-Demoplan, Tagesrendite 2,0%', fr: 'Plan démo 1 jour, rendement 2,0%', es: 'Plan demo de 1 día, retorno 2.0%', it: 'Piano demo 1 giorno, rendimento 2,0%', pt: 'Plano demo 1 dia, retorno 2,0%', ru: 'Демо-план 1 день, доходность 2,0%' },
    'ai.p2Name': { en: 'AI Quant Trial', zh: 'AI量化试用', ja: 'AIクアント体験版', ko: 'AI 퀀트 트라이얼', fa: 'کوانت آزمایشی ۷ روزه', de: 'AI-Quant Test', fr: 'Essai IA Quant', es: 'Prueba IA Quant', it: 'Prova IA Quant', pt: 'Teste IA Quant', ru: 'AI-квант Пробный' },
    'ai.p2Desc': { en: '7-day trial plan, daily return 2.5%', zh: '7天试用计划，日收益2.5%', ja: '7日体験プラン、日次リターン2.5%', ko: '7일 체험 플랜, 일일 수익률 2.5%', fa: 'پلن آزمایشی ۷ روزه، بازده روزانه ۲.۵٪', de: '7-Tage-Testplan, Tagesrendite 2,5%', fr: 'Plan d\'essai 7 jours, rendement 2,5%', es: 'Plan de prueba 7 días, retorno 2.5%', it: 'Piano prova 7 giorni, rendimento 2,5%', pt: 'Plano teste 7 dias, retorno 2,5%', ru: 'Пробный план 7 дней, доходность 2,5%' },
    'ai.p3Name': { en: 'AI Quant Standard', zh: 'AI量化标准', ja: 'AIクアント標準', ko: 'AI 퀀트 스탠다드', fa: 'کوانت استاندارد', de: 'AI-Quant Standard', fr: 'IA Quant Standard', es: 'IA Quant Estándar', it: 'IA Quant Standard', pt: 'IA Quant Padrão', ru: 'AI-квант Стандарт' },
    'ai.p3Desc': { en: '30-day standard plan, daily return 3.0%', zh: '30天标准计划，日收益3.0%', ja: '30日標準プラン、日次リターン3.0%', ko: '30일 표준 플랜, 일일 수익률 3.0%', fa: 'پلن استاندارد ۳۰ روزه، بازده روزانه ۳.۰٪', de: '30-Tage-Standardplan, Tagesrendite 3,0%', fr: 'Plan standard 30 jours, rendement 3,0%', es: 'Plan estándar 30 días, retorno 3.0%', it: 'Piano standard 30 giorni, rendimento 3,0%', pt: 'Plano padrão 30 dias, retorno 3,0%', ru: 'Стандартный план 30 дней, доходность 3,0%' },
    'ai.p4Name': { en: 'AI Quant Professional', zh: 'AI量化专业', ja: 'AIクアントプロ', ko: 'AI 퀀트 프로페셔널', fa: 'کوانت حرفه‌ای', de: 'AI-Quant Pro', fr: 'IA Quant Pro', es: 'IA Quant Profesional', it: 'IA Quant Professional', pt: 'IA Quant Profissional', ru: 'AI-квант Про' },
    'ai.p4Desc': { en: '90-day professional plan, daily return 4.0%', zh: '90天专业计划，日收益4.0%', ja: '90日プロプラン、日次リターン4.0%', ko: '90일 프로 플랜, 일일 수익률 4.0%', fa: 'پلن حرفه‌ای ۹۰ روزه، بازده روزانه ۴.۰٪', de: '90-Tage-Profiplan, Tagesrendite 4,0%', fr: 'Plan pro 90 jours, rendement 4,0%', es: 'Plan profesional 90 días, retorno 4.0%', it: 'Piano pro 90 giorni, rendimento 4,0%', pt: 'Plano profissional 90 dias, retorno 4,0%', ru: 'Профессиональный план 90 дней, доходность 4,0%' },
    'ai.p5Name': { en: 'AI Quant Premium', zh: 'AI量化尊享', ja: 'AIクアントプレミアム', ko: 'AI 퀀트 프리미엄', fa: 'کوانت ممتاز', de: 'AI-Quant Premium', fr: 'IA Quant Premium', es: 'IA Quant Premium', it: 'IA Quant Premium', pt: 'IA Quant Premium', ru: 'AI-квант Премиум' },
    'ai.p5Desc': { en: '180-day premium plan, daily return 5.0%', zh: '180天尊享计划，日收益5.0%', ja: '180日プレミアムプラン、日次リターン5.0%', ko: '180일 프리미엄 플랜, 일일 수익률 5.0%', fa: 'پلن ممتاز ۱۸۰ روزه، بازده روزانه ۵.۰٪', de: '180-Tage-Premiumplan, Tagesrendite 5,0%', fr: 'Plan premium 180 jours, rendement 5,0%', es: 'Plan premium 180 días, retorno 5.0%', it: 'Piano premium 180 giorni, rendimento 5,0%', pt: 'Plano premium 180 dias, retorno 5,0%', ru: 'Премиум-план 180 дней, доходность 5,0%' },
    'ai.buy': { en: 'Buy', zh: '购买', ja: '購入', ko: '구매', fa: 'خرید', de: 'Kaufen', fr: 'Acheter', es: 'Comprar', it: 'Acquista', pt: 'Comprar', ru: 'Купить' },
    'ai.totalProfit': { en: 'Total Profit', zh: '总收益', ja: '総収益', ko: '총 수익', fa: 'سود کل', de: 'Gesamtgewinn', fr: 'Profit total', es: 'Ganancia total', it: 'Profitto totale', pt: 'Lucro total', ru: 'Общая прибыль' },
    'ai.finalizing': { en: 'Finalizing...', zh: '结算中...', ja: '確定中...', ko: '최종 처리 중...', fa: 'در حال نهایی‌سازی...', de: 'Wird abgeschlossen...', fr: 'Finalisation...', es: 'Finalizando...', it: 'Finalizzazione...', pt: 'Finalizando...', ru: 'Завершение...' },
    'ai.errMin': { en: 'Amount cannot be less than minimum', zh: '金额不能低于最低投资额', ja: '金額は最低額を下回ることはできません', ko: '금액은 최소 금액보다 작을 수 없습니다', fa: 'مبلغ نمی‌تواند کمتر از حداقل باشد', de: 'Der Betrag darf das Minimum nicht unterschreiten', fr: 'Le montant ne peut être inférieur au minimum', es: 'El monto no puede ser menor al mínimo', it: 'L\'importo non può essere inferiore al minimo', pt: 'O valor não pode ser menor que o mínimo', ru: 'Сумма не может быть меньше минимальной' },
    'ai.errMax': { en: 'Amount cannot exceed maximum', zh: '金额不能超过最高投资额', ja: '金額は上限を超えることはできません', ko: '금액은 최대 금액을 초과할 수 없습니다', fa: 'مبلغ نمی‌تواند از حداکثر بیشتر باشد', de: 'Der Betrag darf das Maximum nicht überschreiten', fr: 'Le montant ne peut dépasser le maximum', es: 'El monto no puede exceder el máximo', it: 'L\'importo non può superare il massimo', pt: 'O valor não pode exceder o máximo', ru: 'Сумма не может превышать максимум' },
    'ai.buySuccess': { en: 'Purchase successful, order will start automatically', zh: '购买成功，订单将自动开始', ja: '購入が完了しました。注文は自動的に開始されます', ko: '구매가 완료되었습니다. 주문이 자동으로 시작됩니다', fa: 'خرید با موفقیت انجام شد، سفارش به‌طور خودکار شروع می‌شود', de: 'Kauf erfolgreich, der Auftrag startet automatisch', fr: 'Achat réussi, la commande démarrera automatiquement', es: 'Compra exitosa, el pedido comenzará automáticamente', it: 'Acquisto riuscito, l\'ordine partirà automaticamente', pt: 'Compra realizada, o pedido será iniciado automaticamente', ru: 'Покупка успешна, ордер запустится автоматически' },
    'ai.settling': { en: 'Settling...', zh: '结算中...', ja: '精算中...', ko: '정산 중...', fa: 'در حال تسویه...', de: 'Wird abgerechnet...', fr: 'Règlement...', es: 'Liquidando...', it: 'Regolando...', pt: 'Liquidando...', ru: 'Расчёт...' },
    'ai.starting': { en: 'Starting...', zh: '启动中...', ja: '開始中...', ko: '시작 중...', fa: 'در حال شروع...', de: 'Startet...', fr: 'Démarrage...', es: 'Iniciando...', it: 'Avvio...', pt: 'Iniciando...', ru: 'Запуск...' },
    'ai.left': { en: 'left', zh: '剩余', ja: '残り', ko: '남음', fa: 'مانده', de: 'verbleibend', fr: 'restantes', es: 'restante', it: 'rimasti', pt: 'restantes', ru: 'осталось' },

    /* ---- service chat ---- */
    'svc.title': { en: 'Customer Service', zh: '客户服务', ja: 'カスタマーサポート', ko: '고객 서비스', fa: 'خدمات مشتری', de: 'Kundenservice', fr: 'Service client', es: 'Atención al cliente', it: 'Assistenza clienti', pt: 'Atendimento ao cliente', ru: 'Поддержка клиентов' },
    'svc.online': { en: 'We typically reply in minutes', zh: '在线', ja: 'オンライン', ko: '온라인', fa: 'آنلاین', de: 'Online', fr: 'En ligne', es: 'En línea', it: 'Online', pt: 'Online', ru: 'Онлайн' },
    'svc.welcome': { en: 'Welcome', zh: '欢迎', ja: 'ようこそ', ko: '환영합니다', fa: 'خوش آمدید', de: 'Willkommen', fr: 'Bienvenue', es: 'Bienvenido', it: 'Benvenuto', pt: 'Bem-vindo', ru: 'Добро пожаловать' },
    'svc.welcomeSub': { en: 'How can we help you today?', zh: '今天有什么可以帮您？', ja: '本日はどのようなご用件ですか？', ko: '오늘 무엇을 도와드릴까요?', fa: 'امروز چگونه می‌توانیم کمک کنیم؟', de: 'Wie können wir Ihnen heute helfen?', fr: 'Comment pouvons-nous vous aider ?', es: '¿Cómo podemos ayudarte hoy?', it: 'Come possiamo aiutarti oggi?', pt: 'Como podemos ajudá-lo hoje?', ru: 'Чем можем помочь сегодня?' },
    'svc.liveChat': { en: 'Live Chat', zh: '在线咨询', ja: 'ライブチャット', ko: '실시간 채팅', fa: 'چت زنده', de: 'Live-Chat', fr: 'Chat en direct', es: 'Chat en vivo', it: 'Chat live', pt: 'Chat ao vivo', ru: 'Онлайн-чат' },
    'svc.chatNow': { en: 'Chat with support now', zh: '立即与客服沟通', ja: '今すぐサポートとチャット', ko: '지금 상담 시작', fa: 'هم‌اکنون گفتگو کنید', de: 'Jetzt mit Support chatten', fr: 'Discutez avec le support', es: 'Chatea con soporte', it: 'Parla subito con l\'assistenza', pt: 'Fale com o suporte', ru: 'Связаться с поддержкой' },
    'svc.emailSupport': { en: 'Email Support', zh: '邮件支持', ja: 'メールサポート', ko: '이메일 지원', fa: 'پشتیبانی ایمیل', de: 'E-Mail-Support', fr: 'Support par e-mail', es: 'Soporte por correo', it: 'Supporto via email', pt: 'Suporte por e-mail', ru: 'Поддержка по email' },
    'svc.typeMessage': { en: 'Type a message...', zh: '输入消息...', ja: 'メッセージを入力...', ko: '메시지를 입력하세요...', fa: 'پیام خود را بنویسید...', de: 'Nachricht eingeben...', fr: 'Écrivez un message...', es: 'Escribe un mensaje...', it: 'Scrivi un messaggio...', pt: 'Digite uma mensagem...', ru: 'Введите сообщение...' },
    'svc.back': { en: 'Back', zh: '返回', ja: '戻る', ko: '뒤로', fa: 'بازگشت', de: 'Zurück', fr: 'Retour', es: 'Volver', it: 'Indietro', pt: 'Voltar', ru: 'Назад' },
    'svc.send': { en: 'Send', zh: '发送', ja: '送信', ko: '보내기', fa: 'ارسال', de: 'Senden', fr: 'Envoyer', es: 'Enviar', it: 'Invia', pt: 'Enviar', ru: 'Отправить' },
    'svc.attachLimit': { en: 'Up to 6 attachments per message', zh: '每条消息最多6个附件', ja: '1メッセージに添付できるのは最大6件です', ko: '메시지당 최대 6개 첨부 가능', fa: 'حداکثر ۶ پیوست برای هر پیام', de: 'Maximal 6 Anhänge pro Nachricht', fr: '6 pièces jointes maximum par message', es: 'Máximo 6 adjuntos por mensaje', it: 'Massimo 6 allegati per messaggio', pt: 'Máximo de 6 anexos por mensagem', ru: 'Не более 6 вложений на сообщение' },
    'svc.fileTooLarge': { en: '{n} is too large (max 1.2MB)', zh: '{n} 太大（最大1.2MB）', ja: '{n} が大きすぎます（最大1.2MB）', ko: '{n} 이(가) 너무 큽니다 (최대 1.2MB)', fa: '{n} بیش از حد بزرگ است (حداکثر ۱.۲MB)', de: '{n} ist zu groß (max. 1,2 MB)', fr: '{n} est trop lourd (max 1,2 Mo)', es: '{n} es demasiado grande (máx. 1,2 MB)', it: '{n} è troppo grande (max 1,2 MB)', pt: '{n} é muito grande (máx. 1,2 MB)', ru: '{n} слишком большой (макс. 1,2 МБ)' },
    'svc.fileReadErr': { en: 'Could not read {n}', zh: '无法读取 {n}', ja: '{n} を読み取れませんでした', ko: '{n} 을(를) 읽을 수 없습니다', fa: 'امکان خواندن {n} وجود ندارد', de: '{n} konnte nicht gelesen werden', fr: 'Impossible de lire {n}', es: 'No se pudo leer {n}', it: 'Impossibile leggere {n}', pt: 'Não foi possível ler {n}', ru: 'Не удалось прочитать {n}' },
    'svc.unableConnect': { en: 'Unable to connect. Please try again later.', zh: '无法连接，请稍后重试。', ja: '接続できません。しばらくしてからお試しください。', ko: '연결할 수 없습니다. 나중에 다시 시도해 주세요.', fa: 'امکان اتصال وجود ندارد. لطفاً بعداً دوباره تلاش کنید.', de: 'Keine Verbindung möglich. Bitte später erneut versuchen.', fr: 'Connexion impossible. Réessayez plus tard.', es: 'No se puede conectar. Inténtalo más tarde.', it: 'Impossibile connettersi. Riprova più tardi.', pt: 'Não foi possível conectar. Tente novamente mais tarde.', ru: 'Нет соединения. Повторите попытку позже.' },

    /* ---- support chat ---- */
    'chat.title': { en: 'Support Chat', zh: '客服聊天', ja: 'サポートチャット', ko: '상담 채팅', fa: 'چت پشتیبانی', de: 'Support-Chat', fr: 'Chat support', es: 'Chat de soporte', it: 'Chat assistenza', pt: 'Chat de suporte', ru: 'Чат поддержки' },
    'chat.welcome': { en: 'How can we help you?', zh: '有什么可以帮您？', ja: 'どのようなご用件ですか？', ko: '무엇을 도와드릴까요?', fa: 'چگونه می‌توانیم کمک کنیم؟', de: 'Wie können wir helfen?', fr: 'Comment pouvons-nous vous aider ?', es: '¿Cómo podemos ayudarte?', it: 'Come possiamo aiutarti?', pt: 'Como podemos ajudar?', ru: 'Чем можем помочь?' },
    'chat.welcomeSub': { en: 'How can we help you? Send us a message.', zh: '有什么可以帮您？给我们留言吧。', ja: 'どのようなご用件ですか？メッセージをお送りください。', ko: '무엇을 도와드릴까요? 메시지를 보내주세요.', fa: 'چگونه می‌توانیم کمک کنیم؟ به ما پیام دهید.', de: 'Wie können wir helfen? Senden Sie uns eine Nachricht.', fr: 'Comment pouvons-nous vous aider ? Envoyez-nous un message.', es: '¿Cómo podemos ayudarte? Envíanos un mensaje.', it: 'Come possiamo aiutarti? Mandaci un messaggio.', pt: 'Como podemos ajudar? Envie-nos uma mensagem.', ru: 'Чем можем помочь? Напишите нам.' },
    'chat.typeMessage': { en: 'Type a message...', zh: '输入消息...', ja: 'メッセージを入力...', ko: '메시지를 입력하세요...', fa: 'پیام خود را بنویسید...', de: 'Nachricht eingeben...', fr: 'Écrivez un message...', es: 'Escribe un mensaje...', it: 'Scrivi un messaggio...', pt: 'Digite uma mensagem...', ru: 'Введите сообщение...' },
    'chat.send': { en: 'Send', zh: '发送', ja: '送信', ko: '보내기', fa: 'ارسال', de: 'Senden', fr: 'Envoyer', es: 'Enviar', it: 'Invia', pt: 'Enviar', ru: 'Отправить' },
    'chat.edited': { en: '(edited)', zh: '（已编辑）', ja: '（編集済み）', ko: '(수정됨)', fa: '(ویرایش شده)', de: '(bearbeitet)', fr: '(modifié)', es: '(editado)', it: '(modificato)', pt: '(editado)', ru: '(изменено)' },
    'chat.welcome2': { en: 'How can we help you? Send us a message.', zh: '有什么可以帮您？请给我们留言。', ja: 'どのようなご用件ですか？メッセージを送ってください。', ko: '무엇을 도와드릴까요? 메시지를 보내주세요.', fa: 'چگونه می‌توانیم کمک کنیم؟ پیام بفرستید.', de: 'Wie können wir helfen? Senden Sie uns eine Nachricht.', fr: 'Comment pouvons-nous vous aider ? Envoyez-nous un message.', es: '¿Cómo podemos ayudarte? Envíanos un mensaje.', it: 'Come possiamo aiutarti? Inviaci un messaggio.', pt: 'Como podemos ajudar? Envie-nos uma mensagem.', ru: 'Чем можем помочь? Напишите нам.' },

    /* ---- identity verification ---- */
    'auth.title': { en: 'Identity Verification', zh: '身份认证', ja: '本人確認', ko: '신원 인증', fa: 'احراز هویت', de: 'Identitätsprüfung', fr: 'Vérification d\'identité', es: 'Verificación de identidad', it: 'Verifica identità', pt: 'Verificação de identidade', ru: 'Подтверждение личности' },
    'auth.subtitle': { en: 'Please upload a clear photo of the front of your ID', zh: '请上传身份证正面清晰照片', ja: '身分証の表面の写真をアップロードしてください', ko: '신분증 앞면 사진을 업로드하세요', fa: 'لطفاً عکس واضح از روی کارت شناسایی بارگذاری کنید', de: 'Bitte laden Sie ein klares Foto der Vorderseite Ihres Ausweises hoch', fr: 'Téléchargez une photo claire du recto de votre pièce d\'identité', es: 'Sube una foto clara del frente de tu identificación', it: 'Carica una foto nitida del fronte del tuo documento', pt: 'Envie uma foto nítida da frente do seu documento', ru: 'Загрузите чёткое фото лицевой стороны документа' },
    'auth.fullName': { en: 'Full Name', zh: '姓名', ja: '氏名', ko: '성명', fa: 'نام کامل', de: 'Vollständiger Name', fr: 'Nom complet', es: 'Nombre completo', it: 'Nome completo', pt: 'Nome completo', ru: 'Полное имя' },
    'auth.email': { en: 'Email', zh: '邮箱', ja: 'メール', ko: '이메일', fa: 'ایمیل', de: 'E-Mail', fr: 'E-mail', es: 'Correo electrónico', it: 'Email', pt: 'E-mail', ru: 'Эл. почта' },
    'auth.idNumber': { en: 'ID Number', zh: '身份证号', ja: '身分証番号', ko: '주민등록번호', fa: 'شماره شناسنامه', de: 'Ausweisnummer', fr: 'Numéro d\'identité', es: 'Número de ID', it: 'Numero documento', pt: 'Número do documento', ru: 'Номер документа' },
    'auth.phoneNumber': { en: 'Phone Number', zh: '手机号码', ja: '電話番号', ko: '휴대폰 번호', fa: 'شماره تلفن', de: 'Telefonnummer', fr: 'Numéro de téléphone', es: 'Número de teléfono', it: 'Numero di telefono', pt: 'Número de telefone', ru: 'Номер телефона' },
    'auth.idFront': { en: 'ID Photo - Front Side', zh: '身份证正面照', ja: '身分証 - 表面', ko: '신분증 앞면 사진', fa: 'عکس جلوی کارت', de: 'Ausweis - Vorderseite', fr: 'Photo pièce d\'identité - Recto', es: 'Foto de ID - Frente', it: 'Documento - Fronte', pt: 'Documento - Frente', ru: 'Документ - Лицевая сторона' },
    'auth.idBack': { en: 'ID Photo - Back Side', zh: '身份证背面照', ja: '身分証 - 裏面', ko: '신분증 뒷면 사진', fa: 'عکس پشت کارت', de: 'Ausweis - Rückseite', fr: 'Photo pièce d\'identité - Verso', es: 'Foto de ID - Reverso', it: 'Documento - Retro', pt: 'Documento - Verso', ru: 'Документ - Обратная сторона' },
    'auth.clickUploadFront': { en: 'Click to upload front of ID', zh: '点击上传身份证正面', ja: '身分証の表面をアップロード', ko: '신분증 앞면 업로드', fa: 'برای بارگذاری جلوی کارت کلیک کنید', de: 'Vorderseite hochladen', fr: 'Télécharger le recto', es: 'Subir el frente', it: 'Carica il fronte', pt: 'Enviar a frente', ru: 'Загрузить лицевую сторону' },
    'auth.clickUploadBack': { en: 'Click to upload back of ID', zh: '点击上传身份证背面', ja: '身分証の裏面をアップロード', ko: '신분증 뒷면 업로드', fa: 'برای بارگذاری پشت کارت کلیک کنید', de: 'Rückseite hochladen', fr: 'Télécharger le verso', es: 'Subir el reverso', it: 'Carica il retro', pt: 'Enviar o verso', ru: 'Загрузить обратную сторону' },
    'auth.changePhoto': { en: 'Change photo', zh: '更换照片', ja: '写真を変更', ko: '사진 변경', fa: 'تغییر عکس', de: 'Foto ändern', fr: 'Changer de photo', es: 'Cambiar foto', it: 'Cambia foto', pt: 'Alterar foto', ru: 'Изменить фото' },
    'auth.clickUpload': { en: 'Click to upload', zh: '点击上传', ja: 'クリックしてアップロード', ko: '클릭하여 업로드', fa: 'برای بارگذاری کلیک کنید', de: 'Klicken zum Hochladen', fr: 'Cliquez pour télécharger', es: 'Clic para subir', it: 'Clicca per caricare', pt: 'Clique para enviar', ru: 'Нажмите, чтобы загрузить' },
    'auth.underReview': { en: 'Under Review', zh: '审核中', ja: '審査中', ko: '검토 중', fa: 'در حال بررسی', de: 'In Prüfung', fr: 'En cours d\'examen', es: 'En revisión', it: 'In revisione', pt: 'Em análise', ru: 'На проверке' },
    'auth.pendingText': { en: 'Your verification has been submitted and is waiting for review.', zh: '您的认证申请已提交，正在等待审核。', ja: '本人確認は提出済みです。審査をお待ちください。', ko: '인증 신청이 제출되었으며 검토를 기다리고 있습니다.', fa: 'درخواست احراز هویت شما ثبت شده و در انتظار بررسی است.', de: 'Ihre Verifizierung wurde eingereicht und wartet auf Prüfung.', fr: 'Votre vérification a été soumise et attend l\'examen.', es: 'Tu verificación fue enviada y está en revisión.', it: 'La tua verifica è stata inviata ed è in attesa di revisione.', pt: 'Sua verificação foi enviada e aguarda análise.', ru: 'Ваша верификация отправлена и ожидает проверки.' },
    'auth.verified': { en: 'Verified', zh: '已认证', ja: '認証済み', ko: '인증 완료', fa: 'تأیید شده', de: 'Verifiziert', fr: 'Vérifié', es: 'Verificado', it: 'Verificato', pt: 'Verificado', ru: 'Подтверждено' },
    'auth.approvedText': { en: 'Your identity has been approved.', zh: '您的身份认证已通过。', ja: '本人確認が承認されました。', ko: '신원 인증이 승인되었습니다.', fa: 'هویت شما تأیید شده است.', de: 'Ihre Identität wurde bestätigt.', fr: 'Votre identité a été approuvée.', es: 'Tu identidad fue aprobada.', it: 'La tua identità è stata approvata.', pt: 'Sua identidade foi aprovada.', ru: 'Ваша личность подтверждена.' },
    'auth.fullNamePh': { en: 'Please enter your full name', zh: '请输入您的姓名', ja: '氏名を入力してください', ko: '성명을 입력하세요', fa: 'نام کامل خود را وارد کنید', de: 'Bitte geben Sie Ihren vollständigen Namen ein', fr: 'Entrez votre nom complet', es: 'Ingrese su nombre completo', it: 'Inserisci il tuo nome completo', pt: 'Digite seu nome completo', ru: 'Введите полное имя' },
    'auth.emailPh': { en: 'Please enter your email', zh: '请输入您的邮箱', ja: 'メールアドレスを入力してください', ko: '이메일을 입력하세요', fa: 'ایمیل خود را وارد کنید', de: 'Bitte geben Sie Ihre E-Mail ein', fr: 'Entrez votre e-mail', es: 'Ingrese su correo electrónico', it: 'Inserisci la tua email', pt: 'Digite seu e-mail', ru: 'Введите эл. почту' },
    'auth.idNumberPh': { en: 'Please enter your ID number', zh: '请输入您的身份证号', ja: '身分証番号を入力してください', ko: '주민등록번호를 입력하세요', fa: 'شماره شناسنامه را وارد کنید', de: 'Bitte geben Sie Ihre Ausweisnummer ein', fr: 'Entrez votre numéro d\'identité', es: 'Ingrese su número de ID', it: 'Inserisci il tuo numero documento', pt: 'Digite o número do seu documento', ru: 'Введите номер документа' },
    'auth.phonePh': { en: 'Please enter your phone number', zh: '请输入您的手机号码', ja: '電話番号を入力してください', ko: '휴대폰 번호를 입력하세요', fa: 'شماره تلفن خود را وارد کنید', de: 'Bitte geben Sie Ihre Telefonnummer ein', fr: 'Entrez votre numéro de téléphone', es: 'Ingrese su número de teléfono', it: 'Inserisci il tuo numero di telefono', pt: 'Digite seu número de telefone', ru: 'Введите номер телефона' },
    'auth.reviewHint': { en: 'After submission our team will review your documents and approve or reject them.', zh: '提交后我们的团队将审核您的证件并做出批准或拒绝的决定。', ja: '提出後、担当チームが書類を審査し、承認または却下します。', ko: '제출 후 담당 팀이 서류를 검토하여 승인 또는 거절합니다.', fa: 'پس از ارسال، تیم ما مدارک شما را بررسی کرده و تأیید یا رد می‌کند.', de: 'Nach dem Absenden prüft unser Team Ihre Dokumente und stimmt zu oder lehnt ab.', fr: 'Après soumission, notre équipe examinera vos documents et les approuvera ou les rejettera.', es: 'Tras el envío, nuestro equipo revisará tus documentos y los aprobará o rechazará.', it: 'Dopo l\'invio, il nostro team esaminerà i tuoi documenti e li approverà o rifiuterà.', pt: 'Após o envio, nossa equipe revisará seus documentos e os aprovará ou rejeitará.', ru: 'После отправки наша команда проверит ваши документы и одобрит или отклонит их.' },

    /* ---- advanced auth ---- */
    'adv.title': { en: 'Advanced Authentication', zh: '高级认证', ja: '高度な本人確認', ko: '고급 인증', fa: 'احراز هویت پیشرفته', de: 'Erweiterte Verifizierung', fr: 'Authentification avancée', es: 'Autenticación avanzada', it: 'Verifica avanzata', pt: 'Autenticação avançada', ru: 'Расширенная верификация' },
    'adv.subtitle': { en: 'Please upload handheld ID photo', zh: '请上传手持身份证照片', ja: '身分証を手に持った写真をアップロード', ko: '신분증을 든 사진을 업로드하세요', fa: 'لطفاً عکس همراه با کارت شناسایی بارگذاری کنید', de: 'Bitte laden Sie ein Foto mit Ausweis in der Hand hoch', fr: 'Téléchargez une photo avec votre pièce d\'identité en main', es: 'Sube una foto sosteniendo tu identificación', it: 'Carica una foto con il documento in mano', pt: 'Envie uma foto segurando seu documento', ru: 'Загрузите фото с документом в руке' },
    'adv.handheld': { en: 'Handheld ID Photo', zh: '手持身份证照片', ja: '身分証を持った写真', ko: '신분증 촬영 사진', fa: 'عکس همراه با کارت', de: 'Ausweisfoto in der Hand', fr: 'Photo avec pièce d\'identité', es: 'Foto con identificación', it: 'Foto con documento', pt: 'Foto segurando documento', ru: 'Фото с документом' },
    'adv.clickUpload': { en: 'Click to upload handheld ID photo', zh: '点击上传手持身份证照片', ja: '手持ちの身分証写真をアップロード', ko: '신분증을 든 사진 업로드', fa: 'برای بارگذاری عکس کلیک کنید', de: 'Foto hochladen', fr: 'Télécharger la photo', es: 'Subir la foto', it: 'Carica la foto', pt: 'Enviar a foto', ru: 'Загрузить фото' },
    'adv.hint': { en: 'Please hold your ID card and take a clear photo', zh: '请手持身份证拍一张清晰的照片', ja: '身分証を持って鮮明な写真を撮ってください', ko: '신분증을 들고 선명한 사진을 찍으세요', fa: 'لطفاً کارت شناسایی را در دست بگیرید و عکس واضح بگیرید', de: 'Halten Sie Ihren Ausweis und machen Sie ein klares Foto', fr: 'Tenez votre pièce d\'identité et prenez une photo claire', es: 'Sostén tu identificación y toma una foto clara', it: 'Tieni il documento in mano e scatta una foto nitida', pt: 'Segure seu documento e tire uma foto nítida', ru: 'Держите документ и сделайте чёткое фото' },

    /* ---- change password ---- */
    'cp.title': { en: 'Change Password', zh: '修改密码', ja: 'パスワード変更', ko: '비밀번호 변경', fa: 'تغییر رمز عبور', de: 'Passwort ändern', fr: 'Changer le mot de passe', es: 'Cambiar contraseña', it: 'Cambia password', pt: 'Alterar senha', ru: 'Сменить пароль' },
    'cp.current': { en: 'Current Password', zh: '当前密码', ja: '現在のパスワード', ko: '현재 비밀번호', fa: 'رمز عبور فعلی', de: 'Aktuelles Passwort', fr: 'Mot de passe actuel', es: 'Contraseña actual', it: 'Password attuale', pt: 'Senha atual', ru: 'Текущий пароль' },
    'cp.new': { en: 'New Password (at least 6 characters)', zh: '新密码（至少6个字符）', ja: '新しいパスワード（6文字以上）', ko: '새 비밀번호(6자 이상)', fa: 'رمز عبور جدید (حداقل ۶ کاراکتر)', de: 'Neues Passwort (mind. 6 Zeichen)', fr: 'Nouveau mot de passe (6 caractères min.)', es: 'Nueva contraseña (mínimo 6 caracteres)', it: 'Nuova password (minimo 6 caratteri)', pt: 'Nova senha (mínimo 6 caracteres)', ru: 'Новый пароль (минимум 6 символов)' },
    'cp.confirm': { en: 'Confirm New Password', zh: '确认新密码', ja: '新しいパスワード確認', ko: '새 비밀번호 확인', fa: 'تکرار رمز عبور جدید', de: 'Neues Passwort bestätigen', fr: 'Confirmer le nouveau mot de passe', es: 'Confirmar nueva contraseña', it: 'Conferma nuova password', pt: 'Confirmar nova senha', ru: 'Подтвердите новый пароль' },
    'cp.confirmBtn': { en: 'Confirm', zh: '确认', ja: '確定', ko: '확인', fa: 'تأیید', de: 'Bestätigen', fr: 'Confirmer', es: 'Confirmar', it: 'Conferma', pt: 'Confirmar', ru: 'Подтвердить' },
    'cp.backToAccount': { en: 'Back to Account', zh: '返回账户', ja: 'アカウントへ戻る', ko: '계정으로 돌아가기', fa: 'بازگشت به حساب', de: 'Zurück zum Konto', fr: 'Retour au compte', es: 'Volver a la cuenta', it: 'Torna al conto', pt: 'Voltar à conta', ru: 'Вернуться в аккаунт' }
  };

  var _lang = null;

  function langLabel(code) {
    return (LANGS && LANGS[code]) || 'English';
  }

  function getLang() {
    if (_lang && LANGS[_lang]) return _lang;
    var c = 'en';
    try { if (getConfig().defaultLanguage) c = getConfig().defaultLanguage; } catch (e) {}
    var dbLang = null;
    try { if (dbActive() && DB.getSetting) dbLang = DB.getSetting('language'); } catch (e) {}
    if (dbLang && LANGS[dbLang]) return dbLang;
    return langLabel(c);
  }

  function setLang(el, label) {
    if (!LANGS[label]) label = 'English';
    _lang = label;
    if (dbActive()) {
      try {
        if (_session && _session.uid != null && !_session.is_guest) DB.setUserLanguage(_session.uid, label).catch(function () {});
        var tok = getToken();
        if (tok) DB.updateSession(tok, { language: label }).catch(function () {});
      } catch (e) {}
    }
    applyI18n();
    var menu = document.getElementById('langMenu');
    if (menu) menu.style.display = 'none';
  }

  function t(key) {
    var e = I18N[key];
    if (!e) return '';
    var v = e[LANGS[getLang()]];
    return (v != null && v !== '') ? v : (e.en || '');
  }

  function applyI18n() {
    var lang = getLang();
    var btn = document.querySelector('.language-btn');
    if (btn) {
      var chevron = btn.querySelector('svg');
      var label = lang + ' ';
      while (btn.firstChild) btn.removeChild(btn.firstChild);
      btn.appendChild(document.createTextNode(label));
      if (chevron) btn.appendChild(chevron);
    }
    document.querySelectorAll('.language-option').forEach(function (o) {
      o.classList.toggle('active', o.textContent.trim() === lang);
    });
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var v = t(el.getAttribute('data-i18n'));
      if (v) el.textContent = v;
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
      var v = t(el.getAttribute('data-i18n-ph'));
      if (v) el.setAttribute('placeholder', v);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    try { applyI18n(); } catch (e) {}
  });

  function toggleLang() {
    var m = document.getElementById('langMenu');
    if (m) m.style.display = m.style.display === 'none' ? 'block' : 'none';
  }

  function getUserId() {
    return (_session && _session.uid != null) ? String(_session.uid) : null;
  }

  function isLoggedIn() {
    // Anyone with a DB identity counts as logged in, including guest rows
    // created by wallet-login / service chat (they register to become accounts).
    return !!(_session && _session.uid != null);
  }

  function updateMenuUser() {
    var idEl = document.querySelector('.menu-id');
    if (!idEl) return;
    var uid = getUserId();
    idEl.textContent = 'ID: ' + (uid || 'Not Logged In');
    // Admin button in the side menu: show whenever the current user has
    // admin access (session.admin flag OR users.is_admin), refreshed on every
    // session restore / DB-ready / realtime user event.
    var adminItem = document.getElementById('menuAdmin');
    if (adminItem) {
      adminItem.style.display = isCurrentUserAdmin() ? '' : 'none';
    }
    var vipArea = document.querySelector('.vip-area');
    if (vipArea) {
      try {
        if (uid && guessVip) {
          var v = guessVip(uid);
          if (v && v.color && v.label) {
            vipArea.innerHTML = '<span class="vip-badge-inline" style="display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;background:' + v.color + '1a;color:' + v.color + ';font-weight:700;font-size:12.5px;border:1px solid ' + v.color + '55;">'
              + '<svg width="14" height="14" viewBox="0 0 24 24" fill="' + v.color + '"><path d="M12 15l-5.5 3 1.5-6L2.5 7l6-.5L12 1l3.5 5.5 6 .5-5.5 5 1.5 6z"/></svg>'
              + v.label + '</span>';
          }
        } else if (vipArea.querySelector('.vip-label')) {
          vipArea.innerHTML = '<span class="vip-label">' + (t('menu.function') || 'Function') + '</span>';
        }
      } catch (e) {}
    }
    // Update wallet balance display in header
    var walletBtn = document.getElementById('walletBtn');
    var walletBalance = document.getElementById('walletBalance');
    var walletBalanceAmount = document.getElementById('walletBalanceAmount');
    if (walletBtn && walletBalance && walletBalanceAmount) {
      if (uid) {
        var b = TrustApp.getBalances ? TrustApp.getBalances(uid) : {};
        var total = 0;
        Object.keys(b).forEach(function (c) {
          var bal = parseFloat(b[c]) || 0;
          if (c === 'USDT') total += bal;
          else {
            var d = TrustApp.findCoin ? TrustApp.findCoin(c) : null;
            var price = d ? (parseFloat(d.price) || 0) : 0;
            total += bal * price;
          }
        });
        walletBalanceAmount.textContent = '$ ' + total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        walletBtn.style.display = 'none';
        walletBalance.style.display = 'flex';
      } else if (getToken()) {
        // Session cookie exists but the DB restore is still resolving: show the
        // balance slot in a loading state instead of flashing "Connect Wallet",
        // so returning/logged-in users never see the connect button.
        walletBalanceAmount.textContent = '$ ...';
        walletBtn.style.display = 'none';
        walletBalance.style.display = 'flex';
      } else {
        walletBtn.style.display = 'flex';
        walletBalance.style.display = 'none';
      }
    }
  }

  /* ---- session layer (DB sessions table + small cookie) ---- */
  var _session = null; // { token, uid, is_guest, admin, language }

  function getToken() {
    try {
      var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + SESSION_COOKIE + '=([^;]+)'));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }

  function setToken(t) {
    try {
      var exp = new Date(Date.now() + 30 * 24 * 3600000).toUTCString();
      document.cookie = SESSION_COOKIE + '=' + encodeURIComponent(t) + '; expires=' + exp + '; path=/; SameSite=Lax';
    } catch (e) {}
  }

  function clearToken() {
    try { document.cookie = SESSION_COOKIE + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax'; } catch (e) {}
  }

  function rndToken() {
    var c = '0123456789abcdef';
    var s = '';
    for (var i = 0; i < 32; i++) s += c[Math.floor(Math.random() * 16)];
    return s;
  }

  // Resolve the current session from the database. Waits for the DB when
  // it has not connected yet. A slow/cold Supabase read must NOT be treated
  // as "logged out": the page guard would then bounce a freshly-logged-in
  // user back to the login screen. So transient lookup failures are retried
  // before we give up and report "no session".
  function restoreSession() {
    function getSessionWithRetry(tok, tries) {
      var timeout = new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('getSession timeout')); }, 5000);
      });
      return Promise.race([DB.getSession(tok), timeout]).then(function (s) {
        if (!s) { _session = null; return null; }
        _session = {
          token: tok,
          uid: s.uid == null ? null : s.uid,
          is_guest: !!s.is_guest,
          admin: !!s.admin,
          language: s.language || null
        };
        if (_session.language && LANGS[_session.language]) _lang = _session.language;
        if (_session.uid != null && !_session.is_guest) {
          try {
            var dl = DB.getUserLanguage(_session.uid);
            if (dl && LANGS[dl]) _lang = dl;
          } catch (e) {}
        }
        return _session;
      }).catch(function () {
        if (tries > 0) {
          return new Promise(function (res) {
            setTimeout(function () { res(getSessionWithRetry(tok, tries - 1)); }, 1500);
          });
        }
        return _session || null;
      });
    }
    function doRestore() {
      // Backend v2: the credential is Supabase Auth's JWT, persisted by
      // supabase-js under its own storage key. The cookie read here is a v1
      // leftover and is NOT written by every v2 sign-in path.
      //
      // The old code returned null immediately when that cookie was missing,
      // without ever asking the database. Since the cookie is no longer the
      // credential, a perfectly valid Supabase session was reported as "no
      // session" and guardAuth bounced the user to the login page. Ask the DB
      // first and treat the cookie as optional.
      var tok = getToken();
      if (!dbActive()) return Promise.resolve(_session || null);
      return getSessionWithRetry(tok, 3);
    }
    if (dbActive()) return doRestore();
    return new Promise(function (res) {
      if (typeof DB !== 'undefined' && DB.onReady) DB.onReady(function () { res(doRestore()); });
      else res(doRestore());
    });
  }

  // Make sure a session row exists for the current cookie.
  function _ensureSessionRow() {
    var tok = getToken();
    var lang = _lang || langLabel('en');
    if (!tok) {
      tok = rndToken();
      setToken(tok);
      return DB.createSession(tok, null, { language: lang }).then(function () {
        _session = { token: tok, uid: null, is_guest: false, admin: false, language: lang };
        return _session;
      }).catch(function () {
        _session = { token: tok, uid: null, is_guest: false, admin: false, language: lang };
        return _session;
      });
    }
    return restoreSession().then(function (s) {
      if (s) return s;
      return DB.createSession(tok, null, { language: lang }).then(function () {
        _session = { token: tok, uid: null, is_guest: false, admin: false, language: lang };
        return _session;
      });
    });
  }

  function _activateSession(uid, isGuest, admin, language) {
    var tok = getToken();
    var applyLocal = function (t, p) {
      _session = { token: t, uid: uid == null ? null : uid, is_guest: !!isGuest, admin: !!admin, language: language || null };
      if (language && LANGS[language]) _lang = language;
      return p;
    };
    if (tok) {
      return applyLocal(tok, DB.updateSession(tok, {
        uid: uid == null ? null : uid, is_guest: !!isGuest, admin: !!admin, language: language || null
      }).then(function () { return _session; }));
    }
    tok = rndToken();
    setToken(tok);
    return applyLocal(tok, DB.createSession(tok, uid, {
      is_guest: !!isGuest, admin: !!admin, language: language || null
    }).then(function () { return _session; }));
  }

  function _clearSession() {
    var tok = getToken();
    _session = null;
    if (tok && dbActive()) DB.deleteSession(tok).catch(function () {});
    clearToken();
  }

  // service.html: ensure a usable identity (guest user row when not logged in).
  function ensureGuest() {
    var uid = getUserId();
    if (uid && _session && _session.uid != null) return Promise.resolve(uid);
    // v2 has no guest accounts. A signed-out visitor cannot be handed a
    // usable identity: the old path minted a row in the browser, which is
    // exactly the hole v2 closed. Reject so the caller can ask for sign-in.
    return Promise.reject(new Error('Please sign in to continue'));
  }

  function currentUser() {
    var uid = getUserId();
    if (!uid) return null;
    try {
      if (dbActive()) {
        var u = DB.getUserStr(uid);
        return u ? dbUserToApp(u) : null;
      }
    } catch (e) {}
    return null;
  }

  var USERS_KEY = 'trustUsers';

  function dbActive() {
    return typeof DB !== 'undefined' && DB && DB.connected === true;
  }

  // Resolve once the data layer has finished booting, instead of refusing
  // immediately when it has not. Bootstrap downloads the Supabase client, so a
  // click in the first second used to land before connected was true and was
  // rejected as "Database not configured" even though the backend was fine.
  //
  // The timeout is the important part: this must never leave a caller hanging,
  // because login() and register() sit directly on top of it and a hang there
  // freezes the submit button with no way back for the user.
  function whenDbReady(ms) {
    if (dbActive()) return Promise.resolve(true);
    if (typeof DB === 'undefined' || !DB || !DB.ready) return Promise.resolve(false);
    return new Promise(function (resolve) {
      var settled = false;
      function finish(v) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }
      var timer = setTimeout(function () { finish(false); }, ms || 25000);
      try {
        DB.ready().then(function () { finish(true); }, function () { finish(false); });
      } catch (e) { finish(false); }
    });
  }

  // Read-only variant: cache is usable as soon as ANY snapshot is present
  // (localStorage mirror seed at init, or a table that arrived mid-bootstrap),
  // so pages paint instantly instead of waiting for the full bootstrap.
  function dbReadable() {
    if (dbActive()) return true;
    if (typeof DB !== 'undefined' && DB && DB._cache) {
      try {
        var c = DB._cache;
        return Boolean(
          (c.users && c.users.length) ||
          Object.keys(c.userBalances || {}).length ||
          (c.aiOrders && c.aiOrders.length) ||
          (c.loans && c.loans.length) ||
          (c.transactions && c.transactions.length) ||
          (c.chatMessages && Object.keys(c.chatMessages).length) ||
          Object.keys(c.adminSettings || {}).length
        );
      } catch (e) {}
    }
    return false;
  }

  function dbUserToApp(u) {
    return {
      uid: u.uid,
      account: u.account,
      password: u.password_hash,
      password_hash: u.password_hash,
      email: u.email,
      phone: u.phone,
      createdAt: u.created_at,
      created_at: u.created_at,
      updatedAt: u.updated_at,
      status: u.status || 'active',
      is_admin: !!u.is_admin,
      role: u.is_admin ? 'admin' : undefined,
      isAdmin: u.is_admin ? true : undefined,
      referral_code: u.referral_code,
      referred_by: u.referred_by,
      // Six-digit public member number, assigned by the prepare_user() trigger
      // in supabase/v2/11_uid_code.sql. This is the handle shown to the user
      // and on admin screens; `uid` stays the internal uuid identity.
      uid_code: u.uid_code || null,
      uidCode: u.uid_code || null,
      language: u.language || 'en',
      profitMode: !!u.profit_mode,
      greeted: !!u.greeted,
      isGuest: !!u.is_guest
    };
  }

  function dbTxnToApp(t) {
    var dir = 'credit';
    var desc = t.description || '';
    var dirm = /^\[(debit|credit)\]\s*/.exec(desc);
    if (dirm) dir = dirm[1];
    var acct = '';
    try {
      if (dbActive() && t.uid != null && DB.getUserStr) {
        var u = DB.getUserStr(t.uid);
        if (u) acct = u.account || '';
      }
    } catch (e) {}
    var note = desc.replace(/^\[(debit|credit)\]\s*/, '');
    var proof = t.proof || '';
    var proofName = t.proof_name || t.proofName || '';
    var am = /\[PROOF_ATTACHMENT\]([\s\S]*)$/.exec(note);
    if (!proof && am) {
      note = note.slice(0, am.index);
      try {
        var att = JSON.parse(am[1]);
        if (att && att.data) { proof = att.data; proofName = att.name || 'proof'; }
      } catch (e) {}
    }
    return {
      id: String(t.id),
      uid: t.uid,
      account: acct || t.account || '',
      type: t.type || 'deposit',
      coin: t.coin || 'USDT',
      amount: parseFloat(t.amount) || 0,
      status: t.status || 'completed',
      note: note,
      proof: proof,
      proof_name: proofName,
      proofName: proofName,
      createdAt: t.created_at,
      created_at: t.created_at,
      dir: dir,
      db: true
    };
  }

  function dbLoanToApp(l) {
    return {
      id: l.id,
      uid: l.uid,
      account: l.account || '',
      amount: parseFloat(l.amount) || 0,
      days: parseInt(l.days, 10) || 0,
      rate: parseFloat(l.rate) || 0,
      interest: parseFloat(l.interest) || 0,
      status: l.status || 'pending',
      createdAt: l.created_at,
      created_at: l.created_at
    };
  }

  function dbTradeToApp(t) {
    return {
      id: String(t.id),
      uid: t.uid,
      pair: t.pair || '',
      side: t.side || 'up',
      amount: parseFloat(t.amount) || 0,
      price: parseFloat(t.price) || 0,
      fee: parseFloat(t.fee) || 0,
      user: t.account || t.uid || '',
      createdAt: t.opened_at || t.created_at,
      created_at: t.opened_at || t.created_at,
      status: t.status || 'open',
      duration: parseInt(t.duration, 10) || 0,
      sellPrice: t.sell_price == null ? null : parseFloat(t.sell_price),
      settledAt: t.settled_at || null,
      profit: parseFloat(t.profit) || 0
    };
  }

  function dbAiOrderToApp(o) {
    var scheds = o.schedules;
    if (typeof scheds === 'string') {
      try { scheds = JSON.parse(scheds); } catch (e) { scheds = []; }
    }
    return {
      id: String(o.id),
      uid: o.uid,
      account: o.account || o.uid || '',
      productId: 1,
      product: o.product || (o.symbol || 'AI Quant'),
      period: parseInt(o.period, 10) || 7,
      rateMin: parseFloat(o.rate_min) || 0,
      rateMax: parseFloat(o.rate_max) || 0,
      amount: parseFloat(o.amount) || 0,
      principal: o.principal != null ? parseFloat(o.principal) : (parseFloat(o.amount) || 0),
      profit: parseFloat(o.profit) || 0,
      settledDays: parseInt(o.settled_days, 10) || 0,
      status: o.status || 'pending',
      startAt: o.start_at || null,
      endAt: o.end_at || null,
      createdAt: o.created_at,
      created_at: o.created_at,
      schedules: scheds || []
    };
  }

  function dbChatToApp(m) {
    var atts = null;
    if (m.attachments) {
      try { atts = typeof m.attachments === 'string' ? JSON.parse(m.attachments) : m.attachments; } catch (e) { atts = null; }
    }
    var text = m.message || '';
    if (!atts && /\[CHAT_ATTACHMENTS\]/.test(text)) {
      var i = text.indexOf('[CHAT_ATTACHMENTS]');
      try {
        var a = JSON.parse(text.slice(i + '[CHAT_ATTACHMENTS]'.length));
        if (Array.isArray(a)) atts = a;
        text = text.slice(0, i).replace(/\n+$/, '');
      } catch (e) {}
    }
    return {
      mid: String(m.id),
      from: m.from_role === 'admin' ? 'admin' : 'user',
      text: text,
      at: m.created_at,
      seen: !!m.read_at,
      deleted: !!m.deleted,
      editedAt: m.edited_at || null,
      attachments: atts || []
    };
  }

  function dbVerToApp(v) {
    return {
      uid: v.uid,
      name: v.name || '',
      email: v.email || '',
      idNumber: v.id_number || '',
      phone: v.phone || '',
      idFront: v.id_front || '',
      idBack: v.id_back || '',
      status: v.status || 'pending',
      submittedAt: v.submitted_at || null,
      reviewedAt: v.reviewed_at || null,
      note: v.rejection_reason || '',
      advanced: v.advanced || '',
      advancedStatus: v.advanced_status || null,
      advancedSubmittedAt: v.advanced_submitted_at || null,
      advancedReviewedAt: v.advanced_reviewed_at || null,
      advancedNote: v.advanced_note || ''
    };
  }

  function getUsers() {
    if (dbReadable()) {
      try {
        // Admin/user lists exclude anonymous guest blocks (account = guest_*)
        // but MUST include wallet-login accounts (created with is_guest flag).
        return (DB.getUsers() || []).filter(function (u) {
          return !u.is_guest || !/^guest_/i.test(String(u.account || ''));
        }).map(dbUserToApp);
      } catch (e) {}
    }
    return [];
  }

  // No local persistence: data lives in Supabase. Kept as a no-op so callers
  // that previously flushed a localStorage snapshot keep working.
  function saveUsers(users) { return users; }

  function genUid(users) {
    var used = {};
    users.forEach(function (u) { used[u.uid] = true; });
    var uid;
    do { uid = String(Math.floor(100000 + Math.random() * 900000)); } while (used[uid]);
    return uid;
  }

  function register(account, password, referralCode, accountType) {
    account = trim(account);
    if (!account || !password) return Promise.resolve({ ok: false, msg: 'Please fill in all fields' });
    if (typeof DB === 'undefined' || !DB.register) {
      return Promise.resolve({ ok: false, msg: 'Database not configured' });
    }
    var lang = getLang();
    // v1 converted a guest row into a real account here, hashing the password
    // in the browser. v2 has no client-created accounts and no browser-side
    // hashing, and GoTrue will not re-key an existing identity, so the
    // conversion is gone: every account is created through Supabase Auth.
    //
    // accountType is 'phone' or 'email'. The register form has a Phone/Email
    // toggle, so the value alone cannot be classified reliably -- '+1 555
    // 0100' and 'user@x.com' need to be told apart by the tab the user picked,
    // not guessed, or an address containing a dot would be read as a phone.
    return whenDbReady().then(function (ready) {
      if (!ready) return { ok: false, msg: 'Database not configured. Check your connection and reload.' };
      return DB.register(account, password, null, accountType);
    }).then(function (res) {
      if (res.ok && res.user) {
        var user = res.user;
        var code = trim(referralCode || '');
        if (code) {
          var inv = DB.getUserByReferralCode ? DB.getUserByReferralCode(code) : null;
          return Promise.resolve(inv).then(function (inviter) {
            if (!inviter) return { ok: false, msg: 'Invalid referral code' };
            user.referredBy = inviter.uid;
            return DB.addBalance(user.uid, 'USDT', 5).then(function () {
              return DB.addBalance(inviter.uid, 'USDT', 5).then(function () {
                return { ok: true, user: user };
              });
            });
          });
        }
        return { ok: true, user: user };
      }
      return res;
    }).then(function (res) {
      if (res.ok && res.user) {
        _notifyChange('users');
        return _activateSession(res.user.uid, false, !!res.user.is_admin, lang).then(function () { return res; });
      }
      return res;
    }).catch(function (e) { return { ok: false, msg: e.message }; });
    // Always a Promise. Returning a plain object made callers do
    // result.then(...), which threw "then is not a function" and left the
    // Register button disabled on "Registering..." forever -- the catch never
    // ran because the throw happened at the call site, not inside the chain.
  }

  function login(account, password) {
    account = trim(account);
    if (!account || !password) return Promise.resolve({ ok: false, msg: 'Please enter account and password' });
    if (typeof DB === 'undefined' || !DB.login) {
      return Promise.resolve({ ok: false, msg: 'Database not configured' });
    }
    var lang = getLang();
    return whenDbReady().then(function (ok) {
      if (!ok) return { ok: false, msg: 'Database not configured. Check your connection and reload.' };
      return DB.login(account, password).then(function (res) {
        if (res.ok && res.user) {
          return _activateSession(res.user.uid, false, !!res.user.is_admin, lang).then(function () {
            try { if (DB.getUserLanguage) { var dl = DB.getUserLanguage(res.user.uid); if (dl && LANGS[dl]) _lang = dl; } } catch (e) {}
            return { ok: true, user: res.user };
          });
        }
        return res;
      });
    }).catch(function (e) { return { ok: false, msg: e.message }; });
  }

  function walletLogin(address) {
    if (!address) return { ok: false, msg: 'Invalid wallet address' };
    // Backend v2 removed client-side account creation. GoTrue issues identities
    // itself, and it will not mint a session for a bare wallet address: that
    // needs a signature check (SIWE) that has no trusted path in the browser.
    // Faking a row here would let anyone claim any address, so refuse instead.
    return Promise.resolve({ ok: false, msg: 'Wallet sign-in is not available on this build. Use email and password.' });
  }

  // The admin lock is answered ONCE per browser tab, not once per page.
  //
  // The old unlock lived in _session.admin and was pushed through
  // DB.updateSession(), but that function only persists `language` and
  // `is_guest` -- the admin flag was dropped on the floor. Navigating to
  // another admin page therefore lost the unlock and asked again.
  // sessionStorage survives same-tab navigation, which is exactly the scope
  // the lock needs: a new tab or a fresh browser session asks once more.
  var ADMIN_UNLOCK_KEY = 'trustAdminUnlocked';

  function adminUnlockedInTab() {
    try { return sessionStorage.getItem(ADMIN_UNLOCK_KEY) === '1'; } catch (e) { return false; }
  }

  function markAdminUnlockedInTab() {
    try { sessionStorage.setItem(ADMIN_UNLOCK_KEY, '1'); } catch (e) {}
  }

  function clearAdminUnlockedInTab() {
    try { sessionStorage.removeItem(ADMIN_UNLOCK_KEY); } catch (e) {}
  }

  // A user whose profile carries is_admin is never asked for the shared admin
  // password at all.
  function adminHasRealAccess() {
    if (_session && _session.admin) return true;
    try { if (isCurrentUserAdmin()) return true; } catch (e) {}
    return false;
  }

  // True only when the signed-in account's own database row carries is_admin.
  //
  // Deliberately ignores _session.admin, which the shared admin password sets
  // client-side. That flag hides the lock and nothing else: it is not in the
  // JWT and not in the database, so RLS still refuses every query. Checking it
  // here is what lets the panel explain an empty user list instead of showing
  // "No registered users yet" and implying the site has no customers.
  function isRealAdmin() {
    var uid = getUserId();
    if (!uid) return false;
    try { return isUserAdmin(uid); } catch (e) { return false; }
  }

  // One banner for every admin page, because they all call initAdminLock().
  function warnIfNotRealAdmin() {
    if (isRealAdmin()) return;
    if (document.getElementById('realAdminWarn')) return;
    if (!document.body) return;

    var el = document.createElement('div');
    el.id = 'realAdminWarn';

    var strong = document.createElement('strong');
    strong.textContent = 'Not an admin account. ';
    el.appendChild(strong);

    el.appendChild(document.createTextNode(
      'This panel is unlocked, but the signed-in account has no is_admin flag in the database, ' +
      'so row-level security makes Supabase return nothing. Every list below will look empty. ' +
      'Sign in with an account that is an admin, or grant it in the SQL editor: update public.users set is_admin = true where account = '
    ));

    var code = document.createElement('code');
    code.textContent = "'you@example.com'";
    el.appendChild(code);
    el.appendChild(document.createTextNode(';'));

    el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:100000;background:#7c2d12;color:#fff;' +
      'padding:10px 14px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center;';
    document.body.appendChild(el);
  }

  function initAdminLock() {
    var lock = document.getElementById('adminLock');
    if (!lock) return;
    try {
      // Session restore is async and the users table may not have loaded yet.
      // Deciding early would fail the is_admin check and prompt a real admin,
      // so wait for both before deciding. The lock is visible by default
      // (.admin-lock is display:flex), so this stays fail-closed: a slow or
      // failed check leaves the lock up rather than exposing the page.
      //
      // whenDbReady() can resolve while DB.connected is still false, and
      // accountByUid() returns null until the users row is cached -- so a real
      // admin can briefly look like an ordinary user. Retry a few times before
      // concluding that, rather than locking out someone who is an admin.
      var attempts = 0;
      var decide = function () {
        if (adminHasRealAccess()) { lock.style.display = 'none'; warnIfNotRealAdmin(); return; }

        var uid = getUserId();
        if (uid && attempts < 6) {
          var row = null;
          try { row = accountByUid(uid); } catch (e) {}
          if (!row) {
            attempts++;
            setTimeout(decide, 600);
            return;
          }
        }
        if (adminUnlockedInTab()) { lock.style.display = 'none'; warnIfNotRealAdmin(); return; }
        lock.style.display = 'flex';
      };
      var gate = getToken() ? restoreSession().catch(function () { return null; }) : Promise.resolve(null);
      var ready = (typeof whenDbReady === 'function') ? whenDbReady(10000).catch(function () { return false; }) : Promise.resolve(false);
      Promise.all([gate, ready]).then(decide, decide);
    } catch (e) {}
  }

  function unlockAdmin() {
    var lock = document.getElementById('adminLock');
    var input = document.getElementById('adminPassInput');
    var err = document.getElementById('adminLockErr');
    var cfg = getConfig();
    var pass = input ? input.value : '';
    if (pass === (cfg.adminPassword || 'admin123')) {
      markAdminUnlockedInTab();
      var grant = function (tok) {
        _session = _session || { token: tok, uid: null, is_guest: false, admin: false, language: null };
        _session.admin = true;
        if (tok) DB.updateSession(tok, { admin: true }).catch(function () {});
      };
      var tok = getToken();
      if (tok) {
        grant(tok);
      } else {
        tok = rndToken();
        setToken(tok);
        DB.createSession(tok, null, { language: _lang || langLabel('en') }).then(function () { grant(tok); }).catch(function () { grant(tok); });
      }
      if (lock) lock.style.display = 'none';
      if (err) err.textContent = '';
      if (input) input.value = '';
      warnIfNotRealAdmin();
    } else {
      if (err) err.textContent = 'Incorrect password';
    }
  }

  function logout() {
    _clearSession();
    closeWalletConnect();
    // Drop the tab unlock too, otherwise the next sign-in as a normal user
    // would still walk straight into the admin pages.
    clearAdminUnlockedInTab();
  }

  // Dispatch trustsync event to refresh admin pages in real-time
  function _notifyChange(table) {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try { window.dispatchEvent(new window.CustomEvent('trustsync:' + table, { detail: { source: 'local-write' } })); } catch (e) {}
    }
  }
  var TXN_KEY = 'trustTxns';
  var TRADE_KEY = 'trustTrades';
  var CHAT_KEY = 'trustChat';

  var COIN_KEYS = ['USDT', 'BTC', 'ETH', 'XRP', 'LTC', 'USDC', 'TON', 'DOGE', 'BNB', 'ADA', 'SOL', 'TRX', 'UNI', 'AVAX', 'DOT', 'LINK', 'BCH', 'BSV', 'IOTA', 'ETC', 'TUSD', 'XAU', 'XAG', 'XPD', 'XPT'];

  function getBalances(uid) {
    if (!uid) return {};
    if (dbReadable()) {
      var m = {};
      try { m = DB.getAllBalances(uid) || {}; } catch (e) {}
      var b = {};
      COIN_KEYS.forEach(function (k) { b[k] = parseFloat(m[k]) || 0; });
      return b;
    }
    var b = {};
    COIN_KEYS.forEach(function (k) { b[k] = 0; });
    return b;
  }

  function getBalance(uid, coin) {
    var b = getBalances(uid);
    return parseFloat(b[coin]) || 0;
  }

  function setBalance(uid, coin, amt) {
    amt = parseFloat(amt) || 0;
    if (dbActive()) {
      try { DB.setBalance(uid, coin, amt).catch(function () {}); } catch (e) {}
      return amt;
    }
    return amt;
  }

  function addBalance(uid, coin, delta) {
    delta = parseFloat(delta) || 0;
    if (dbActive()) {
      var next = getBalance(uid, coin) + delta;
      next = Math.max(0, next);
      return DB.addBalance(uid, coin, delta).then(function () { return next; }).catch(function () { return next; });
    }
    return Promise.resolve(Math.max(0, getBalance(uid, coin) + delta));
  }

  function getTxns() {
    if (dbReadable()) {
      try { return (DB.getTransactions() || []).map(dbTxnToApp); } catch (e) {}
    }
    return [];
  }
  function saveTxns(list) { return list; }

  function genId(prefix) {
    return prefix + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000);
  }

  // ID mapping: generated ID -> DB ID (for setTxnStatus fallback)
  var _txnIdMap = {};

// Local pending transactions (for immediate confirm before DB sync)
  var _pendingTxns = {};

function addTxn(obj) {
    var t = {
      id: genId(obj.type || 'TXN'),
      uid: obj.uid || '',
      account: obj.account || '',
      type: obj.type || 'deposit',
      coin: obj.coin || 'USDT',
      amount: Math.abs(parseFloat(obj.amount) || 0),
      status: obj.status || 'pending',
      note: obj.note || '',
      proof: obj.proof || '',
      proofName: obj.proofName || '',
      createdAt: new Date().toISOString(),
      db: false,
      dbId: null
    };
    _pendingTxns[t.id] = t;
    if (dbActive()) {
      var dir = obj.dir === 'debit' ? 'debit' : 'credit';
      var note = obj.note || '';
      var desc = '[' + dir + '] ' + (obj.account && obj.account !== obj.uid ? obj.account + ' ' : '') + note;
      DB.addTransaction({
        uid: obj.uid || null,
        type: obj.type || 'deposit',
        coin: obj.coin || 'USDT',
        amount: Math.abs(parseFloat(obj.amount) || 0),
        status: obj.status || 'pending',
        reference_id: '',
        description: desc,
        proof: obj.proof || '',
        proof_name: obj.proofName || ''
      }).then(function (row) {
        if (row && row.id) {
          _txnIdMap[t.id] = row.id;
          t.db = true;
          t.dbId = row.id;
        }
        _notifyChange('transactions');
}).catch(function () {});
    }
    return t;
  }

  function usdValue(coin) {
    if (coin === 'USDT' || coin === 'USDC' || coin === 'TUSD') return 1;
    try {
      var d = typeof findCoin === 'function' ? findCoin(coin) : null;
      return d ? (parseFloat(d.price) || 0) : 0;
    } catch (e) { return 0; }
  }

  function setTxnStatus(id, status) {
    var txns = getTxns();
    var txn = txns.find(function (t) { return String(t.id) === String(id); });
    var local = txn || _pendingTxns[id] || null;
    if (!txn && _txnIdMap[id]) {
      var realId = _txnIdMap[id];
      txn = txns.find(function (t) { return String(t.id) === String(realId); }) || txn;
    }
    if (!txn && local) txn = local;
    var wasConfirmed = txn ? txn.status === 'confirmed' : false;
    var out = {
      id: id,
      status: status,
      uid: txn ? txn.uid : null,
      coin: txn ? txn.coin : 'USDT',
      amount: txn ? txn.amount : 0,
      type: txn ? txn.type : 'deposit'
    };
    function finish() {
      if (local) local.status = status;
      _notifyChange('transactions');
      // All crediting/debiting happens here (single source of truth), so admin
      // pages never need to call addBalance after confirming.
      if (status === 'confirmed' && txn && txn.uid != null && !wasConfirmed) {
        var p = null;
        try {
          if (txn.type === 'deposit') {
            p = addBalance(txn.uid, 'USDT', (parseFloat(txn.amount) || 0) * usdValue(txn.coin));
          } else if (txn.type === 'withdraw') {
            p = addBalance(txn.uid, txn.coin, -(parseFloat(txn.amount) || 0));
          }
        } catch (e) { p = null; }
        if (p) return Promise.resolve(p).then(function () { return out; }).catch(function () { return out; });
      }
      return out;
    }
    if (dbActive()) {
      var dbId = txn && txn.db ? id : ((txn && txn.dbId) || _txnIdMap[id] || id);
      return DB.setTransactionStatus(dbId, status).then(finish).catch(function () { return out; });
    }
    return finish();
  }

  var LOAN_KEY = 'trustLoans';

  function getLoans() {
    if (dbReadable()) {
      try { return (DB.getLoans() || []).map(dbLoanToApp); } catch (e) {}
    }
    return [];
  }
  function saveLoans(list) { return list; }

  function getLoansForUser(uid) {
    if (!uid) return [];
    return getLoans().filter(function (l) { return String(l.uid) === String(uid); });
  }

  function addLoan(obj) {
    var l = {
      id: genId('LOAN'),
      uid: obj.uid || '',
      account: obj.account || obj.uid || '',
      amount: Math.abs(parseFloat(obj.amount) || 0),
      days: parseInt(obj.days, 10) || 0,
      rate: parseFloat(obj.rate) || 0,
      interest: Math.abs(parseFloat(obj.interest) || 0),
      status: obj.status || 'pending',
      createdAt: new Date().toISOString()
    };
    if (dbActive()) {
      DB.addLoan({ uid: obj.uid || null, account: obj.account || obj.uid || '', amount: l.amount, days: l.days, rate: l.rate, interest: l.interest }).then(function (row) {
        if (row && row.id) l.id = row.id;
        _notifyChange('loans');
      }).catch(function () {});
      return l;
    }
    return l;
  }

  function setLoanStatus(id, status) {
    var out = { id: id, status: status, uid: null, amount: 0 };
    var list = getLoans();
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(id)) {
        list[i].status = status;
        out.uid = list[i].uid;
        out.amount = parseFloat(list[i].amount) || 0;
      }
    }
    function done() { _notifyChange('loans'); return out; }
    if (dbActive()) {
      DB.updateLoanStatus(id, status).then(done).catch(function () {});
    }
    return done();
  }

  function legacyTradeToApp(x) {
    if (!x) return null;
    return {
      id: x.id != null ? String(x.id) : (x.orderId != null ? String(x.orderId) : genId('TRD')),
      uid: x.uid || (/^\d+$/.test(String(x.user || '')) ? String(x.user) : null),
      pair: x.pair || 'BTC/USDT',
      side: x.side || 'up',
      amount: parseFloat(x.amount) || 0,
      price: parseFloat(x.price) || 0,
      user: x.user || x.account || x.uid || '',
      createdAt: x.createdAt || x.created_at || x.time || null,
      status: x.status || 'open',
      duration: parseInt(x.duration, 10) || 0,
      sellPrice: x.sellPrice != null ? parseFloat(x.sellPrice) : (x.sell_price != null ? parseFloat(x.sell_price) : null),
      settledAt: x.settledAt || x.settled_at || null,
      profit: parseFloat(x.profit) || 0
    };
  }

  function getTrades() {
    var list = [];
    if (dbReadable()) {
      try { list = (DB.getTrades() || []).map(dbTradeToApp); } catch (e) {}
    }
    // Merge any legacy localStorage trades (old builds wrote here) so history
    // is never invisible, then migrate them into Supabase on boot.
    var seen = {};
    list.forEach(function (t) { seen[String(t.id)] = 1; });
    try {
      var raw = JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem('trustTrades')) || '[]') || [];
      for (var i = 0; i < raw.length; i++) {
        var t = legacyTradeToApp(raw[i]);
        if (!t || seen[String(t.id)]) continue;
        seen[String(t.id)] = 1;
        list.push(t);
      }
    } catch (e) {}
    list.sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
    return list;
  }
  function saveTrades(list) { return list; }

  // ID mapping: generated trade ID -> DB ID (for settle/close PATCH fallback)
  var _tradeIdMap = {};

  function addTrade(obj) {
    var t = {
      id: genId('TRD'),
      uid: obj.uid || getUserId() ||
        (typeof obj.user !== 'undefined' && /^\d+$/.test(String(obj.user)) ? String(obj.user) : null),
      pair: obj.pair || 'BTC/USDT',
      side: obj.side || 'up',
      amount: parseFloat(obj.amount) || 0,
      price: parseFloat(obj.price) || 0,
      user: obj.user || obj.uid || '',
      createdAt: new Date().toISOString(),
      status: obj.status || 'open',
      duration: parseInt(obj.duration, 10) || 0,
      sellPrice: obj.sellPrice == null ? null : parseFloat(obj.sellPrice),
      settledAt: obj.settledAt || null,
      profit: parseFloat(obj.profit) || 0
    };
    var localId = t.id;
    if (dbActive()) {
      DB.addTrade({
        uid: t.uid,
        account: t.user || null,
        pair: t.pair,
        side: t.side,
        amount: t.amount,
        price: t.price,
        status: t.status,
        duration: t.duration,
        sellPrice: t.sellPrice,
        settledAt: t.settledAt,
        profit: t.profit
      }).then(function (row) {
        if (row && row.id) {
          _tradeIdMap[localId] = String(row.id);
          t.id = String(row.id);
        }
      }).catch(function () {
        mirrorTrade(t);
      });
    } else {
      mirrorTrade(t);
    }
    return t;
  }

  // Keep a recoverable copy in legacy localStorage whenever the write did not
  // reach Supabase; boot migration pushes these into the DB later.
  function mirrorTrade(t) {
    try {
      if (typeof localStorage === 'undefined' || !localStorage.getItem) return;
      var raw = JSON.parse(localStorage.getItem('trustTrades') || '[]') || [];
      for (var i = 0; i < raw.length; i++) if (String(raw[i].id) === String(t.id)) { raw[i] = t; localStorage.setItem('trustTrades', JSON.stringify(raw)); return; }
      raw.unshift(t);
      if (raw.length > 500) raw.length = 500;
      localStorage.setItem('trustTrades', JSON.stringify(raw));
    } catch (e) {}
  }

  function updateTrade(id, patch) {
    var t = null;
    var list = getTrades();
    var dbId = (_tradeIdMap && _tradeIdMap[id]) || id;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(id) || String(list[i].id) === String(dbId)) {
        for (var k in patch) list[i][k] = patch[k];
        t = list[i];
        break;
      }
    }
    if (t) {
      mirrorTrade(t);
    }
    if (t && dbActive()) {
      var p = {};
      if (patch.status !== undefined) p.status = patch.status;
      if (patch.sellPrice !== undefined) p.sell_price = patch.sellPrice;
      if (patch.settledAt !== undefined) p.settled_at = patch.settledAt;
      if (patch.profit !== undefined) p.profit = patch.profit;
      DB.updateTrade(String(dbId), p).catch(function () {});
    }
    return t;
  }

  // Auto-settle open trades whose duration has fully elapsed, so a user who
  // placed a trade and left the page (or reloaded mid-countdown) still gets
  // their capital + profit credited when the time completes. Mirrors the
  // in-browser payout in trade.html: win credits amount + 20% odds profit;
  // loss refunds amount - profit (same partial-refund rule). Runs once per
  // boot on DB-ready; only open/elapsed rows are touched, so settled trades
  // are never credited twice.
  function settleExpiredTrades() {
    if (!dbActive()) return;
    var now = Date.now();
    var list;
    try { list = getTrades(); } catch (e) { return; }
    var settledAny = false;
    list.forEach(function (t) {
      if (!t || t.status !== 'open') return;
      var durMs = (parseInt(t.duration, 10) || 60) * 1000;
      var start = Date.parse(t.createdAt || t.openedAt || t.opened_at || '');
      if (!start) return;
      if (now < start + durMs) return;
      var uid = t.uid != null ? t.uid : getUserId();
      var amt = parseFloat(t.amount) || 0;
      var buyPrice = parseFloat(t.price) || 0;
      var profitMode = (uid && typeof getProfitMode === 'function') ? getProfitMode(uid) : false;
      var win = profitMode || Math.random() < 0.2;
      var pct = amt * 20 / 100;
      var profit = win ? pct : -pct;
      settledAny = true;
      if (uid) {
        try {
          if (win) addBalance(uid, 'USDT', amt + pct);
          else addBalance(uid, 'USDT', amt - pct);
        } catch (e) {}
      }
      updateTrade(t.id, {
        status: win ? 'win' : 'loss',
        sellPrice: buyPrice * (win ? 1.001 : 0.999),
        settledAt: new Date(now).toISOString(),
        profit: profit
      });
    });
    if (settledAny && typeof window !== 'undefined') {
      try { window.dispatchEvent(new CustomEvent('trustsync:trades')); } catch (e) {}
    }
  }

  // One-time migration: push legacy/offline localStorage trades into Supabase.
  function migrateLegacyTrades() {
    if (_migTradesDone) return;
    _migTradesDone = true;
    if (!dbActive()) return;
    DB.ready().then(function () {
      if (!dbActive()) return;
      var seen = {};
      var existing = [];
      try { existing = DB.getTrades() || []; } catch (e) {}
      existing.forEach(function (r) { seen[String(r.id)] = 1; });
      var usersList = [];
      try { usersList = getUsers(); } catch (e) {}
      function uidForLegacy(x) {
        if (x.uid !== undefined && x.uid !== null && String(x.uid) !== '') return String(x.uid);
        if (!x.user && !x.account) return '';
        var acct = String(x.user || x.account || '');
        for (var i = 0; i < usersList.length; i++) {
          if (String(usersList[i].account || '') === acct) return String(usersList[i].uid);
        }
        return '';
      }
      var raw = [];
      try { raw = JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem('trustTrades')) || '[]') || []; } catch (e) {}
      raw.forEach(function (x) {
        var t = legacyTradeToApp(x);
        if (!t || seen[String(t.id)]) return;
        seen[String(t.id)] = 1;
        var legacyUid = uidForLegacy(x);
        // trades.uid is BIGINT NOT NULL (FK to users): rows without a
        // resolvable numeric uid cannot be persisted, so leave the mirror
        // copy in place — it stays visible locally via the merge in getTrades().
        if (!legacyUid || !/^\d+$/.test(legacyUid)) return;
        // Cross-device guard: skip if an identical trade already exists in DB
        // (same opened_at + pair + amount + account), even with a new DB id.
        var dup = existing.some(function (r) {
          return String(r.opened_at || '') === String(t.createdAt || '') &&
                 String(r.pair || '') === String(t.pair || '') &&
                 parseFloat(r.amount || 0) === parseFloat(t.amount || 0) &&
                 String(r.account || '') === String(t.user || '');
        });
        if (dup) return;
        DB.addTrade({
          uid: legacyUid,
          account: t.user || null,
          pair: t.pair,
          side: t.side,
          amount: t.amount,
          price: t.price,
          status: t.status,
          duration: t.duration,
          sellPrice: t.sellPrice,
          settledAt: t.settledAt,
          profit: t.profit
        }).then(function () {
          // Write succeeded: drop the recoverable mirror copy so history
          // stays deduped (the DB row is now the single source of truth).
          try {
            if (typeof localStorage === 'undefined' || !localStorage.getItem) return;
            var cur = JSON.parse(localStorage.getItem('trustTrades') || '[]') || [];
            var nxt = cur.filter(function (r) { return String(r.id) !== String(t.id); });
            localStorage.setItem('trustTrades', JSON.stringify(nxt));
          } catch (e2) {}
        }).catch(function () {});
      });
    }).catch(function () {});
  }

  var AI_KEY = 'trustAIOrders';
  function getAIOrders() {
    if (dbReadable()) {
      try { return (DB.getAIOrders() || []).map(dbAiOrderToApp); } catch (e) {}
    }
    return [];
  }
  function saveAIOrders(list) { return list; }

  function addAIOrder(obj) {
    var o = {
      id: genId('AI'),
      uid: obj.uid || '',
      account: obj.account || obj.uid || 'unknown',
      productId: obj.productId || 1,
      product: obj.product || 'AI Quant',
      period: parseInt(obj.period, 10) || 7,
      rateMin: parseFloat(obj.rateMin) || 0,
      rateMax: parseFloat(obj.rateMax) || 0,
      amount: parseFloat(obj.amount) || 0,
      principal: obj.principal != null ? parseFloat(obj.principal) : (parseFloat(obj.amount) || 0),
      profit: parseFloat(obj.profit) || 0,
      settledDays: parseInt(obj.settledDays, 10) || 0,
      status: obj.status || 'pending',
      startAt: obj.startAt || null,
      endAt: obj.endAt || null,
      createdAt: new Date().toISOString(),
      schedules: obj.schedules || []
    };
    if (dbActive()) {
      var payload = {
        uid: o.uid,
        account: o.account || null,
        symbol: 'AIQUANT',
        side: 'BUY',
        product: o.product,
        period: o.period,
        rate_min: o.rateMin,
        rate_max: o.rateMax,
        amount: o.amount,
        principal: o.principal,
        profit: o.profit,
        settled_days: o.settledDays,
        status: o.status,
        start_at: o.startAt,
        end_at: o.endAt,
        schedules: o.schedules
      };
      DB.addAIOrder(payload).then(function (row) { if (row && row.id) o.id = String(row.id); }).catch(function () {
        // Live ai_orders tables may lack the account column; retry without it so
        // the order still persists and appears in the user's + admin's lists.
        var slim = {};
        for (var k in payload) if (k !== 'account') slim[k] = payload[k];
        DB.addAIOrder(slim).then(function (row) { if (row && row.id) o.id = String(row.id); }).catch(function () {});
      });
    }
    return o;
  }

  function updateAIOrder(id, patch) {
    var o = null;
    var list = getAIOrders();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        for (var k in patch) list[i][k] = patch[k];
        o = list[i];
        break;
      }
    }
    if (o && dbActive()) {
      DB.updateAIOrder(String(id), {
        status: o.status,
        start_at: o.startAt,
        end_at: o.endAt,
        settled_days: o.settledDays,
        profit: o.profit,
        principal: o.principal,
        schedules: o.schedules
      }).catch(function () {});
    }
    return o;
  }

  function buildAISchedules(period, intervalHours, startIso) {
    var scheds = [];
    var start = new Date(startIso || Date.now()).getTime();
    for (var i = 1; i <= period; i++) {
      scheds.push({ day: i, status: 0, rate: 0, profit: 0, time: new Date(start + i * (intervalHours || 24) * 3600000).toISOString() });
    }
    return scheds;
  }

  function aiProcess() {
    try {
      var cfg = getConfig();
      if (!cfg.aiQuantEnabled) return false;
      var approveMin = parseFloat(cfg.aiQuantAutoApproveMin);
      if (!isFinite(approveMin) || approveMin < 0) approveMin = 1;
      var approveMs = approveMin * 60000;
      var intervalHours = parseFloat(cfg.aiQuantSettleIntervalHours);
      if (!isFinite(intervalHours) || intervalHours < 1) intervalHours = 24;
      var intervalMs = intervalHours * 3600000;
      var list = getAIOrders();
      if (!list.length) return false;
      var changed = false;
      for (var i = 0; i < list.length; i++) {
        var o = list[i];
        if (o.status === 'pending') {
          if (Date.now() - new Date(o.createdAt).getTime() >= approveMs) {
            var startAt = new Date().toISOString();
            o.status = 'running';
            o.startAt = startAt;
            o.schedules = buildAISchedules(o.period, intervalHours, startAt);
            o.endAt = new Date(Date.now() + o.period * intervalMs).toISOString();
            o.settledDays = 0;
            o.profit = 0;
            o.principal = o.amount;
            changed = true;
          }
        } else if (o.status === 'running') {
          var scheds = o.schedules || [];
          var settled = 0;
          var credit = 0;
          for (var d = 0; d < scheds.length; d++) {
            var s = scheds[d];
            if (s.status === 1) { settled++; continue; }
            if (new Date(s.time).getTime() <= Date.now()) {
              var rate = Math.round((o.rateMin + Math.random() * (o.rateMax - o.rateMin)) * 100) / 100;
              var dayProfit = Math.round(o.amount * rate) / 100;
              s.status = 1;
              s.rate = rate;
              s.profit = dayProfit;
              settled++;
              credit += dayProfit;
              o.profit = Math.round(((o.profit || 0) + dayProfit) * 100) / 100;
            }
          }
          o.settledDays = settled;
          o.principal = Math.round((o.amount + (o.profit || 0)) * 100) / 100;
          if (settled >= o.period) {
            o.status = 'completed';
            o.endAt = new Date().toISOString();
            credit += o.amount;
          }
          // Credit each order once per tick with the aggregated sum so a
          // multi-day catch-up cannot clobber itself with stale write-backs.
          if (credit > 0 && o.uid) addBalance(o.uid, 'USDT', Math.round(credit * 100) / 100);
          if (settled > 0) changed = true;
        }
      }
      if (changed && dbActive()) {
        // Persist any mutated orders back to Supabase.
        for (var ai = 0; ai < list.length; ai++) {
          var oo = list[ai];
          if (oo.status === 'running' || oo.status === 'completed') {
            DB.updateAIOrder(String(oo.id), {
              status: oo.status, start_at: oo.startAt, end_at: oo.endAt,
              settled_days: oo.settledDays, profit: oo.profit, principal: oo.principal, schedules: oo.schedules
            }).catch(function () {});
          }
        }
      }
      return changed;
    } catch (e) {
      return false;
    }
  }

  var SUPPORT_GREETING = 'Hello! Welcome to Trust Wallet Support. How can I help you today?';

  function ensureSupportGreeting(uid) {
    if (!uid) return null;
    if (dbActive()) {
      if (DB.getUserGreeted(uid)) return null;
      DB.setUserGreeted(uid).catch(function () {});
    }
    return sendChatMsg(uid, 'admin', SUPPORT_GREETING);
  }

  function getChat(uid) {
    if (!uid) return [];
    if (dbReadable()) {
      try {
        return (DB.getChat(uid) || []).filter(function (m) { return !m.deleted; }).map(dbChatToApp);
      } catch (e) {}
      return [];
    }
    return [];
  }

  function _chatLocateKey(list, key) {
    if (String(key).indexOf('idx:') === 0) {
      var idx = parseInt(String(key).slice(4), 10);
      return (idx >= 0 && idx < list.length) ? list[idx] : null;
    }
    for (var i = 0; i < list.length; i++) {
      if (list[i].mid === key) return list[i];
    }
    return null;
  }

  function sendChatMsg(uid, from, text, attachments) {
    if (!uid) return null;
    var msg = {
      mid: genId('CM'),
      from: from === 'admin' ? 'admin' : 'user',
      text: String(text || '').slice(0, 2000),
      at: new Date().toISOString(),
      seen: from === 'admin'
    };
    if (attachments && attachments.length) msg.attachments = attachments.slice(0, 6);
    if (dbActive()) {
      var extra = msg.attachments ? { attachments: msg.attachments } : null;
      DB.sendChatMessage(uid, msg.from, msg.text, extra).then(function (row) {
        if (row && row.id) msg.mid = String(row.id);
        _notifyChange('chat_messages');
      }).catch(function () {});
    }
    return msg;
  }

  function updateChatMsg(uid, key, text) {
    if (!uid) return null;
    var list = getChat(uid);
    var m = _chatLocateKey(list, key);
    if (!m) return null;
    m.text = String(text == null ? '' : text).slice(0, 2000);
    m.edited = true;
    m.editedAt = new Date().toISOString();
    if (dbActive()) DB.editChatMessage(uid, m.mid, m.text).then(function () {
      _notifyChange('chat_messages');
    }).catch(function () {});
    return m;
  }

  // soft-delete a message so it never resurfaces on another device
  function deleteChatMsg(uid, key) {
    if (!uid) return { ok: false, msg: 'No uid' };
    var list = getChat(uid);
    var m = _chatLocateKey(list, key);
    if (!m) return { ok: false, msg: 'Message not found' };
    m.deleted = true;
    m.deletedAt = new Date().toISOString();
    if (dbActive()) DB.deleteChatMessage(uid, m.mid).then(function () {
      _notifyChange('chat_messages');
    }).catch(function () {});
    return { ok: true };
  }

  // mark a user's chat as seen by admin
  function markChatSeen(uid) {
    if (!uid) return false;
    var list = getChat(uid);
    var touched = false;
    list.forEach(function (msg) {
      if (msg && msg.from !== 'admin' && !msg.seen) { msg.seen = true; touched = true; }
    });
    if (touched && dbActive()) DB.markChatRead(uid).catch(function () {});
    return touched;
  }

  function chatUsers() {
    if (dbActive()) {
      try {
        return (DB.getChatUsers() || []).filter(function (u) {
          return (getChat(u) || []).some(function (msg) { return msg && !msg.deleted; });
        });
      } catch (e) {}
      return [];
    }
    return [];
  }

  function accountByUid(uid) {
    if (uid != null && dbActive()) {
      try {
        var raw = DB.getUserStr(uid);
        if (raw) return dbUserToApp(raw);
      } catch (e) {}
      return null;
    }
    var users = getUsers();
    for (var i = 0; i < users.length; i++) {
      if (String(users[i].uid) === String(uid)) return users[i];
    }
    return null;
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function attLabel(atts) {
    if (!atts || !atts.length) return '';
    if (atts.length > 1) return '[' + atts.length + ' attachments]';
    var a = atts[0];
    if (a.kind === 'image') return '[Image]';
    if (a.kind === 'video') return '[Video]';
    return '[File: ' + (a.name || 'file') + ']';
  }

  function renderAttachments(atts) {
    if (!atts || !atts.length) return '';
    return atts.map(function (a) {
      if (a.kind === 'image') {
        return '<img class="chat-att-img" src="' + a.data + '" alt="' + escHtml(a.name || 'image') + '" onclick="TrustApp.showImageLightbox(this.src)" loading="lazy" style="cursor:zoom-in">';
      }
      if (a.kind === 'video') {
        return '<video class="chat-att-video" controls preload="metadata" src="' + a.data + '"></video>';
      }
      return '<a class="chat-att-file" href="' + a.data + '" download="' + escHtml(a.name || 'file') + '">'
        + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"></path></svg>'
        + '<span>' + escHtml(a.name || 'file') + '</span></a>';
    }).join('');
  }

  function adjustBalance(uid, coin, dir, amt, note) {
    var user = accountByUid(uid);
    if (!user) return { ok: false, msg: 'User not found' };
    amt = Math.abs(parseFloat(amt) || 0);
    if (amt <= 0) return { ok: false, msg: 'Amount must be greater than 0' };
    var delta = dir === 'debit' ? -amt : amt;
    addBalance(uid, coin, delta);
    var t = addTxn({ uid: uid, account: user.account, type: 'adjust', coin: coin, amount: amt, status: 'confirmed', note: note || (dir === 'debit' ? 'Manual debit' : 'Manual credit') });
    t.dir = dir === 'debit' ? 'debit' : 'credit';
    var list = getTxns();
    for (var i = 0; i < list.length; i++) { if (list[i].id === t.id) { list[i].dir = t.dir; break; } }
    saveTxns(list);
    return { ok: true, balance: getBalance(uid, coin) };
  }

  function isUserAdmin(uid) {
    var u = accountByUid(uid);
    return !!(u && (u.role === 'admin' || u.isAdmin === true || u.is_admin === true));
  }

  function setUserAdmin(uid, val) {
    if (dbActive()) {
      var u = accountByUid(uid);
      if (!u) return { ok: false, msg: 'User not found' };
      DB.updateUser(uid, { is_admin: !!val }).then(function () {
        _notifyChange('users');
      }).catch(function (e) {
        try { if (window.toast) toast('error', 'Failed to update: ' + e.message); } catch (e2) {}
      });
      u.role = val ? 'admin' : undefined;
      u.isAdmin = val ? true : undefined;
      u.is_admin = !!val;
      return { ok: true, user: u };
    }
    var users = getUsers();
    for (var i = 0; i < users.length; i++) {
      if (String(users[i].uid) === String(uid)) {
        if (val) { users[i].role = 'admin'; users[i].isAdmin = true; }
        else { delete users[i].role; delete users[i].isAdmin; }
        saveUsers(users);
        return { ok: true, user: users[i] };
      }
    }
    return { ok: false, msg: 'User not found' };
  }

  function isCurrentUserAdmin() {
    if (_session && _session.admin) return true;
    return isUserAdmin(getUserId());
  }

  // Expose internal session state for debugging
  function getSessionState() {
    return _session;
  }

  function isUserActive(uid) {
    var u = accountByUid(uid);
    if (!u) return false;
    return u.status !== 'inactive';
  }

  function setUserStatus(uid, active) {
    if (dbActive()) {
      var u = accountByUid(uid);
      if (!u) return { ok: false, msg: 'User not found' };
      DB.updateUser(uid, { status: active ? 'active' : 'inactive' }).then(function () {
        _notifyChange('users');
      }).catch(function (e) {
        try { if (window.toast) toast('error', 'Failed to update: ' + e.message); } catch (e2) {}
      });
      u.status = active ? 'active' : 'inactive';
      return { ok: true, user: u };
    }
    var users = getUsers();
    for (var i = 0; i < users.length; i++) {
      if (String(users[i].uid) === String(uid)) {
        users[i].status = active ? 'active' : 'inactive';
        saveUsers(users);
        return { ok: true, user: users[i] };
      }
    }
    return { ok: false, msg: 'User not found' };
  }

  // permanently delete a user and every trace of their data
  function removeUser(uid) {
    if (!uid) return { ok: false, msg: 'Uid required' };
    if (isUserAdmin(uid) && String(uid) === String(getUserId())) return { ok: false, msg: 'You cannot delete your own account' };
    var user = accountByUid(uid);
    if (!user) return { ok: false, msg: 'User not found' };

    if (dbActive()) {
      DB.deleteUser(uid).then(function () {
        try { if (DB.pullBlob) DB.pullBlob('users').catch(function () {}); } catch (e) {}
      }).catch(function (e) {
        try { if (window.toast) toast('error', 'Failed to delete: ' + e.message); } catch (e2) {}
      });
      if (isLoggedIn() && getUserId() === uid) logout();
      return { ok: true, account: user.account };
    }

    // no database configured: nothing stored locally, nothing to delete
    if (isLoggedIn() && getUserId() === uid) logout();
    return { ok: true, account: user.account };
  }

  var VER_KEY = 'trustVerifications';

  var COIN_ADDR_KEY = 'trustCoinAddresses';

  var PROFIT_KEY = 'trustProfitMode';

  function getProfitMode(uid) {
    if (!uid) return false;
    if (dbActive()) {
      try { return DB.getUserProfitMode(uid); } catch (e) {}
      return false;
    }
    return false;
  }

  function setProfitMode(uid, on) {
    if (!uid) return { ok: false, msg: 'User is required' };
    if (dbActive()) {
      DB.setUserProfitMode(uid, !!on).catch(function () {});
      return { ok: true };
    }
    return { ok: false, msg: 'Database not configured' };
  }

  function getCoinAddresses() {
    var out = {};
    var disabled = {};
    if (dbReadable() && DB) {
      try {
        var dl = DB.getSetting('disabled_coin_addresses');
        if (Array.isArray(dl)) dl.forEach(function (c) { disabled[String(c).toUpperCase()] = true; });
      } catch (e) {}
    }
    Object.keys(DEFAULT_COIN_ADDRESSES).forEach(function (coin) {
      if (disabled[coin]) return;
      out[coin] = { net: DEFAULT_COIN_ADDRESSES[coin].net, addr: DEFAULT_COIN_ADDRESSES[coin].addr };
    });
    if (dbReadable()) {
      try {
        var m = DB.getCoinAddresses() || {};
        Object.keys(m).forEach(function (coin) {
          if (disabled[coin]) return;
          out[coin] = { net: m[coin].network || m[coin].net || '', addr: m[coin].address || m[coin].addr || '' };
        });
        return out;
      } catch (e) {}
    }
    return out;
  }

  function saveCoinAddress(coin, net, addr) {
    coin = String(coin || '').toUpperCase().trim();
    if (!coin) return { ok: false, msg: 'Coin is required' };
    net = String(net || '').trim();
    addr = String(addr || '').trim();
    if (!addr) return { ok: false, msg: 'Address is required' };
    if (dbActive()) {
      if (DB.enableCoin) DB.enableCoin(coin).catch(function () {});
      DB.saveCoinAddress(coin, net.slice(0, 40), addr.slice(0, 500)).catch(function (e) {
        try { if (window.toast) toast('error', 'Save failed: ' + e.message); } catch (e2) {}
      });
      return { ok: true };
    }
    return { ok: false, msg: 'Database not configured' };
  }

  function removeCoinAddress(coin) {
    if (dbActive()) {
      DB.deleteCoinAddress(coin).catch(function () {});
      return { ok: true };
    }
    return { ok: false, msg: 'Database not configured' };
  }

  function getVerifications() {
    if (dbReadable()) {
      var map = {};
      try {
        (DB.getAllVerifications() || []).forEach(function (v) { map[v.uid] = dbVerToApp(v); });
        return map;
      } catch (e) {}
    }
    return {};
  }

  function saveVerifications(m) {
    return false;
  }

  function getVerification(uid) {
    var m = getVerifications();
    return m[uid] || null;
  }

  function submitVerification(uid, data) {
    if (!uid) return { ok: false, msg: 'Please login first' };
    if (!data || !data.name || !data.idNumber || !data.idFront || !data.idBack) {
      return { ok: false, msg: 'Please fill in all fields and upload both sides of your ID' };
    }
    if (dbActive()) {
      var v = getVerification(uid);
      if (v && v.status === 'pending') return { ok: false, msg: 'Your verification is already under review' };
      DB.submitVerification(uid, {
        name: String(data.name || '').slice(0, 120),
        email: String(data.email || '').slice(0, 120),
        idNumber: String(data.idNumber || '').slice(0, 80),
        phone: String(data.phone || '').slice(0, 40),
        id_front: String(data.idFront || ''),
        id_back: String(data.idBack || '')
      }).then(function () {
        _notifyChange('verifications');
      }).catch(function (e) {
        try { if (window.toast) toast('error', 'Save failed: ' + e.message); } catch (e2) {}
      });
      return { ok: true };
    }
    return { ok: false, msg: 'Database not configured' };
  }

  function submitAdvancedVerification(uid, data) {    if (!uid) return { ok: false, msg: 'Please login first' };
    if (!data || !data.advanced) return { ok: false, msg: 'Please upload your handheld ID photo' };
    if (!dbActive()) return { ok: false, msg: 'Database not configured' };
    var v = getVerification(uid);
    if (v && v.advancedStatus === 'pending') return { ok: false, msg: 'Your advanced verification is already under review' };
    var fields = {
      advanced: String(data.advanced || ''),
      advanced_status: 'pending',
      advanced_submitted_at: new Date().toISOString(),
      advanced_reviewed_at: null,
      advanced_note: ''
    };
    if (v) {
      DB.updateVerificationAdvanced(uid, fields).catch(function (e) {
        try { if (window.toast) toast('error', 'Save failed: ' + e.message); } catch (e2) {}
      });
    } else {
      DB.submitVerification(uid, Object.assign({
        name: '', email: '', idNumber: '', phone: '', id_front: '', id_back: ''
      }, fields)).catch(function (e) {
        try { if (window.toast) toast('error', 'Save failed: ' + e.message); } catch (e2) {}
      });
    }
    return { ok: true };
  }

  function getAdvancedVerification(uid) {
    var v = getVerification(uid);
    if (!v) return null;
    return {
      status: v.advancedStatus || null,
      image: v.advanced || '',
      submittedAt: v.advancedSubmittedAt || null,
      reviewedAt: v.advancedReviewedAt || null,
      note: v.advancedNote || ''
    };
  }

  function setAdvancedVerificationStatus(uid, status, note) {
    if (!dbActive()) return { ok: false, msg: 'Database not configured' };
    var v = getVerification(uid);
    if (!v || !v.advanced) return { ok: false, msg: 'No advanced verification submission found' };
    if (status !== 'approved' && status !== 'rejected') return { ok: false, msg: 'Invalid status' };
    DB.updateVerificationAdvanced(uid, {
      advanced_status: status,
      advanced_note: String(note || '').slice(0, 300),
      advanced_reviewed_at: new Date().toISOString()
    }).then(function () {
      _notifyChange('verifications');
    }).catch(function () {});
    return { ok: true };
  }

  function setVerificationStatus(uid, status, note) {
    if (dbActive()) {
      if (!getVerification(uid)) return { ok: false, msg: 'No verification submission found' };
      if (status !== 'approved' && status !== 'rejected') return { ok: false, msg: 'Invalid status' };
      DB.updateVerificationStatus(uid, status, { rejection_reason: String(note || '').slice(0, 300) }).then(function () {
        _notifyChange('verifications');
      }).catch(function () {});
      return { ok: true };
    }
    return { ok: false, msg: 'Database not configured' };
  }

  function adminApproveKyc(uid) {
    if (!uid) return { ok: false, msg: 'No uid' };
    if (dbActive()) {
      var cur = getVerification(uid);
      if (cur && cur.status === 'approved') return { ok: false, msg: 'Already approved' };
      if (!cur) {
        DB.submitVerification(uid, { name: '', email: '', idNumber: '', phone: '', id_front: '', id_back: '', status: 'approved' }).then(function () {
          _notifyChange('verifications');
        }).catch(function () {});
      } else {
        DB.updateVerificationStatus(uid, 'approved', { rejection_reason: '' }).then(function () {
          _notifyChange('verifications');
        }).catch(function () {});
      }
      return { ok: true };
    }
    return { ok: false, msg: 'Database not configured' };
  }

  function changePassword(uid, currentPassword, newPassword) {
    if (!uid) return { ok: false, msg: 'Please login first' };
    if (!dbActive()) return { ok: false, msg: 'Database not configured' };
    if (!DB.changePassword) return { ok: false, msg: 'Password changes are handled by Supabase Auth' };
    // Asynchronous: Supabase proves the current password with reauthenticate and
    // then rotates the credential server-side.
    return DB.changePassword(currentPassword, newPassword);
  }

  function changeAdminPassword(currentPassword, newPassword) {
    if (!currentPassword || !newPassword) return { ok: false, msg: 'Please fill in all fields' };
    var cfg = getConfig();
    if (currentPassword !== (cfg.adminPassword || 'admin123')) return { ok: false, msg: 'Current admin password is incorrect' };
    if (String(newPassword).length < 6) return { ok: false, msg: 'New password must be at least 6 characters' };
    cfg.adminPassword = newPassword;
    saveConfig(cfg);
    return { ok: true };
  }

  (function guardAuth() {
    var f = (location.pathname.split('/').pop() || '').toLowerCase();
    var pub = ['login.html', 'register.html', 'service.html', 'debug_live.html'];
    if (pub.indexOf(f) !== -1) return;
    if (f.indexOf('admin') === 0) return;

    var redirected = false;
    function goLogin(blocked) {
      if (redirected) return;
      redirected = true;
      var url = 'login.html?r=' + encodeURIComponent(f + location.search) + (blocked ? '&blocked=1' : '');
      if (window.__guardRedir) { window.__guardRedir(url); return; }
      if (!location.replace) return;
      location.replace(url);
    }
    function decide(s) {
      if (redirected) return;
      if (!s) return goLogin(); // no session resolved -> logged out
      if (s.admin) return; // admin session may browse private pages
      if (s.uid == null) return goLogin();
      // A confirmed identity may stay -- unless the account was deactivated.
      var u = accountByUid(getUserId());
      if (u && u.status === 'inactive') {
        try { logout(); } catch (e) {}
        return goLogin(true);
      }
    }

    // Validate against the DB. If the DB cannot be reached, do NOT let a
    // logged-out visitor keep exploring a private page: without a confirmable
    // identity, bounce to login after a short grace so real loading isn't
    // interrupted (a stale left-open tab would otherwise stay explorable).
    var inFlight = false;
    function recheck() {
      if (redirected || inFlight) return;
      inFlight = true;
      var settled = false;
      function finish(s) {
        settled = true;
        inFlight = false;
        decide(s);
      }

      // Hard fallback. If the data layer never reports ready at all (no
      // network, blocked CDN, misconfigured project) we must NOT leave a
      // logged-out visitor sitting on a private page, so this still fires on
      // its own clock.
      setTimeout(function () {
        if (settled || redirected) return;
        inFlight = false;
        if (_session && _session.uid != null) return;
        goLogin();
      }, 30000);

      // Do not start the real grace clock until the data layer has booted.
      // In v2 the first session answer is gated behind loading the Supabase
      // client from a CDN and restoring the stored session, and restoreSession
      // retries for up to ~18s on top of that. The old code started its 8s
      // timer immediately, so an ordinary cold page load lost the race and a
      // correctly signed-in user was redirected to login.
      var ready = (typeof DB !== 'undefined' && DB.ready) ? DB.ready() : Promise.resolve();
      ready.then(function () {
        // 12s, not 8s: this now bounds only the session lookup, and
        // getSessionWithRetry legitimately spends up to 5s on a slow first
        // attempt before retrying. An 8s window cut it close enough to
        // redirect a signed-in user on a poor connection.
        setTimeout(function () {
          if (settled || redirected) return;
          inFlight = false;
          if (_session && _session.uid != null) return;
          goLogin();
        }, 12000);
        return restoreSession();
      }).then(finish).catch(function () { finish(null); });
    }
    function check() {
      if (redirected) return;
      if (_session && _session.uid != null) return; // identity in memory; rechecks validate it
      recheck();
    }

    check();
    // Reopen a left-open page (mobile tab restore / BFCache / back navigation)
    // re-validates the session instead of trusting the in-memory snapshot.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) recheck();
    });
    if (window.addEventListener) window.addEventListener('focus', function () {
      if (!document.hidden) recheck();
    });
    // Session revoked while the page sits open: pick it up within ~30s.
    setInterval(function () {
      if (!document.hidden && !redirected) recheck();
    }, 30000);
  })();

  function marketToTradeQuery(d, tab) {
    return 'trade.html?s=' + encodeURIComponent(d.pair || d.s) + '&tab=' + tab + '&p=' + d.price;
  }

  function watchStorage(keys, callback, debounceMs) {
    var timers = {};
    var map = {
      users: ['trustUsers'],
      user_balances: ['trustBalances'],
      transactions: ['trustTxns'],
      loans: ['trustLoans'],
      trades: ['trustTrades'],
      ai_orders: ['trustAIOrders'],
      chat_messages: ['trustChat'],
      verifications: ['trustVerifications'],
      coin_addresses: ['trustCoinAddresses']
    };
    function run(key) {
      if (!callback) return;
      if (timers[key]) clearTimeout(timers[key]);
      timers[key] = setTimeout(function () {
        try { callback(key); } catch (e) {}
      }, debounceMs || 150);
    }
    // Data now lives in Supabase; react to its realtime events instead of
    // localStorage 'storage' events.
    if (typeof window !== 'undefined') {
      Object.keys(map).forEach(function (tbl) {
        var wants = map[tbl].filter(function (k) { return !keys || keys.length === 0 || (keys || []).indexOf(k) !== -1; });
        if (!wants.length) return;
        window.addEventListener('trustsync:' + tbl, function () { run(tbl); });
      });
    }
    watchStorage.timers = timers;
  }

  function showImageLightbox(src) {
    if (!src) return;
    var ov = document.createElement('div');
    ov.className = 'img-lightbox-overlay';
    var btn = document.createElement('button');
    btn.className = 'img-lightbox-close';
    btn.textContent = '\u00d7';
    var img = document.createElement('img');
    img.src = src;
    ov.appendChild(btn);
    ov.appendChild(img);
    document.body.appendChild(ov);
    document.body.style.overflow = 'hidden';
    function close() { ov.remove(); document.body.style.overflow = ''; }
    btn.addEventListener('click', close);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.addEventListener('keydown', function handler(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', handler); } });
  }

  var adminTablesInited = false;

  function isAdminMobile() {
    return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(max-width:640px)').matches;
  }

  /* Convert admin data tables to stacked card lists on phones.
     Moves the real <td> nodes into card layout so inline onclick
     handlers and data-id attributes survive. Rebuilds every time so
     auto-update re-renders stay in sync. Restores tables on desktop. */
  function makeAdminTablesMobile() {
    if (!document || !document.querySelectorAll) return;
    if (!document.body || document.body.className.indexOf('admin-page') === -1) return;
    var want = isAdminMobile();
    if (!want) {
      document.querySelectorAll('.admin-row-card-list').forEach(function (list) {
        var tbl = list._srcTbl;
        if (tbl) { tbl.style.display = ''; tbl.removeAttribute('data-mc-on'); tbl.removeAttribute('data-mc-sig'); }
        list.remove();
      });
      return;
    }
    document.querySelectorAll('.admin-panel table').forEach(function (tbl) {
      if (!tbl.querySelector('thead') || !tbl.querySelector('tbody')) return;
      buildCards(tbl);
    });
  }

  function buildCards(tbl) {
    var thead = tbl.querySelector('thead');
    var tbody = tbl.querySelector('tbody');
    if (!thead || !tbody) return;
    var ths = Array.prototype.map.call(thead.querySelectorAll('th'), function (th) { return th.textContent || ''; });
    var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
    if (!rows.length) return;
    // signature computed from live rows BEFORE moving; rebuilt cards produce
    // an emptied table whose signature differs -> store emptied sig after move
    var sig = rows.map(function (tr) {
      return Array.prototype.map.call(tr.querySelectorAll('td'), function (td) { return (td.textContent || '').trim(); }).join('|');
    }).join(';;').slice(0, 400);
    // If signature already matches stored, table is either already carded or
    // fully emptied by a previous build (observer loop) -> skip.
    var stored = tbl.getAttribute('data-mc-sig') || '';
    var sigMatch = stored === sig;
    var alreadyCarded = tbl.style.display === 'none' && tbl.getAttribute('data-mc-on') === '1';
    if (alreadyCarded && sigMatch) return;
    // remove any existing card list for this table before rebuilding
    var wrap = tbl.parentNode;
    var existing = wrap.querySelector('.admin-row-card-list');
    if (existing && existing._srcTbl === tbl) existing.remove();
    var list = document.createElement('div');
    list.className = 'admin-row-card-list';
    rows.forEach(function (tr) {
      var tds = tr.querySelectorAll('td');
      if (!tds.length) return;
      var card = document.createElement('div');
      card.className = 'admin-row-card';
      if (tr.getAttribute('data-id')) card.setAttribute('data-id', tr.getAttribute('data-id'));
      var accordion = tbl.getAttribute('data-mc-accordion') === '1';
      var bodyWrap = null;
      var headHolder = null;
      if (accordion) {
        card.classList.add('arc-collapsible');
        bodyWrap = document.createElement('div');
        bodyWrap.className = 'arc-body';
      }
      tds.forEach(function (td, ci) {
        var label = ths[ci] || '';
        var holder = document.createElement('div');
        if ((!label && ci === 0) || label === 'User' || label === 'Account') {
          holder.className = 'arc-head';
          while (td.firstChild) holder.appendChild(td.firstChild);
          headHolder = holder;
        } else if (label === 'Action' || label === 'Actions' || !label) {
          holder.className = 'arc-actions';
          while (td.firstChild) holder.appendChild(td.firstChild);
        } else {
          holder.className = 'arc-row';
          var l = document.createElement('span');
          l.className = 'arc-label';
          l.textContent = label;
          var v = document.createElement('span');
          v.className = 'arc-value';
          while (td.firstChild) v.appendChild(td.firstChild);
          holder.appendChild(l);
          holder.appendChild(v);
        }
        if (accordion && holder !== headHolder) bodyWrap.appendChild(holder);
        else card.appendChild(holder);
      });
      if (accordion && headHolder) {
        var chev = document.createElement('span');
        chev.className = 'arc-chev';
        chev.setAttribute('aria-hidden', 'true');
        chev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>';
        headHolder.appendChild(chev);
        headHolder.setAttribute('role', 'button');
        headHolder.addEventListener('click', function () { card.classList.toggle('arc-open'); });
      }
      if (accordion && bodyWrap) card.appendChild(bodyWrap);
      list.appendChild(card);
    });
    list._srcTbl = tbl;
    wrap.insertBefore(list, tbl);
    tbl.style.display = 'none';
    tbl.setAttribute('data-mc-on', '1');
    // store the "emptied" signature: after moving td children into the cards
    // the live table reads as empty. This lets re-renders (which repopulate
    // the tbody) change the signature and trigger a rebuild, while the
    // MutationObserver sees an unchanged empty table and skips (no loop).
    var emptiedSig = Array.prototype.map.call(tbody.querySelectorAll('tr'), function (tr) {
      return Array.prototype.map.call(tr.querySelectorAll('td'), function (td) { return (td.textContent || '').trim(); }).join('|');
    }).join(';;').slice(0, 400);
    tbl.setAttribute('data-mc-sig', emptiedSig);
  }

  function initAdminTablesMobile() {
    if (adminTablesInited) return;
    adminTablesInited = true;
    function refresh() {
      clearTimeout(window.__adminMcT);
      window.__adminMcT = setTimeout(function () {
        try { makeAdminTablesMobile(); } catch (e) {}
      }, 120);
    }
    try { makeAdminTablesMobile(); } catch (e) {}
    if (typeof window !== 'undefined') {
      if (window.MutationObserver) {
        try { new window.MutationObserver(refresh).observe(document.body || document, { childList: true, subtree: true }); } catch (e) {}
      } else { setInterval(refresh, 1500); }
      window.addEventListener('resize', refresh);
    }
  }

  /* Mobile hamburger slide-out drawer for the admin sidebar.
     Injects the hamburger button (topbar) and backdrop, toggles the
     .sidebar-open class. Closes on backdrop click, Escape, nav-link
     click, or resizing back to desktop. Lock screen (z-index 1000)
     stays above the drawer (z-index 900). */
  var navDrawerInited = false;

  function initAdminNavDrawer() {
    if (navDrawerInited) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    try {
      var topbar = document.querySelector('.admin-topbar');
      var sidebar = document.querySelector('.admin-sidebar');
      if (!topbar || !sidebar) return;
      navDrawerInited = true;

      var burger = document.createElement('button');
      burger.className = 'admin-hamburger';
      burger.setAttribute('aria-label', 'Menu');
      burger.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h18"></path></svg>';
      topbar.insertBefore(burger, topbar.firstChild);

      var backdrop = document.createElement('div');
      backdrop.className = 'admin-sidebar-backdrop';
      document.body.appendChild(backdrop);

      function openDrawer() {
        sidebar.classList.add('sidebar-open');
        backdrop.classList.add('show');
        document.body.classList.add('nav-open-lock');
      }
      function closeDrawer() {
        sidebar.classList.remove('sidebar-open');
        backdrop.classList.remove('show');
        document.body.classList.remove('nav-open-lock');
      }

      burger.addEventListener('click', function () {
        if (sidebar.classList.contains('sidebar-open')) closeDrawer(); else openDrawer();
      });
      backdrop.addEventListener('click', closeDrawer);

      var closeBtn = document.createElement('button');
      closeBtn.className = 'admin-drawer-close';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"></path></svg>';
      closeBtn.addEventListener('click', closeDrawer);
      var logo = sidebar.querySelector('.as-logo');
      if (logo) logo.appendChild(closeBtn);

      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
      sidebar.querySelectorAll('.as-link').forEach(function (a) { a.addEventListener('click', closeDrawer); });
      window.addEventListener('resize', function () {
        if (window.innerWidth > 900) closeDrawer();
      });
    } catch (e) {}
  }

  /* Mobile quick-access bottom navigation for admin pages.
     Injects a fixed bottom bar with the 5 most used destinations so
     admins don't need the hamburger drawer for top-level navigation.
     Visible only on phones (CSS). Active item matches the sidebar's
     current .as-link.active so it stays in sync per page. */
  var bottomNavInited = false;

  function initAdminBottomNav() {
    if (bottomNavInited) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    try {
      if (!document.querySelector('.admin-shell') || !document.querySelector('.admin-sidebar')) return;
      bottomNavInited = true;
      var items = [
        { href: 'admin.html', label: 'Dashboard', svg: '<rect x="3" y="3" width="7" height="9" rx="1"></rect><rect x="14" y="3" width="7" height="5" rx="1"></rect><rect x="14" y="12" width="7" height="9" rx="1"></rect><rect x="3" y="16" width="7" height="5" rx="1"></rect>' },
        { href: 'admin-users.html', label: 'Users', svg: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"></path>' },
        { href: 'admin-quants.html', label: 'AI Quant', svg: '<rect x="4" y="4" width="16" height="16" rx="2"></rect><path d="M9 9h6v6H9zM9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"></path>' },
        { href: 'admin-funds.html', label: 'Funding', svg: '<path d="M12 1v22"></path><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>' },
        { href: 'admin-chat.html', label: 'Support', svg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>' }
      ];
      var nav = document.createElement('nav');
      nav.className = 'admin-bottom-nav';
      nav.setAttribute('aria-label', 'Admin shortcuts');
      var activeAs = document.querySelector('.as-link.active');
      var activeHref = activeAs ? (activeAs.getAttribute('href') || '') : null;
      items.forEach(function (it) {
        var a = document.createElement('a');
        a.className = 'abn-item';
        a.href = it.href;
        a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + it.svg + '</svg><span>' + it.label + '</span>';
        if (activeHref && it.href === activeHref) a.classList.add('abn-active');
        nav.appendChild(a);
      });
      document.body.appendChild(nav);
    } catch (e) {}
  }

  global.TrustApp = {
    AppConfig: AppConfig,
    MARKET: MARKET,
    marketFlat: marketFlat,
    fallbackMarket: fallbackMarket,
    fetchMarket: fetchMarket,
    isMarketLive: isMarketLive,
    findCoin: findCoin,
    coinIconPath: coinIconPath,
    watchStorage: watchStorage,
    showImageLightbox: showImageLightbox,
    makeAdminTablesMobile: makeAdminTablesMobile,
    initAdminTablesMobile: initAdminTablesMobile,
    initAdminNavDrawer: initAdminNavDrawer,
    initAdminBottomNav: initAdminBottomNav,
    liveTick: liveTick,
    fmtPrice: fmtPrice,
    pricePrefix: pricePrefix,
    toast: toast,
    toggleMenu: toggleMenu,
    closeMenu: closeMenu,
    service: service,
    connectWallet: connectWallet,
    applyWalletBtn: applyWalletBtn,
    getWallet: getWallet,
    resetWalletConnect: function () { wcSdkPromise = null; activeWcProvider = null; _connectBusy = false; },
    requestEip6963: requestEip6963,
    pickInjectedProvider: pickInjectedProvider,
    waitForInjectedProvider: waitForInjectedProvider,
    connectViaWalletConnect: connectViaWalletConnect,
    wcProjectId: wcProjectId,
    t: t,
    applyI18n: applyI18n,
    setLang: setLang,
    toggleLang: toggleLang,
    updateMenuUser: updateMenuUser,
    ensureGuest: ensureGuest,
    isLoggedIn: isLoggedIn,
    register: register,
    login: login,
    walletLogin: walletLogin,
    logout: logout,
    changePassword: changePassword,
    changeAdminPassword: changeAdminPassword,
    getUsers: getUsers,
    getUserId: getUserId,
    isUserAdmin: isUserAdmin,
    setUserAdmin: setUserAdmin,
    isCurrentUserAdmin: isCurrentUserAdmin,
    isRealAdmin: isRealAdmin,
    currentUser: currentUser,
    isUserActive: isUserActive,
    setUserStatus: setUserStatus,
    getBalances: getBalances,
    getBalance: getBalance,
    setBalance: setBalance,
    addBalance: addBalance,
    getTxns: getTxns,
    addTxn: addTxn,
    addTransaction: function (data) { return DB && DB.addTransaction ? DB.addTransaction(data) : Promise.resolve({ ok: false, msg: 'DB not ready' }); },
    setTxnStatus: setTxnStatus,
    getLoans: getLoans,
    getLoansForUser: getLoansForUser,
    addLoan: addLoan,
    setLoanStatus: setLoanStatus,
    getTrades: getTrades,
    addTrade: addTrade,
    updateTrade: updateTrade,
    getAIOrders: getAIOrders,
    addAIOrder: addAIOrder,
    updateAIOrder: updateAIOrder,
    buildAISchedules: buildAISchedules,
    aiProcess: aiProcess,
    getChat: getChat,
    chatUsers: chatUsers,
    ensureSupportGreeting: ensureSupportGreeting,
    supportGreeting: SUPPORT_GREETING,
    sendChatMsg: sendChatMsg,
    updateChatMsg: updateChatMsg,
    deleteChatMsg: deleteChatMsg,
    markChatSeen: markChatSeen,
    removeUser: removeUser,
    accountByUid: accountByUid,
    getVerifications: getVerifications,
    getVerification: getVerification,
    submitVerification: submitVerification,
    setVerificationStatus: setVerificationStatus,
    adminApproveKyc: adminApproveKyc,
    submitAdvancedVerification: submitAdvancedVerification,
    getAdvancedVerification: getAdvancedVerification,
    setAdvancedVerificationStatus: setAdvancedVerificationStatus,
    getCoinAddresses: getCoinAddresses,
    saveCoinAddress: saveCoinAddress,
    removeCoinAddress: removeCoinAddress,
    getProfitMode: getProfitMode,
    setProfitMode: setProfitMode,
    toggleProfitMode: function (uid, on) { return setProfitMode(uid, !!on); },
    escHtml: escHtml,
    renderAttachments: renderAttachments,
    attLabel: attLabel,
    adjustBalance: adjustBalance,
    initAdminLock: initAdminLock,
    unlockAdmin: unlockAdmin,
    getConfig: getConfig,
    saveConfig: saveConfig,
    resetConfig: resetConfig,
    getConfigDefaults: getConfigDefaults,
    marketToTradeQuery: marketToTradeQuery,
    showImageLightbox: showImageLightbox,
    rebuildFlat: rebuildFlat,
    guessVip: guessVip,
    isNonCryptoWeekend: isNonCryptoWeekend,
    weekendTradingEnabled: weekendTradingEnabled
  };

  global.toast = toast;
  global.t = t;
  global.applyI18n = applyI18n;
  global.toggleMenu = toggleMenu;
  global.closeMenu = closeMenu;
  global.service = service;
  global.connectWallet = connectWallet;
  global.setLang = setLang;
  global.toggleLang = toggleLang;
  global.getConfig = getConfig;
  global.saveConfig = saveConfig;
  global.resetConfig = resetConfig;
  global.changePassword = changePassword;
  global.changeAdminPassword = changeAdminPassword;
  global.isUserAdmin = isUserAdmin;
  global.setUserAdmin = setUserAdmin;
  global.isCurrentUserAdmin = isCurrentUserAdmin;
  global.currentUser = currentUser;
  global.isUserActive = isUserActive;
  global.setUserStatus = setUserStatus;
  global.initAdminLock = initAdminLock;
  global.unlockAdmin = unlockAdmin;
  global.restoreSession = restoreSession;
  global.getSessionState = getSessionState;
  global.getToken = getToken;

  // Also add to TrustApp for convenience
  global.TrustApp.restoreSession = restoreSession;
  global.TrustApp.getSessionState = getSessionState;
  global.TrustApp.unlockAdmin = unlockAdmin;
  global.TrustApp.initAdminLock = initAdminLock;
  global.TrustApp.isCurrentUserAdmin = isCurrentUserAdmin;
  global.TrustApp.getUserId = getUserId;
  global.TrustApp.aiProcess = aiProcess;
  global.aiProcess = aiProcess;

  (function startAIEngine() {
    try { aiProcess(); } catch (e) {}
    setInterval(function () {
      try { aiProcess(); } catch (e) {}
    }, 30000);
  })();

  (function bootAdminNavDrawer() {
    try {
      if (typeof document === 'undefined' || typeof window === 'undefined') return;
      function boot() {
        if (!document.body) return;
        if (document.body.className.indexOf('admin-page') === -1) return;
        if (!document.querySelector('.admin-sidebar')) return;
        initAdminNavDrawer();
        initAdminBottomNav();
      }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
      } else {
        boot();
      }
    } catch (e) {}
  })();
})(window);
