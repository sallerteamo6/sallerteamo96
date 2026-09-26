# app.js migration to backend v2

`scripts/db.js` has been rewritten as a v2 adapter that keeps the v1 method
names, argument order, return shapes and `trustsync:*` events. Most of app.js
will keep working. This file lists the places it will not, and why.

Nothing here is optional. The v1 code depends on a security model that no longer
exists: a client-minted session token, a client-side password hash, and a
numeric uid the browser chose for itself.

---

## 1. Blocking: code that cannot work at all

### 1.1 Password hashing — lines ~1634, ~2866, ~2868

```js
var h = DB._hashPassword(password, g.created_at || new Date().toISOString());
if (!(u.password_hash && DB._verifyPassword(...)))
var nh = DB._hashPassword(newPassword, u.created_at);
```

`_hashPassword` was `'hash_' + btoa(password + ':' + date)`. That is base64, not
a hash: `u.password_hash` was the plaintext password with a prefix, and v1
served it to every visitor through the anon key. `_hashPassword` and
`_verifyPassword` now throw by design.

- **Register** (`~1634`): delete the line. `DB.register()` takes the plaintext
  password and GoTrue hashes it server-side.
- **Change password** (`~2866-2868`): GoTrue requires re-authentication before a
  password change. Replace the whole block with
  `supabase.auth.updateUser({ password: newPassword })`, gated behind
  `supabase.auth.reauthenticate()`. There is no `u.password_hash` column any
  more, so the existing check has nothing to read.

### 1.2 uid generation — lines ~1372, ~1707

```js
var gid = parseInt(DB._genUid(used), 10);
var wuid = parseInt(DB._genUid(used), 10);
```

v1 generated a 6-digit id in the browser and wrote it into the users row. The
primary key is now a uuid minted by GoTrue. Remove both call sites; use
`DB.me().uid` after sign-in. `DB._genUid()` now returns the signed-in uuid.

### 1.3 Guest accounts — lines ~1320, ~1330, ~1351, ~1766

`DB.createSession(tok, null, ...)` created a session row for a visitor browsing
before signing up. v2 has no guest accounts: there is no row to create, and
nothing to leak. The adapter accepts the call and updates the profile instead,
so these will not throw, but the guest flow no longer does anything meaningful.
Remove the guest branch rather than leaving it as a no-op.

---

## 2. uid is now a uuid string, not a number

`uid` appears 209 times in app.js. v1's uid was a 6-digit integer; v2's is a
36-character uuid.

Safe as-is: any comparison that already wraps in `String(...)`, which the v1
code mostly does.

Must change:

| Pattern | Why it breaks | Fix |
|---|---|---|
| `parseInt(uid, 10)` | NaN on a uuid | remove; use the string |
| `uid.toFixed(2)` | uuid has no `toFixed` | parse the numeric first |
| `String(uid).padStart(6, '0')` | pads to 6 digits, no longer meaningful | remove |
| uid stored in a numeric `<input>` | renders a uuid | use `display_name` or `account` |
| `Number(uid)` as a cache key | NaN | use the string |

`DB.getChatUsers()` returned `parseInt(key, 10)` in v1. It now returns the uuid
strings, so a page that fed those into `parseInt` will get NaN — that is the
same fix as the first row.

---

## 3. Operations that moved server-side

These v1 methods wrote privileged state from the browser. They now call RPCs
that enforce the rules, and some no longer exist at all.

| v1 | v2 | Note |
|---|---|---|
| `DB.addBalance(uid, coin, delta)` | `DB.addBalance(uid, coin, delta, note)` | **4th argument is now mandatory.** The database rejects an adjustment with no written reason. Every existing call site needs a reason string. Admin only. |
| `DB.setBalance(uid, coin, amt)` | `DB.setBalance(uid, coin, amt, note)` | same |
| `DB.updateTrade(id, {settledAt, sellPrice})` | **removed** | Settlement is `scripts/settle.mjs` with the service key. It throws with that message. Remove the "close trade" button's handler and let the job settle. |
| `DB.addTrade(data)` | `DB.addTrade(data)` | now calls `open_contract`. Pass `product_id`, `coin`, `side`, `amount`, `duration_sec`, `entry_price`. Do not pass a payout or expected return — the multiplier is read from `product_durations` server-side and a client-supplied one is ignored. |
| `DB.addAIOrder(data)` | `DB.addAIOrder(data)` | now calls `open_investment`. Needs `product_code` (e.g. `AIQ_7`). The rate is drawn server-side; a client `rate` is ignored. |
| `DB.updateAIOrder(id, patch)` | `DB.updateAIOrder(id, {settledDays})` | only the day counter. Paying out is `admin_settle_investment`, which is not exposed to the client adapter. |
| `DB.updateLoanStatus(id, status)` | `DB.updateLoanStatus(id, status, {interest, note})` | pass `interest` at approval, or the loan is interest-free. |
| `DB.setTransactionStatus(id, status)` | `DB.setTransactionStatus(id, status, note)` | approval now credits the balance in the same transaction. |
| `DB.updateVerificationStatus(uid, status)` | same + reason | a rejection with no reason is rejected by the database. |
| `DB.deleteUser(uid)` | bans, does not delete | accounts are deactivated so ledger history survives. |
| `DB.convertGuest(...)` | **removed** | no guest accounts. Throws. |
| `DB.createUser(...)` | **removed** | accounts come from Supabase Auth. Throws. |

---

## 4. Sessions

app.js generates a local `tok` and passes it to `DB.createSession` / `DB.getSession`
/ `DB.updateSession` / `DB.deleteSession`. The adapter shims these onto the
Supabase session so the plumbing still runs, and the `tok` argument is ignored.

That is a bridge, not a design. A local token is not a credential here — RLS
ignores it entirely and reads the JWT — so keeping it around means maintaining
two notions of "signed in" that can disagree. The clean version reads
`supabase.auth.getSession()` directly and drops `tok`.

`DB.getSession()` now returns `admin` from the profile's `is_admin` column.
v1 let the client write its own `admin` flag onto its session row, so any value
it returned was self-assigned. If app.js gates an admin panel on
`session.admin`, that gate is now real rather than decorative.

---

## 5. Chat needs a thread

v2 splits chat into `chat_threads` + `chat_messages`, and there is exactly one
open thread per user. `DB.sendChatMessage` resolves the thread internally, so
call sites do not change. But a page that inserts into `chat_messages` directly,
or that expects `uid` to be the only grouping key, needs revisiting. The
`attachments` column is `jsonb`, and the message text column is `body` — the
adapter maps `message` <-> `body` for you.

---

## 6. `trustsync` event names

Unchanged, plus new aliases. A listener on `trustsync:trades` still fires when
`contracts` changes, because the dispatcher emits both. `trustsync:user_balances`
now fires on `balances`. Nothing to change unless a page subscribes to a table
name that no longer exists at all.

---

## 7. Seed data the front end expects

`supabase/v2/05_seed.sql` inserts products, durations, AI Quant products,
settings and coin addresses. `products.price_symbol` is new and required — the
settlement script cannot quote a product without it.

The coin address rows in that file are `CHANGE_ME_...` placeholders. **Replace
them with wallets you control before launch**, or deposits will be sent to
addresses nobody can withdraw from.

---

## 8. Load order

`config.js` -> `supabase-client.js` -> `db.js` -> `app.js`.

`db.js` waits for the Supabase client and for the first session before its first
query, so it is safe to load in that order even though the client is injected by
CDN at runtime. `app.js` should still gate on `DB.ready()` / `DB.onReady()`
rather than reading the cache synchronously at parse time — under RLS the first
load returns nothing for a signed-out visitor, which is a legitimate empty
result, not an error.
