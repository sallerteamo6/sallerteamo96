/*
 * Supabase Realtime Client Initializer
 * Loads the Supabase JS client and creates the realtime connection.
 */
(function (global) {
  'use strict';

  var SUPABASE_URL = 'https://ilqgldgilsmbillfuham.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlscWdsZGdpbHNtYmlsbGZ1aGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1OTYyMDIsImV4cCI6MjEwNDE3MjIwMn0.JkgdRwafJ-hvvM3YvnVqbDCY7OeqttgkaAxnN7iB-e8';

  // Try to load from config if available
  if (typeof SITE_CONFIG !== 'undefined') {
    SUPABASE_URL = SITE_CONFIG.DB_URL;
    SUPABASE_ANON_KEY = SITE_CONFIG.DB_ANON_KEY;
  }

  // Load Supabase client from CDN
  function loadSupabase() {
    return new Promise(function (resolve, reject) {
      if (global.supabase) return resolve(global.supabase);
      var script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      script.onload = function () { resolve(global.supabase); };
      script.onerror = function () { reject(new Error('Failed to load Supabase client')); };
      document.head.appendChild(script);
    });
  }

  // Initialize and expose
  loadSupabase().then(function (supabaseLib) {
    global.supabase = supabaseLib.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      realtime: { params: { eventsPerSecond: 50 } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    console.log('Supabase realtime client initialized (anon, no session)');
    if (global.DB && global.DB._startRealtime) {
      global.DB._startRealtime();
    }
  }).catch(function (e) { console.error('Supabase init failed:', e); });

})(window);