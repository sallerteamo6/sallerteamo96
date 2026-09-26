/* TrustCom static clone — Supabase connection settings.
   Loaded BEFORE app.js on every page. Edit the values below directly; all
   application data lives in Supabase, nothing is stored in localStorage. */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------
  //  EDIT THESE to point at YOUR Supabase project.
  // ---------------------------------------------------------------
  // Create a table: Supabase dashboard -> Project Settings -> API.
  // (The trailing /rest/v1/ is added automatically; don't include it.)
  var DB_URL = 'https://ilqgldgilsmbillfuham.supabase.co';
  var DB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlscWdsZGdpbHNtYmlsbGZ1aGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1OTYyMDIsImV4cCI6MjEwNDE3MjIwMn0.JkgdRwafJ-hvvM3YvnVqbDCY7OeqttgkaAxnN7iB-e8';
  // The service-role key is NOT stored here (this file can be public).
  var DB_SERVICE_KEY = '';

  // When true, the site can read from Supabase but only writes through
  // client-safe tables. Detailed writes stay service-role/SQL only.
  var READONLY = false;

  // Normalize: strip trailing slashes and any /rest/v1 suffix.
  DB_URL = String(DB_URL || '').trim().replace(/\/rest\/v1\/*$/, '').replace(/\/+$/, '');

  global.SITE_CONFIG = {
    DB_URL: DB_URL,
    DB_ANON_KEY: DB_ANON_KEY,
    DB_SERVICE_KEY: DB_SERVICE_KEY,
    READONLY: READONLY,
    ENABLED: !!DB_URL && DB_URL.indexOf('YOUR-PROJECT') === -1 && !!DB_ANON_KEY && DB_ANON_KEY.indexOf('YOUR-PROJECT') === -1
  };
})(window);