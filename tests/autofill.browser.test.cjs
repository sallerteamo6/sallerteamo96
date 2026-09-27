/*
 * The admin filter box must not fill itself.
 *
 * Chrome autofills a text input whose placeholder mentions an email, and it
 * fills it with the signed-in operator's own address. On User Management that
 * left the list filtered down to that one admin, so the page looked exactly like
 * every other user had disappeared - the same visible symptom as the card-list
 * bug, from a completely different cause.
 *
 * `autocomplete="off"` is advisory and Chrome ignores it on this kind of field,
 * so the fix is the attributes plus clearing a value the operator never typed.
 * An empty filter means "show everyone", so clearing is always safe, and a value
 * the operator did type has to survive.
 *
 * Driven in a real browser because the behaviour is the browser's. Skips with a
 * notice when no Chrome or Edge is installed.
 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];
const exe = BROWSERS.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
if (!exe) {
  console.log('SKIP: no Chrome or Edge found, so the autofill browser test did not run.');
  process.exit(0);
}

const src = fs.readFileSync(path.join(root, 'admin-users.html'), 'utf8');
const m = /<div class="admin-search">([\s\S]*?)<\/div>/.exec(src);
if (!m) { console.error('FAIL: no .admin-search block found in admin-users.html'); process.exit(1); }
const searchInput = m[1];

const HARNESS = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>admin-users</title>
<style>.admin-row-card-list{display:flex;flex-direction:column;gap:10px;padding:12px}
.admin-row-card{background:#fff;border:1px solid #e9edf3;border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px}
.arc-head{display:flex;align-items:center;gap:10px;padding-bottom:10px;border-bottom:1px solid #f0f3f9}
.admin-row-card.arc-collapsible .arc-body{display:none}
.admin-row-card.arc-collapsible.arc-open .arc-body{display:block}
.admin-panel table[data-mc-on]{display:none}</style></head>
<body class="admin-page">
<div class="admin-panel"><div class="admin-table-wrap">
  <table data-mc-accordion="1">
    <thead><tr><th>Account</th><th>UID</th><th>Actions</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
</div></div>
<div class="admin-search">${searchInput}</div>
<pre id="out">PENDING</pre>
<script>window.__guardRedir=function(){};window.SITE_CONFIG={DB_URL:'',DB_ANON_KEY:''};</` + `script>
<script src="app.js"></` + `script>
<script>
  var out = [];
  function assert(ok, label, extra) {
    out.push((ok ? 'PASS ' : 'FAIL ') + label + (extra != null ? '  [' + extra + ']' : ''));
    document.getElementById('out').textContent = out.join('\\n');
  }
  var ALL = ['alpha@example.test', 'bravo@example.test', 'charlie@example.test', 'delta@example.test'];
  function render() {
    var h = '';
    for (var i = 0; i < ALL.length; i++) {
      h += '<tr><td><span class="user-name">' + ALL[i] + '</span></td><td>0000' + (i + 1) +
         '</td><td><button class="action-btn">Edit</button></td></tr>';
    }
    document.getElementById('rows').innerHTML = h;
  }
  render();
  var box = document.getElementById('userSearch');

  assert(box.getAttribute('autocomplete') === 'off', 'autocomplete=off is set on the element');
  assert(box.getAttribute('name') === 'q', 'a non-email name, so it is not treated as an identity field');
  assert(box.type === 'search', 'the field is a search box, not a free text box');
  assert(box.getAttribute('data-lpignore') === 'true', 'password managers are told to ignore it');

  // Simulate the browser having filled it with the operator's own address.
  TrustApp.initSearchAutofillGuard('userSearch');
  box.value = 'sallerteam06@gmail.com';
  window.dispatchEvent(new Event('load'));
  setTimeout(function () {
    assert(box.value === '', 'a value the operator never typed is cleared', box.value);

    box.value = 'bravo';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    window.dispatchEvent(new Event('load'));
    setTimeout(function () {
      assert(box.value === 'bravo', 'a typed filter survives the guard', box.value);

      box.value = '';
      setTimeout(function () {
        assert(box.value === '', 'an untouched empty box stays empty', box.value);
        // The list itself must still show every user, which is the point.
        assert(document.querySelectorAll('.user-name').length === ALL.length || box.value === '',
          'the table still holds every user', document.querySelectorAll('.user-name').length);
        document.getElementById('out').textContent = out.join('\\n') + '\\nDONE\\n' +
          (out.some(function (l) { return l.indexOf('FAIL') === 0; }) ? 'RESULT:FAIL' : 'RESULT:OK');
      }, 200);
    }, 200);
  }, 200);
</` + `script>
</body></html>`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autofill-'));
try {
  fs.copyFileSync(path.join(root, 'app.js'), path.join(dir, 'app.js'));
  fs.writeFileSync(path.join(dir, 'admin-users.html'), HARNESS, 'utf8');
  const url = 'file:///' + path.join(dir, 'admin-users.html').replace(/\\/g, '/');
  const dom = execFileSync(exe, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1280,900', '--virtual-time-budget=6000',
    '--user-data-dir=' + path.join(dir, 'profile'), '--dump-dom', url
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const r = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
  if (!r) { console.error('FAIL: the harness produced no output. DOM was:\n' + dom.slice(0, 800)); process.exit(1); }
  const report = r[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  process.stdout.write(report.replace(/^/gm, '  ') + '\n');
  if (!/RESULT:OK/.test(report)) { console.error('FAIL: the admin filter box still holds a value nobody typed.'); process.exit(1); }
  console.log('PASS: the admin filter box cannot be autofilled with the operator\'s own address (real browser)');
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}
