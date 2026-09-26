/*
 * Supabase client initializer (backend v2).
 *
 * Creates the client with the anon key and hands session handling to Supabase
 * Auth. Credentials and sessions live in auth.users / auth.sessions, which
 * this project never reads or writes directly: GoTrue signs the JWT, so the
 * browser cannot forge an identity, and every RLS policy keys off auth.uid().
 *
 * Requires scripts/config.js to have been loaded first.
 *
 * Loading strategy
 * ----------------
 * The library is served from scripts/vendor/supabase.umd.js, which is committed
 * to this repo, and the CDN is only a fallback. Previously the CDN was the ONLY
 * source, so on a host that cannot reach cdn.jsdelivr.net (a corporate network,
 * an ad blocker, or a region where jsdelivr is slow) window.supabase never
 * appeared. DB._waitForClient() polls for 10s and then rejects, so every page
 * sat on "Connecting to backend..." and sign-in failed after ~25s with a
 * confusing "Database not configured" message. Serving the file ourselves makes
 * the client available with no third-party round trip, which also removes the
 * startup race the injected <script> used to introduce.
 */
(function (global) {
  'use strict';

  var cfg = global.SITE_CONFIG || {};

  if (!cfg.ENABLED) {
    console.warn('Supabase not configured: set DB_URL and DB_ANON_KEY in scripts/config.js');
    return;
  }

  var LOCAL_SRC = 'scripts/vendor/supabase.umd.js?v=20260926d';
  var CDN_SRC = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';

  // Load one UMD build and hand back the library namespace. Rejects on error
  // AND on timeout, so a hanging request cannot wedge startup.
  //
  // The presence test is createClient, not auth: the UMD namespace exports
  // createClient, whereas auth only exists on a client INSTANCE (what
  // createClient returns). Testing for .auth here rejected every successful
  // load and pushed the app onto the CDN fallback, which failed the same way.
  function hasLib() {
    return !!(global.supabase && typeof global.supabase.createClient === 'function');
  }

  function inject(src, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (hasLib()) return resolve(global.supabase);

      var settled = false;
      var script = document.createElement('script');
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        script.onload = script.onerror = null;
        reject(new Error('Timed out after ' + (timeoutMs / 1000) + 's loading ' + src));
      }, timeoutMs);

      script.src = src;
      script.async = false;
      script.onload = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (hasLib()) {
          resolve(global.supabase);
        } else {
          reject(new Error(src + ' loaded but did not define window.supabase.createClient'));
        }
      };
      script.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('Failed to load ' + src));
      };
      document.head.appendChild(script);
    });
  }

  // Exposed so the pages can report a startup failure instead of leaving the
  // sign-in button spinning. Resolves once the client exists (or the error is
  // recorded on window.__supabaseError).
  global.__supabaseReady = inject(LOCAL_SRC, 8000)
    .catch(function (e) {
      console.warn('[supabase] local vendor unavailable (' + e.message + '), falling back to CDN');
      return inject(CDN_SRC, 20000);
    })
    .then(function (lib) {
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
      return global.supabase;
    })
    .catch(function (e) {
      global.__supabaseError = e.message || String(e);
      console.error('[supabase] could not initialise:', global.__supabaseError);
    });
})(window);
