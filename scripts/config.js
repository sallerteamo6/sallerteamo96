/* TrustCom — Supabase connection settings (backend v2).
   Loaded BEFORE app.js on every page.

   How to configure
   ----------------
   1. Supabase dashboard -> your new project -> Project Settings -> API.
   2. Paste the Project URL and the `anon` (public) key below.
   3. Never put the `service_role` key in this file or any other file that
      ships to the browser. service_role bypasses row level security entirely,
      so anything holding it owns the whole database. It belongs in the
      SUPABASE_SERVICE_KEY environment variable, used only by local scripts.

   All application data lives in Supabase; nothing is stored in localStorage. */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------
  //  Configured 2026-09-26 against project mpiqktgpgmbsljqgypzk.
  //  (The trailing /rest/v1/ is stripped automatically below.)
  // ---------------------------------------------------------------------
  var DB_URL = 'https://mpiqktgpgmbsljqgypzk.supabase.co/rest/v1/';
  // The publishable (public) key. Safe to ship: RLS is what protects the data.
  //
  // 2026-09-27: this was the legacy `anon` JWT key, and it has been changed to the
  // project's current `sb_publishable_` key.
  //
  // Why, stated honestly: partway through investigating a sign-in failure the
  // gateway began refusing the legacy key outright -
  //   401 {"code":"UNAUTHORIZED_INVALID_API_KEY","message":"Invalid API key"}
  // on /rest/v1, /auth/v1 and /functions/v1 alike - measured 5 runs out of 5, from
  // two independent clients. It later began answering 200 again, 8 runs out of 8,
  // with the identical key string, so the acceptance was changed on the server
  // rather than by anything in this project. The cause was not identified.
  //
  // So this is not a repair of a key that is broken right now - both keys work at
  // the time of writing. It removes the dependency on the legacy keys, which
  // Supabase is migrating away from and which have now been observed flipping
  // between accepted and refused. If the site ever stops reading data again, check
  // this line first: it is the one value here that can be invalidated on the
  // server without any file in this project changing.
  var DB_ANON_KEY = 'sb_publishable_4Fr10m670_qELHT0H9Kw_g_Czg3EF5D';

  // When true the app renders in read-only mode and no write path is offered.
  var READONLY = false;

  // Normalize: strip trailing slashes and any /rest/v1 suffix.
  DB_URL = String(DB_URL || '').trim().replace(/\/rest\/v1\/*$/, '').replace(/\/+$/, '');

  // A value is a placeholder when it is empty or still contains the literal
  // marker. Note the !== -1: the original === -1 made a real, fully
  // configured URL/KEY count as a placeholder, so ENABLED came out false on
  // every page and supabase-client.js bailed out before loading anything. The
  // app then sat on "Connecting to backend..." forever and sign-in could only
  // fail with "Database not configured".
  var isPlaceholder = function (v) {
    return !v || v.indexOf('YOUR-PROJECT') !== -1;
  };

    global.SITE_CONFIG = {
      DB_URL: DB_URL,
      DB_ANON_KEY: DB_ANON_KEY,
      READONLY: READONLY,
      // Auth is Supabase Auth (GoTrue). The client signs in with
      // supabase.auth.signInWithPassword() and every RLS policy keys off
      // auth.uid(); the app never mints or parses its own tokens.
      USE_SUPABASE_AUTH: true,
      // Wallet sign-in. The signature has to be checked somewhere the person
      // signing cannot reach, so it is checked by a wallet-login Edge Function
      // and not here.
      //
      // 2026-09-27: this was empty, which made walletAuthUrl() fall back to
      // <DB_URL>/functions/v1/wallet-login. The function is deployed and works -
      // but it went in under the auto-generated names `quick-action` and
      // `smooth-endpoint`, not as `wallet-login`, so that fallback URL 404s and
      // the page reports the server as not set up.
      //
      // The name is not cosmetic: Supabase routes /functions/v1/<name> by exact
      // slug, and the CLI/dashboard assigns a random name when one is not given.
      // Both of the following were verified over the network with a real
      // signature: a server-built challenge, a recovered signer matching the
      // address, and a one-time session token returned.
      //
      // THE DURABLE FIX needs no file change: deploy the function again and give
      // it exactly the name `wallet-login`, then set this back to ''. Leaving a
      // name here is fine too, but it has to be changed if the function is ever
      // renamed or deleted.
      WALLET_AUTH_URL: 'https://mpiqktgpgmbsljqgypzk.supabase.co/functions/v1/quick-action',
      ENABLED: !isPlaceholder(DB_URL) && !isPlaceholder(DB_ANON_KEY)
    };
})(window);
