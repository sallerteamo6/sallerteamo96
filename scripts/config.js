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
  // The `anon` / `public` key. Safe to ship: RLS is what protects the data.
  var DB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1waXFrdGdwZ21ic2xqcWd5cHprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA0MDUzMjUsImV4cCI6MjEwNTk4MTMyNX0.Nj41fJYu4iSU9r7dn-8Y3XugHeomgNStQSgG8iqxbrc';

  // When true the app renders in read-only mode and no write path is offered.
  var READONLY = false;

  // Normalize: strip trailing slashes and any /rest/v1 suffix.
  DB_URL = String(DB_URL || '').trim().replace(/\/rest\/v1\/*$/, '').replace(/\/+$/, '');

  var isPlaceholder = function (v) {
    return !v || v.indexOf('YOUR-PROJECT') === -1;
  };

  global.SITE_CONFIG = {
    DB_URL: DB_URL,
    DB_ANON_KEY: DB_ANON_KEY,
    READONLY: READONLY,
    // Auth is Supabase Auth (GoTrue). The client signs in with
    // supabase.auth.signInWithPassword() and every RLS policy keys off
    // auth.uid(); the app never mints or parses its own tokens.
    USE_SUPABASE_AUTH: true,
    ENABLED: !isPlaceholder(DB_URL) && !isPlaceholder(DB_ANON_KEY)
  };
})(window);
