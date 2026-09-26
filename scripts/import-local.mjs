// Trust static clone -> Supabase import tool (Node 18+, plain fetch, service-role key).
//
// Usage:
//   1. In a browser, open export-local.html and download trust-backup.json.
//   2. Service key is read from supabase/service-key.txt OR the
//      SUPABASE_SERVICE_KEY env var. URL from supabase/service-url.txt OR
//      SUPABASE_URL env var.
//   3. Run:   node scripts/import-local.mjs trust-backup.json
//
// This writes the app_meta blobs (so the site picks them up immediately) plus
// the detailed tables, and records a row in `backups`.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [here, join(here, '..', 'supabase')];
const txt = (name) => {
  for (const dir of candidates) {
    const p = join(dir, name);
    if (existsSync(p)) {
      const v = readFileSync(p, 'utf8').trim();
      if (v) return v;
    }
  }
  return '';
};

const url = (process.env.SUPABASE_URL || txt('service-url.txt') || '').replace(/\/rest\/v1\/*$/, '').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_KEY || txt('service-key.txt') || '';

if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY (env), or create supabase/service-url.txt and supabase/service-key.txt.');
  process.exit(1);
}

const file = process.argv[2] || 'trust-backup.json';
if (!existsSync(file)) {
  console.error('Backup file not found:', file);
  console.error('Open export-local.html in a browser, download trust-backup.json, then rerun.');
  process.exit(1);
}
const backup = JSON.parse(readFileSync(file, 'utf8'));
const data = backup.data || {};
console.log('Importing', Object.keys(data).length, 'localStorage keys into', url);

async function rest(table, opts = {}) {
  const headers = {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Accept-Profile': 'public',
    Prefer: opts.method === 'POST'
      ? 'return=minimal,resolution=merge-duplicates'
      : 'return=minimal'
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const path = join(here, '..') + '';
  const res = await fetch(`${url}/rest/v1/${table}${opts.q || ''}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} on ${table}${opts.q || ''}: ${t.slice(0, 200)}`);
  }
  if (opts.method === 'GET') return res.json();
  return null;
}

const app_meta = (id, json) => rest('app_meta', { q: `?id=eq.${encodeURIComponent(id)}&select=id` })
  .then((rows) => {
    const row = { id, json: typeof json === 'string' ? json : JSON.stringify(json ?? ''), version: 1 };
    return rows.length
      ? rest('app_meta', { method: 'PATCH', q: `?id=eq.${encodeURIComponent(id)}`, body: { json: row.json, version: row.version } })
      : rest('app_meta', { method: 'POST', body: row });
  })
  .then(() => console.log('  app_meta', id, 'ok'));

const blobMap = {
  'trustUsers': 'users', 'trustBalances': 'balances', 'trustTxns': 'txns',
  'trustLoans': 'loans', 'trustTrades': 'trades', 'trustOrders': 'orders',
  'trustAIOrders': 'aiorders', 'trustChat': 'chat', 'trustChatGreeted': 'greeted',
  'trustVerifications': 'verifications', 'trustCoinAddresses': 'addresses',
  'trustProfitMode': 'profitMode', 'trustAppConfig': 'config'
};

const asArr = (v) => (Array.isArray(v) ? v : []);
const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

async function main() {
  const jobs = [];
  for (const key of Object.keys(data)) {
    const id = blobMap[key];
    if (id) jobs.push(app_meta(id, data[key]));
  }

  const users = asArr(data.trustUsers).map((u) => ({
    uid: String(u.uid), account: String(u.account || ''), password: String(u.password || ''),
    is_wallet: !!u.isWallet, status: String(u.status || 'active'),
    referred_by: u.referredBy != null ? String(u.referredBy) : null,
    invited: u.invited || [], role: u.role || null, is_admin: !!u.isAdmin, created_at: u.createdAt || null
  }));
  if (users.length) {
    const { error } = await rest('users', { method: 'POST', body: users }).catch((e) => ({ error: e }));
    if (error) jobs.push(Promise.reject(error)); else { jobs.push(Promise.resolve()); console.log('  users', users.length, 'rows ok'); }
  }

  const balObj = asObj(data.trustBalances);
  const balances = [];
  for (const uid of Object.keys(balObj)) {
    for (const coin of Object.keys(balObj[uid] || {})) {
      const amt = parseFloat(balObj[uid][coin]);
      if (isFinite(amt) && amt !== 0) balances.push({ uid, coin, amount: amt });
    }
  }
  if (balances.length) {
    jobs.push(rest('balances', { method: 'POST', body: balances }).then(() => console.log('  balances', balances.length, 'rows ok')));
  }

  const txns = asArr(data.trustTxns).map((t) => ({
    id: String(t.id), uid: String(t.uid || ''), account: String(t.account || ''),
    type: String(t.type || 'deposit'), coin: String(t.coin || 'USDT'),
    amount: parseFloat(t.amount) || 0, status: String(t.status || 'pending'),
    note: String(t.note || ''), proof: String(t.proof || ''), proof_name: String(t.proofName || ''),
    dir: t.dir || null, created_at: t.createdAt || null
  }));
  if (txns.length) {
    jobs.push(rest('txns', { method: 'POST', body: txns }).then(() => console.log('  txns', txns.length, 'rows ok')));
  }

  const chatObj = asObj(data.trustChat);
  const messages = [];
  for (const uid of Object.keys(chatObj)) {
    for (const m of asArr(chatObj[uid])) {
      messages.push({
        mid: String((m && m.mid) || ('m' + Math.random().toString(36).slice(2, 10))),
        uid, from_who: (m && m.from === 'admin') ? 'admin' : 'user',
        text: String((m && m.text) || ''), attachments: (m && m.attachments) || [],
        edited: !!(m && m.edited), edited_at: (m && m.editedAt) || null,
        at: (m && m.at) || null
      });
    }
  }
  if (messages.length) {
    jobs.push(rest('chat_messages', { method: 'POST', body: messages }).then(() => console.log('  chat_messages', messages.length, 'rows ok')));
  }

  jobs.push(rest('backups', { method: 'POST', body: { label: file, full_json: data } }).then(() => console.log('  backups row ok')));

  await Promise.all(jobs);
  console.log('Done. Re-open the site: pages now read from Supabase.');
}

main().catch((e) => { console.error('Import failed:', e.message); process.exit(1); });