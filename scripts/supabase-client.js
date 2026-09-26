/*
 * Supabase client initializer (backend v2).
 *
 * Creates the client with the anon key and hands session handling to Supabase
 * Auth. Credentials and sessions live in auth.users / auth.sessions, which
 * this project never reads or writes directly: GoTrue signs the JWT, so the
 * browser cannot forge an identity, and every RLS policy keys off auth.uid().
 *
 * Requires scripts/config.js to have been loaded first.
 */
(function (global) {
  'use strict';

  var cfg = global.SITE_CONFIG || {};

  if (!cfg.ENABLED) {
    console.warn('Supabase not configured: set DB_URL and DB_ANON_KEY in scripts/config.js');
    return;
  }

  function loadSupabase() {
    return new Promise(function (resolve, reject) {
      if (global.supabase) return resolve(global.supabase);
      var script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      script.onload = function () { resolve(global.supabase); };
      script.onerror = function () { reject(new Error('Failed to load Supabase client')); };
      document.head.appendChild(script);
    });
  }

  loadSupabase().then(function (lib) {
    global.supabase = lib.createClient(cfg.DB_URL, cfg.DB_ANON_KEY, {
      auth: {
        // Keep the session: the signed-in user must stay signed in across
        // page loads, unlike the v1 client which explicitly disabled this and
        // re-authenticated on every navigation.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // Refresh a little before expiry rather than at the moment it lapses,
        // so a request does not fail on a token that expired mid-navigation.
        expiryMargin: 60
      },
      realtime: { params: { eventsPerSecond: 50 } },
      global: {
        headers: { 'X-Client-Info': 'trustcom-web/2.0' }
      }
    });

    console.log('Supabase client ready (v2, Supabase Auth)');

    if (global.DB && global.DB._startRealtime) {
      global.DB._startRealtime();
    }
  }).catch(function (e) {
    console.error('Supabase init failed:', e);
  });
})(window);
