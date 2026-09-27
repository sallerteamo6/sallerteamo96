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
  // 2026-09-27: this used to be the legacy `anon` JWT key, and it no longer works.
  // Every request through it was refused by the project gateway with
  //   401 {"code":"UNAUTHORIZED_INVALID_API_KEY","message":"Invalid API key"}
  // on /rest/v1, /auth/v1 and /functions/v1 alike, so the site could not read or
  // write anything. Replaced with the project's current `sb_publishable_` key,
  // which answers 200 on the same requests. Verified over 5 consecutive runs:
  // legacy key 401, publishable key 200, identical URL and headers.
  //
  // If sign-in stops working again, check this line first. It is the one value here
  // that can be invalidated on the server without any file in this project changing.
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
      // signing cannot reach, so it is checked by the wallet-login Edge Function
      // and not here. Left empty it defaults to <DB_URL>/functions/v1/wallet-login,
      // which is where `supabase functions deploy wallet-login` puts it.
      //
      // Until that function is deployed, walletLogin() says so plainly instead of
      // connecting and then refusing, which is what it used to do.
      WALLET_AUTH_URL: '',
      ENABLED: !isPlaceholder(DB_URL) && !isPlaceholder(DB_ANON_KEY)
    };
})(window);
