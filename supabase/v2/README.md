# Backend v2

Replacement for the v1 Supabase backend. **Apply to a brand-new Supabase
project**; the old project is retained only as an archive.

## Files, in the order to run them

| # | File | What it does |
|---|------|--------------|
| 1 | `01_schema.sql` | tables, enums, indexes, triggers |
| 2 | `02_rls.sql` | row level security policies + grants |
| 3 | `03_functions.sql` | RPCs: contract open/settle, admin review, ledger |
| 4 | `04_realtime.sql` | realtime publication |
| 5 | `05_seed.sql` | markets, durations, AI products, settings, addresses |
| 6 | `06_auth.sql` | Supabase Auth trigger + manual dashboard checklist |
| 7 | `07_signup_fix.sql` … `16_admin_session_fixes.sql` | additive upgrades; run only the ones your project is missing |
| 8 | `17_profit_mode_and_settlement.sql` | **required for trading.** `open_trade` + `settle_trade` so an order's stake and payout both go through `post_ledger`, and the audited `admin_set_profit_mode` switch. Without it every order fails with "function not found". |

Run each file in the Supabase SQL editor. `06_auth.sql` also contains settings
that can only be applied in the dashboard — follow the checklist at the bottom
of that file, especially **`DB_PRIVILEGE = anon`**, without which RLS is
bypassed and every table is world-readable.

### Which settler runs

`settle_contract` and `settle_expired` are `service_role` only and are driven by
`scripts/settle.mjs` on a timer, quoting a real price. `settle_trade` is the
owner-only path the countdown uses when the page is open; it takes the exit
price the page was showing, uses it only to decide the *direction* of the move,
and rolls the win against the contract's quoted odds in the database. Running
`settle.mjs` is still the right production arrangement, and the two agree
because both consult `profit_mode_for()`.

## What was wrong with v1

v1 was a localStorage mirror. The authoritative store was a single JSON blob
per logical key in `app_meta`:

- the **anon** key had `SELECT` on `app_meta`, so any visitor could read every
  user's accounts, balances, KYC documents and chat messages;
- passwords were stored in cleartext in the same readable blob;
- `app_meta` was also anon-writable, so any client could rewrite any record;
- balances were `double precision` on a money path;
- "open a contract", "settle a contract" and "adjust a balance" were all
  client-side operations, so the client decided who won and who got paid;
- there was no referential integrity between users, balances and transactions;
- the live schema had drifted far past `supabase/schema.sql` — it carried a
  second generation of tables (`user_balances`, `transactions`, `ai_orders`,
  `admin_settings`, `sessions`) alongside the documented ones, and
  `users.uid` was `bigint` where the schema file said `text`.

## What v2 changes

- **Identity comes from Supabase Auth.** `public.users` is a profile keyed by
  `auth.users.id`. GoTrue signs the JWT, so the browser cannot forge an
  identity. A hand-rolled session table was rejected deliberately: this is a
  static site holding only the anon key, so anything it puts in
  `Authorization: Bearer` is attacker-controlled, and `current_uid()` reading
  `request.jwt.claims` would be a full authentication bypass.
- **No world-readable business table.** The only `anon` reads are
  `coin_addresses`, `products`, `product_durations`, `investment_products` and
  `app_settings` — everything a signed-out visitor legitimately needs.
- **Money is `numeric(24,8)`** and moves only through `SECURITY DEFINER`
  functions that write an immutable `ledger_entries` row in the same
  transaction. `balances` is a cache of the ledger.
- **Server-decided payouts.** `open_contract` reads the multiplier from
  `product_durations` instead of accepting it from the caller, and
  `settle_contract` is `service_role` only, so a browser cannot declare the
  price that decides who wins. Settlement is idempotent under row lock.
- **Privilege-escalation guards.** Triggers refuse `is_admin` changes, status
  transitions and reviewed-by stamping from non-admins, so an
  `owns_or_admin` policy cannot be used to edit a protected column.
- **Append-only `audit_log`** for every privileged action, with no
  update/delete policy granted to any client role.

## Front-end migration still required

`scripts/config.js` and `scripts/supabase-client.js` now point at v2, but
**`scripts/db.js` and `app.js` still speak v1** and the site will not work
against v2 until they are migrated. `db.js` currently issues raw
`fetch` calls to `/rest/v1/` with the anon key, which v2 will reject for any
authenticated table.

### Table mapping

| v1 (db.js) | v2 | Notes |
|---|---|---|
| `users` | `users` | `uid: bigint` → `id: uuid`; no `password` column (GoTrue owns it) |
| `user_balances` | `balances` | + `locked_amount` |
| `transactions` | `transactions` | + `reviewed_by`, `reviewed_at` |
| `trades` | `contracts` | `uid`, `pair`→`product_id`+`coin`, `price`→`entry_price`/`settle_price`, + `expires_at`, `payout_pct` |
| `ai_orders` | `investments` | `uid`→`uid`, `account`, `amount`→`principal`, `product`→`product_id` |
| `loans` | `loans` | `amount`→`principal`, + `note` |
| `chat_messages` | `chat_threads` + `chat_messages` | now threaded; `from_who`→`from_role`, `text`→`body`, `mid`→`id` |
| `verifications` | `verifications` | + `rejection_reason` |
| `coin_addresses` | `coin_addresses` | PK is now `(coin, network)` |
| `admin_settings` | `app_settings` | `key`/`value: jsonb` |
| — | `ledger_entries`, `products`, `product_durations`, `investment_products`, `audit_log` | new |

### Write paths that must become RPC calls

| Old client write | v2 replacement |
|---|---|
| insert into `trades` | `rpc('open_contract', {...})` |
| update trade to settled / pay out | `rpc('settle_contract', ...)` — **service_role only**, move to a server job |
| adjust a balance | `rpc('admin_adjust_balance', {...})` (admin) |
| set transaction status | `rpc('admin_set_transaction_status', {...})` (admin) |
| set loan status | `rpc('admin_set_loan_status', {...})` (admin) |
| approve KYC | `rpc('admin_review_verification', {...})` (admin) |
| login | `supabase.auth.signInWithPassword(...)`, then persist the session |
| register | `supabase.auth.signUp(...)` — the profile row is created by trigger |

Every `trades` / `contracts` row read also has to stop relying on the anon key
and start sending the signed-in user's JWT, or RLS returns nothing.

## Old project

`https://ilqgldgilsmbillfuham.supabase.co` — retired, and its user data wiped.
The v1 SQL files are still in `supabase/` alongside this directory: they are
kept as a record of how the old backend was put together, and as the reference
for the table mapping above. They are **not** part of the v2 setup — do not run
them against a project you have applied v2 to.

Two things could not be brought back and are gone for good:

- **`service-key.txt` is now a placeholder.** The original held a `service_role`
  key in plaintext. Re-enter it if a local script needs it, but treat it as
  compromised and rotate it in the old project: **Project Settings → API →
  Reset** under the service keys. Deleting a file does not invalidate a key, and
  that key bypasses RLS entirely.
- **The pre-wipe backup is gone**, so the 13 users, 4 loans, KYC record and
  chat history that were deleted from the live database cannot be recovered
  from this repository. Supabase point-in-time recovery (7 days on paid plans)
  is the only remaining route.

## Maintenance scripts

All read credentials from the environment; none of them store a key:

```powershell
$env:SUPABASE_URL = 'https://xxxx.supabase.co'
$env:SUPABASE_SERVICE_KEY = 'eyJ...'
```

| Script | Purpose |
|---|---|
| `node scripts/backup.mjs [out.json]` | full dump to JSON. Discovers tables from the live schema. Aborts rather than writing a partial backup. |
| `node scripts/restore.mjs <out.json> [--dry-run]` | upsert a dump back. Re-running is safe. |
| `node scripts/wipe-data.mjs [--dry-run\|--confirm]` | empty every table except `coin_addresses`. Dry run by default; verifies afterwards. |

Backups contain real user data and session material, so they are gitignored
(`supabase/pre-reset-backup-*.json`) — store them outside the repository.
