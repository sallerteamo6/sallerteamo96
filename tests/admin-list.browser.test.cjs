/*
 * User Management list, exercised in a real browser.
 *
 * The reported bug was "whenever admin clicks anywhere on the user page, all the
 * other user info disappears". The cause was in the phone-width card list in
 * app.js: it moved the live <td> nodes out of the table, and a MutationObserver
 * on document.body rebuilt every table on any change anywhere on the page, so a
 * click collapsed the row that was open. None of that is visible to a static
 * check, and none of it is reachable from the node suites, so this drives the
 * actual page logic through a headless browser.
 *
 * The harness is the real admin-users.html table markup and the real app.js,
 * with the auth guard stubbed (app.js redirects non-admin pages to login.html,
 * and this file is named admin-users.html so that guard allows it).
 *
 * Skips, with a notice, when no Chrome or Edge is installed.
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

const HARNESS = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>admin-users</title>
<style>
  .admin-row-card-list{display:flex;flex-direction:column;gap:10px;padding:12px}
  .admin-row-card{background:#fff;border:1px solid #e9edf3;border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px}
  .arc-head{display:flex;align-items:center;gap:10px;padding-bottom:10px;border-bottom:1px solid #f0f3f9}
  .admin-row-card.arc-collapsible .arc-body{display:none}
  .admin-row-card.arc-collapsible.arc-open .arc-body{display:block}
  .admin-panel table[data-mc-on]{display:none}
</style></head>
<body class="admin-page">
<div class="admin-panel"><div class="admin-table-wrap">
  <table data-mc-accordion="1">
    <thead><tr><th>Account</th><th>UID</th><th>Balance</th><th>Actions</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
</div></div>
<pre id="out">PENDING</pre>
<script>window.__guardRedir=function(){};window.SITE_CONFIG={DB_URL:'',DB_ANON_KEY:''};</` + `script>
<script src="app.js"></` + `script>
<script>
  var out = [];
  function log(ok, label, extra) {
    out.push((ok ? 'PASS ' : 'FAIL ') + label + (extra != null ? '  [' + extra + ']' : ''));
    document.getElementById('out').textContent = out.join('\\n');
  }
  function assert(cond, label, extra) { log(!!cond, label, extra); }

  function render(n) {
    var h = '';
    for (var i = 1; i <= n; i++) {
      h += '<tr><td><span class="user-name">user' + i + '@example.test</span></td>'
         + '<td>0000' + i + '</td><td>' + (i * 100) + ' USDT</td>'
         + '<td><button class="action-btn" onclick="markEdit(\\'user' + i + '\\')">Edit</button></td></tr>';
    }
    document.getElementById('rows').innerHTML = h;
  }
  var edits = [];
  function markEdit(uid) { edits.push(uid); }

  var USERS = 4;
  render(USERS);
  var tbl = document.querySelector('.admin-panel table');
  var tbody = document.getElementById('rows');

  TrustApp.initAdminTablesMobile();
  var cards = document.querySelectorAll('.admin-row-card');
  assert(cards.length === USERS, 'one card per user', cards.length);
  assert(tbl.getAttribute('data-mc-on') === '1', 'table marked as carded');
  var liveCells = 0;
  for (var r = 0; r < tbody.rows.length; r++)
    for (var c = 0; c < tbody.rows[r].cells.length; c++)
      if ((tbody.rows[r].cells[c].textContent || '').trim()) liveCells++;
  assert(liveCells === USERS * 4, 'live table still holds every cell (not moved out)', liveCells);

  var btns = document.querySelectorAll('.admin-row-card .action-btn');
  assert(btns.length === USERS, 'each card kept its action button', btns.length);
  if (btns[0]) btns[0].click();
  assert(edits.length === 1 && edits[0] === 'user1', 'card action button still calls its handler', edits.join(','));

  var heads = document.querySelectorAll('.admin-row-card .arc-head');
  heads[1].click();
  var opened = document.querySelectorAll('.admin-row-card.arc-open');
  assert(opened.length === 1, 'exactly one row open after a tap', opened.length);
  assert(opened[0] === document.querySelectorAll('.admin-row-card')[1], 'the tapped row is the open one');
  heads[2].click();
  assert(document.querySelectorAll('.admin-row-card.arc-open').length === 2,
    'a second tap opens a second row without closing the first',
    document.querySelectorAll('.admin-row-card.arc-open').length);
  assert(tbody.rows.length === USERS, 'a click does not disturb the table rows');

  setTimeout(function () {
    render(USERS);
    setTimeout(function () {
      var after = document.querySelectorAll('.admin-row-card');
      assert(after.length === USERS, 'all users still listed after a re-render', after.length);
      assert(document.querySelectorAll('.admin-row-card.arc-open').length === 2,
        'the open rows survived the re-render', document.querySelectorAll('.admin-row-card.arc-open').length);
      var names = [];
      for (var i = 0; i < after.length; i++) {
        var nn = after[i].querySelector('.user-name');
        names.push(nn ? nn.textContent : '?');
      }
      assert(names.join(',') === 'user1@example.test,user2@example.test,user3@example.test,user4@example.test',
        'the exact same users, in order', names.join(','));

      var before = document.querySelectorAll('.admin-row-card')[0];
      var p = document.createElement('div');
      p.textContent = 'an unrelated toast';
      document.body.appendChild(p);
      p.remove();
      setTimeout(function () {
        assert(document.querySelectorAll('.admin-row-card')[0] === before,
          'an unrelated DOM change did not rebuild the card list');
        assert(document.querySelectorAll('.admin-row-card.arc-open').length === 2,
          'open rows still open after an unrelated change',
          document.querySelectorAll('.admin-row-card.arc-open').length);

        document.getElementById('rows').innerHTML = '<tr><td colspan="4"><div class="empty-state">No users</div></td></tr>';
        setTimeout(function () {
          assert(document.querySelectorAll('.admin-row-card').length === 0,
            'no leftover card panel when the list empties', document.querySelectorAll('.admin-row-card').length);
          assert(!tbl.getAttribute('data-mc-on'), 'table restored so its empty state shows');
          var es = document.querySelector('.empty-state');
          assert(!!es && es.textContent === 'No users', 'the empty state is visible');

          render(3);
          setTimeout(function () {
            assert(document.querySelectorAll('.admin-row-card').length === 3,
              'list repopulates correctly', document.querySelectorAll('.admin-row-card').length);
            assert(tbl.getAttribute('data-mc-on') === '1', 'table carded again');
            document.getElementById('out').textContent = out.join('\\n') + '\\nDONE\\n' +
              (out.some(function (l) { return l.indexOf('FAIL') === 0; }) ? 'RESULT:FAIL' : 'RESULT:OK');
          }, 400);
        }, 400);
      }, 400);
    }, 400);
  }, 400);
</` + `script>
</body></html>`;

if (!exe) {
  console.log('SKIP: no Chrome or Edge found, so the admin list browser test did not run. ' +
    'The node suites still cover the non-DOM parts of this change.');
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adminlist-'));
try {
  fs.copyFileSync(path.join(root, 'app.js'), path.join(dir, 'app.js'));
  fs.writeFileSync(path.join(dir, 'admin-users.html'), HARNESS, 'utf8');
  const url = 'file:///' + path.join(dir, 'admin-users.html').replace(/\\/g, '/');
  const dom = execFileSync(exe, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=390,900', '--virtual-time-budget=9000',
    '--user-data-dir=' + path.join(dir, 'profile'), '--dump-dom', url
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

  const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
  if (!m) { console.error('FAIL: the harness produced no output. DOM was:\n' + dom.slice(0, 800)); process.exitCode = 1; }
  else {
    const report = m[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    process.stdout.write(report.replace(/^/gm, '  ') + '\n');
    if (!/RESULT:OK/.test(report)) {
      console.error('FAIL: the admin user list lost rows or its open state.');
      process.exitCode = 1;
    } else {
      console.log('PASS: admin list is non-destructive, click-stable and keeps every user across re-renders (real browser)');
    }
  }
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}
