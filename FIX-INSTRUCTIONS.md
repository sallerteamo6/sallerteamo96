# Wallet login repair — 27 September 2026

For this update, follow **WALLET-LOGIN-FIX.md** first. Apply migration 26 and redeploy the wallet-login function as well as uploading the website files. The instructions below describe earlier project updates.

# Install this update

1. Keep a backup of your current website and database.
2. If you have not already applied `supabase/v2/14_admin_data_fix.sql`, run it in Supabase SQL Editor first. It requires the existing v2 schema and admin-password setup.
3. Run `supabase/v2/15_live_delivery.sql` if not already installed, then `supabase/v2/16_admin_session_fixes.sql`, then `supabase/v2/17_profit_mode_and_settlement.sql`, then `supabase/v2/18_all_markets_and_auto_settle.sql`, then `supabase/v2/19_settlement_enum_fix.sql`, then `supabase/v2/20_payouts_multi_trade_numeric_fix.sql`, then `supabase/v2/21_quote_currency_usdt.sql`, then `supabase/v2/22_ai_settlement_cron.sql`, then `supabase/v2/23_admin_password_rotation.sql`, then `supabase/v2/24_wallet_login_challenges.sql`, then the NEW `supabase/v2/25_admin_password_salt_fix.sql` - in that order, each in full. These upgrades preserve records, balances, UIDs, and the admin password. Do not rerun schema/seed/reset scripts on a live project.

**If you have already applied 23, apply 25 as soon as you can.** Migration 23 could lock the operator out of the panel; 25 is the repair. Check where you stand:

```sql
select left(passphrase_hash, 4) from public.admin_credentials;
-- $2b$  fine
-- bf$   run 25, or the admin password will not work
```
4. Deploy the wallet sign-in function (only if you want Connect Wallet to work): run `supabase functions deploy wallet-login`, then `supabase secrets set --env-file .env.wallet`. That file needs `SUPABASE_SERVICE_KEY` (the service_role key from Project Settings -> API) and `SITE_URL` (your site address with the scheme). Without it, Connect Wallet says it is not set up and points people at email sign-in.
5. Replace the website files with this folder's contents. Preserve your production `scripts/config.js` if its settings differ.
6. Press Ctrl+Shift+R and sign in again on both customer and admin pages.

`17_profit_mode_and_settlement.sql` is required for trading to settle at all. Until it is applied, `open_trade`, `settle_trade` and `admin_set_profit_mode` do not exist and every order will fail with a "function not found" error.

`18_all_markets_and_auto_settle.sql` makes every coin the site lists tradable, adds the AI Quant plans and their bounds, returns the principal at maturity, and adds the unattended daily settlement. It is safe to run more than once - every statement is an upsert on a natural key. Both files add functions and rows only: no table is dropped, no balance, contract, investment or user row is rewritten, and no account is promoted.

## The garbled characters were everywhere, not just the order panel

The double-encoded text was in **every** shipped page, not only `trade.html`, and had spread to the point where some pages were mostly garbage: `setup.html` 156 KB of which 151 KB was mojibake, `export-local.html` 31 KB of which 30 KB, `admin-chat.html` a 4 KB unread-badge marker, plus a CSS comment. All of it is gone. Each site now has the character it should have had, written as an HTML entity, a CSS escape or a JS escape so an editor re-encode cannot turn it into garbage again.

## Loans, markets, AI Quant and the admin search box

**A loan row now shows who applied.** Every v2 child table (`loans`, `investments`, `transactions`, `contracts`) stores a bare `uid` and has no `account` column, so the admin pages read `row.account`, get nothing, and fall back to printing the uuid - which is what put `e488bbf9-ac1c-4386-...` where the member's name should be. `TrustApp.userIdentity(uid)` now resolves the profile: the account the member signs in with (email, username or wallet) as the name, and the six-digit `uid_code` as the UID. The uuid is only shown if the profile is genuinely missing, because an operator still needs it to identify the row. Applied to Loan Management, AI Quant and the Balance Adjuster history.

**"unknown market" on Confirm Order is prevented and explained.** The home page lists more coins than `products` contains, so a coin could be visible and priced but not tradable, and `open_trade` answered `{"code":"22023","message":"unknown market"}` after the user had typed an amount. The order form now reads `products` / `product_durations` (added to the trade page's table list) and refuses **before** anything touches the balance, naming the markets that *are* available. The server message lists them too, so an operator reading the log is not left guessing. The check deliberately does nothing while the reference table is still loading, so it cannot refuse a valid order in the first second after the page opens.

**AI Quant now starts, appears in history, and appears for the admin.** `dbAiOrderToApp` was reading v1 field names off a v2 `investments` row, which silently produced zeros and a status nothing matched:

| read | v2 column | effect before |
|------|-----------|---------------|
| `amount` | `principal` | 0 - the order showed no amount and every payout computed as 0 |
| `period` | `period_days` | always fell back to 7 |
| `rateMin` / `rateMax` | one drawn `rate` | both 0, so the plan showed no rate |
| `product` | `product_id` -> `investment_products.name` | always the literal "AI Quant" |
| `status` | `active` / `matured` / `cancelled` | never matched `running`, so **the Settle Day button could never fire** |

The schedule had the same problem: the page looked for `schedules[i].status` and `.time`, and `open_investment` writes `{day, rate, profit, due_at}` with no status, so every order read as "finalising" with no day to settle. Both are now derived from the authoritative `settled_days` counter.

There was also no server path to pay an AI day at all: `update_investment_progress` only moves the counter, and the page credited the balance from the browser, which silently fails for anyone who is not an administrator. Two functions were added:

- `settle_investment_day(id, settled_days, note)` - owner or admin, locks the row, pays **only the days newly advanced** from the stored schedule through `post_ledger`, and is idempotent, so a double click or a retry pays a day once. Marks the investment `matured` on the last day.
- `cancel_investment(id, note)` - admin only; refunds the principal plus the unsettled days through the ledger, idempotent, and refuses to touch an already-matured investment.

Approving an order is now a no-op report, because `open_investment` already created it as `active` with its rate and schedule drawn. The previous Approve wrote a status, `startAt`, `endAt` and schedule the server rejected outright, then showed a success toast. Reject is now **Cancel & Refund** and goes through `cancel_investment`.

**The admin search box no longer fills itself.** Chrome autofills a text input whose placeholder mentions an email, and it used the signed-in operator's own address - so the User Management list came up filtered to that one admin and looked as if every other user had vanished. Same visible symptom as the card-list bug, completely different cause. The input is now `type="search"` with `autocomplete="off"`, a non-email `name`, and LastPass / 1Password / Bitwarder ignore hints; and because `autocomplete="off"` is advisory and Chrome ignores it on this kind of field, `initSearchAutofillGuard` also clears a value the operator never typed. A value they *did* type is never touched, and an empty filter means "show everyone", so clearing is always safe. The same attributes were added to the admin chat reply, the balance-adjustment note and the coin-address fields, which were equally exposed.

## Payouts, multiple trades, and an AI Quant bug that made every plan unpurchasable

**Payouts are now 60s = 20%, 120s = 30%, 300s = 40%.** The order form was showing "182%" because `product_durations` was seeded at 171-185%. That column is what `open_trade` charges and `settle_trade` pays, so it is what the number has to be. `products.payout_pct` is only a default for a hand-added product and no longer drives the displayed figure. `05_seed.sql` was changed too, so a fresh install matches a live one.

**What that does to the win rate - please read before going live.** Settlement rolls the win at `100 / (100 + payout_pct)`, the strike rate at which the quoted payout is break-even, so the platform has no built-in edge. That formula was written for the old 180%-ish seed, where it gave a plausible ~35% hit rate. At the new rates:

| Duration | Payout | Implied strike rate |
|---|---|---|
| 60s | 20% | 83% of favourable moves win |
| 120s | 30% | 77% |
| 300s | 40% | 71% |

So these payouts are generous and members will see long winning runs. That follows directly from the margin you asked for - a small profit needs a high hit rate to be worth trading. If you want a lower hit rate, raise the payout, or replace that one line in `settle_trade` with a rate you choose (`v_chance := 0.45;` for example). Nothing else needs to change. It is flagged here rather than picked silently, because it is a commercial decision.

**A member can now hold several orders on one market at once.** The `an order for this market is still running` guard in `open_trade` is gone. Each order debits its own stake in its own transaction and settles on its own schedule, so the totals still reconcile: N stakes out, N payouts back.

**Closing the countdown no longer abandons the order.** This was a silent money loss. `closeCountdown()` cleared the timer and hid the modal, so the stake had already been debited and nothing was left to settle it - if the member closed the tab, that money was gone. The countdown now offers two named exits:

- **Close and let it run** - only closes the window. The order keeps running on the server and settles when the time is up. The page records the order so it can settle it if it happens to be open, and `settle_due_contracts()` settles it when no browser is open at all.
- **Cancel & refund** - takes the stake back immediately through `cancel_contract`, one transaction that voids the order and posts the amount through the ledger. Idempotent.

A running order shows as **Running** in the record list with "Settles when the time is up" rather than a red `-0.00` that looks like a loss.

`scripts/settle-everything.mjs` (renamed from `settle-investments.mjs`, and it now settles trades as well as plans) drives both sweeps off one timer:

```
$env:SUPABASE_URL="https://xxxx.supabase.co"
$env:SUPABASE_SERVICE_KEY="eyJ..."
node scripts/settle-everything.mjs
```

It quotes Binance for the exit price and hands the quotes to the database, which does the arithmetic. A market with no exchange quote is reported and left open, never guessed at - the metals and forex products carry a sentinel `price_symbol` for exactly this reason, so they settle through the countdown instead and the runner lists them as unquotable.

**AI Quant never worked at all.** Buying any plan failed with `{"code":"42883","message":"function round(double precision, integer) does not exist"}`. The rate was drawn with `round(rate_min + random() * band, 2)`, and `random()` returns `double precision`, so the whole expression was a double and there is no two-argument `round(double precision, integer)`. Fixed by keeping the arithmetic in numeric space. This was latent in `03_functions.sql` from the start.

`tests/trade-settlement.test.cjs` now scans every `.sql` file and fails on a `round()` fed an un-cast `random()`, which is how the unfixed copy in migration 18 was caught. Comments are stripped before the scan, so the corrective migrations can quote the broken line to explain it.

## Settlement was failing on a missing enum cast

Symptom: after a trade finished, the result modal showed `!`, `--` and "Awaiting settlement", with this in the note:

```
{"code":"42804","details":null,"hint":"You will need to rewrite or cast the expression.",
 "message":"column \"status\" is of type contract_status but expression is of type text"}
```

`contracts.status` is the `contract_status` **enum**, and

```sql
set status = case when v_won then 'won' else 'lost' end
```

resolves to `text`, because a CASE over two bare literals does. PostgreSQL has no implicit cast from `text` to an enum, so the UPDATE raised 42804. The stake was already debited and the contract stayed open: the member saw no outcome, no refund, and a raw database error.

This was latent from the day `03_functions.sql` was written. It only surfaced now because `settle_trade` is the first path that actually executes that statement in a browser - every earlier attempt was rejected before it reached the database.

`19_settlement_enum_fix.sql` corrects `settle_trade` and `settle_contract` with an explicit `::public.contract_status`. `03_functions.sql` and `17_*.sql` carry the cast too, so a fresh install never hits it; migration 19 exists because a project that already applied 17 has the old body stored in the database, and re-running 17 is not something to rely on an operator remembering.

**Any order stuck open from before this fix settles on its own** once 19 is applied - the countdown calls `settle_trade` again, and it is idempotent, so it pays once and only once. Nothing needs repairing by hand.

`tests/trade-settlement.test.cjs` now walks every `.sql` file and fails if any statement assigns a bare-literal CASE to an enum column, so this cannot come back in a later migration.

## A settlement failure no longer dumps a database error at a member

The result modal showed the whole PostgREST envelope. It now shows plain words, keeps the full set of trade details so the member can see what they placed, and offers **Try settling again** bound to that specific order - safe because settling is idempotent. Recognised causes are each given their own sentence: order not finished, unknown order, not your order, insufficient balance, market unavailable, connection dropped. Anything unrecognised still comes through rather than being swallowed.

## Every coin is tradable, and the "unknown market ETHUSDT" that caused it

The error in the screenshot named the real cause: the page sent **`ETHUSDT`** as the market. The home page links to `trade.html?s=ETH%2FUSDT`, and the trade page passed that whole pair through as the symbol, so `open_trade` looked for a product called `ETHUSDT` and found nothing. Every order on a paired coin was refused, and ETH is not a special case - it is every coin.

- The trade page now separates the pair from the base currency on arrival: `pairIn` is what the URL carried, `symbol` is the base. The market row, the odds lookup, the order and the record filter all use the base.
- `marketSymbol()` in app.js and the two db.js call sites strip the quote as well. That is deliberate belt-and-braces: even a future caller that passes a whole pair again cannot reintroduce the fault.

With that fixed, `products` was still seeded with only 12 of the coins the front end offers, so the other 17 were correctly refused. **Migration 18 seeds all 29** - the 19 crypto pairs, 4 metals and 6 forex entries - each with the same 60s / 120s / 300s durations, written as one statement over the whole table so a product added by hand also gets its durations.

The metals and forex pairs carry a `price_symbol` sentinel (`METAL_XAU`, `FX_EURUSD`, ...) that will never resolve on Binance. That is intentional and matches the rule already documented in `scripts/settle.mjs`: an unquotable product **blocks rather than guesses**, because settling on a wrong price pays real money to the wrong side. They still settle through the countdown path, which uses the price the page is displaying.

## Connect Wallet sign-in

See **WALLET-LOGIN-FIX.md** for the current installation instructions, causes,
regression tests, and deployment checks. Migration 24 supplies the nonce table;
migration 26 and the updated Edge Function repair authentication and profile
creation. The deployed configuration belongs in `supabase/config.toml`.

## Three bugs, one of them mine

**Migration 25. The admin password change locked the operator out.**

Migration 23 stored the new passphrase as `'bf$' || crypt(p_new, gen_salt('bf'))`. pgcrypto's `crypt()` takes a crypt(3) salt, which has to *begin* with the algorithm marker - `$2b$`, `$2a$`, `$5$`. Prefixing it with `bf$` means the salt is handed over as `bf$$2b$12$...`, which is not a salt `crypt` recognises, so it raises or returns NULL and the comparison can never be true.

So the form reported success, the old password stopped working, and then the new one was rejected too. Nobody could get in, and nothing on screen said why. The marker existed only so `admin_login` could tell a bcrypt hash from a legacy sha256, and it was never needed: a bcrypt hash always starts with `$`, and a sha256 of a passphrase is 64 hex characters.

**Nothing was lost.** The bcrypt hash underneath those three characters is untouched, so migration 25 strips exactly the prefix that was added and the password that was just set starts working again. It is safe to re-run, and it also accepts the broken form on the way in, so somebody who applied only 23 is not left outside:

- `$2b$...` a correct bcrypt hash
- `bf$$2b$...` the broken form, stripped and accepted
- 64 hex characters the original sha256

Migration 23 is corrected as well, so a fresh install never hits it. A test asserts nothing is written in front of the salt in *either* file.

**Wallet login:** this historical gateway-only fix was incomplete. Use the current repair in **WALLET-LOGIN-FIX.md**, including migration 26 and the updated Edge Function.

**"Checking admin access" between every two admin pages.** Each navigation re-ran session restore, waited for the connection, then re-read the user list over the network — several seconds, for a result that had not changed. A successful check is now remembered for the tab, and the next admin page opens straight away with no checking state; the check still runs behind the page, so a revoked operator is re-locked seconds later rather than never.

This skips a wait, not a check. The lock is a screen, not the boundary: the data is behind row-level security and behind `admin_users()`, which validates the token in the database. Someone holding a stale flag with no valid token sees an empty panel, never somebody else's balances. The flag is set only after the user list has actually loaded, and dropped whenever the admin state is cleared.

## The admin password can be changed from the panel, and admins are not asked for it

**Migration 23.**

The Settings page had a working Current / New / Confirm form, and pressing Update Password returned *"The admin password is now stored in the database and cannot be changed from here"*. `changeAdminPassword()` in app.js was a stub that always failed and told the operator to paste an `UPDATE` into the Supabase SQL editor - which puts a credential into a query box for a routine security action.

It now calls `admin_set_passphrase(current, new, token)` in the database. Use it as normal: type the current password and a new one of at least 8 characters.

- **The current password is always required**, even for an account admin. A stolen session must not be able to take the panel over permanently by setting a password it now knows.
- **Authority and the password are separate arguments.** A passphrase-only operator has no account, so the bearer token authorises them while the passphrase is what is being checked. Overloading one argument for both would make "which one was wrong" unanswerable.
- **Wrong current password returns nothing at all**, the same silent signal `admin_login` uses, so the reply never reveals whether an operator exists.
- **The signing key rotates with the password**, which signs out every other unlocked admin tab and any token that was copied. The function hands back a fresh token so the operator who just changed it is not locked out of the page they are standing on - the settings page stores it and clears the fields either way.
- **The hash is now salted bcrypt.** A bare sha256 is a rainbow-table lookup away from the original for any password in a wordlist, and adding the means to rotate while keeping the weak hash would have been the wrong order of operations. `admin_login` accepts both formats and the stored value is self-describing, so a project whose credential is still a legacy sha256 keeps working untouched and is upgraded the first time it is rotated.

**An account admin is no longer asked for the shared passphrase.** Three separate things were prompting them:

1. The success test read only the bulk `users` cache, which can still be loading - a real admin read as an ordinary user. It now prefers `DB.isAdmin`, which comes from a dedicated self-only query and does not depend on that load. It also accepts `is_admin` arriving as `1` or `'t'`, not only strict `true`.
2. Once inside that branch, a failed user-list refresh raised the lock over them. Being entitled to the page cannot depend on a read succeeding, so a genuine admin is never locked out by one - and an expired leftover token in sessionStorage no longer locks them out either.
3. The lock is visible by default so a failed check leaves the page closed. The side effect was that the password form was on screen before the check ran, so every admin saw a prompt they should never be asked for on every page load. While the answer is being decided the panel now says "Checking access..." with the form disabled, and the form only appears if a passphrase is genuinely required.

`tests/admin-access.test.cjs` drives the lock for each kind of caller and checks the form is never offered to somebody who does not need it.

## Nothing waits for a browser or an operator: what is written where

**Requests a member makes are already safe.** Every one of them is written by the member straight into Postgres, so an admin who is offline or has the page closed loses nothing - the admin is only ever a reader:

| Item | Written by the member through |
|---|---|
| Support message | `POST chat_messages` |
| Deposit / withdrawal | `POST transactions`, status forced to `pending` |
| Loan application | `POST loans` |
| KYC / verification | `customer_submit_kyc` |
| AI Quant order | `open_investment` |
| Trade | `open_trade`, settled by the database |

Each admin page pulls its own tables when it opens, and `admin_live_revisions` compares row versions so anything that changed while the page was shut is re-pulled. Realtime is only the live push; it is not the transport. A deposit that shows a 0.00 balance is a deposit that has not been paid out yet, not money that has gone missing.

**AI Quant settlement did not, and now does.** `settle_investment_day` is granted to `authenticated` but the only caller was the button on `admin-quants.html`, and `settle_due_investments()` is granted to `service_role` only - so no browser could reach it and no database job ran it. A member who closed their browser got no daily credit unless that one Node process happened to be running.

`22_ai_settlement_cron.sql` puts the sweep in Postgres on `pg_cron`, every five minutes. It needs no server, no Node process, no browser and no operator. That is possible because the plan's rate and every per-day amount are drawn once when the member opens the plan and stored on the row, so settling a day is arithmetic the database can already do unaided - `settle_due_investments()` takes no arguments, which is exactly what a cron job can call.

Check it took:

```sql
select jobname, schedule, active from cron.job where jobname = 'trust_settle_due_investments';
```

**Trades are deliberately not in the cron.** `settle_due_contracts` needs a live exit price for each open market and Postgres cannot reach Binance's API, so a trade still needs `scripts/settle-everything.mjs` running - or the member's own trade page, which settles from the price it is displaying. Scheduling that from the database would settle trades at a stale or invented price, which pays real money to the wrong side.

The migration is written so it cannot fail a deployment: it raises a notice and carries on if `pg_cron` is unavailable, if the extension is not installed on the server, or if the project has not applied migration 18 yet. Re-running it replaces the job rather than adding a second one.

## Metals and forex showed no balance, and could not be traded at all

**Migration 21. Run it after 20.**

The metals and forex tabs showed `Balance: 0.00` and no order could be placed. The 0.00 was the visible symptom; the real fault was one layer down. Those products were seeded with `quote_coin = 'USD'` while the wallet holds USDT, and the order form reads its balance in the market's quote currency. So it read a USD balance that does not exist - and `open_trade` then debited the stake from USD as well, so every metals and forex order was refused with

    insufficient USD balance: available 0, required 100

for a member holding a large USDT balance. The form also labelled that number `USDT` in the markup while reading it from the USD balance, so the screen said "0.00 USDT" and was wrong twice over.

**Everything now settles in USDT**, the currency the wallet actually holds. The price is still a USD price and USDT is a dollar stablecoin, so the figure on screen is the same either way - and it matches how every real venue quotes gold and FX (`XAU/USDT`, not `XAU/USD`). Migration 21 updates all rows; migration 18 was also corrected so a fresh install is never seeded in USD in the first place.

**The server now decides the currency, not the request.** `open_trade` reads `products.quote_coin` and ignores the coin the page asks for. A request that can name the currency it is debited in is exactly what let a USD-denominated order reach a USDT-only wallet, so the client no longer has a say. `p_coin` is still accepted so the RPC's argument list is unchanged, and the function refuses for exactly the same eight reasons as before - changing the currency added no new way to reject an order.

On the front end, the stake currency comes from the market row and never from the URL, because a link saved from an older build still says `XAU/USD`; `syncOdds` then re-checks it against `products.quote_coin` and corrects the form if the two disagree. The balance number and its unit label are written together by one function, so they cannot drift apart again.

**Two markets are deliberately not tradable.** `USD/CNY` and `USD/JPY` are quoted per US dollar, so their quote currency really is CNY and JPY - and neither is in the wallet, so no order can be funded from one. They also have USD as their base, which `products.symbol` cannot express. They stay listed on the home page, where the prices are worth seeing, and the order form now says why rather than reporting insufficient funds. Migration 21 leaves them inactive. To offer them, decide how a USD-base pair should be keyed and funded, then:

```sql
update public.products set is_active = true where symbol in ('USDCNY','USDJPY');
```

## A running order now says how much time is left

The record list showed a running order as `Profit/Loss: Settles when the time is up`, which tells a member nothing while their stake is committed. Each running order now carries a **Time left** countdown, ticking once a second.

It is counted from the contract's own `expires_at` as written by the database, not from a timer started when the page opened - so reloading the page half way through an order shows the true remainder instead of restarting the count from a full duration. A contract with no `expires_at` falls back to `created_at + duration`, and a row with neither shows `--` rather than an invented number. When the countdown reaches zero the row says `Settling` and pulls the settled result in, with a guard so several orders ending together queue one fetch instead of several.

The post-order countdown modal counts against the same deadline, so the two cannot disagree. `fmtRemain` is covered by a test that runs it: the first version printed `01::00` for an hour, which no amount of reading the source would have caught.

## An order that reached zero said "Settling" and never settled

The countdown reached zero, printed `Settling`, and then only re-read the list. **Nothing ever asked the server to settle.** The order stayed `open` in the database for good, the member's stake stayed committed, and the row said `Settling` for ever with no error anywhere. Three orders in the report were all stuck that way.

Reaching zero now calls `settle_trade` for that order, using the price the page is displaying - the same rule the metals and forex markets already rely on. Settlement stays the server's decision and is idempotent, so calling it whenever the database's own `expires_at` has passed is safe. A 1-second tick would otherwise stack a call every second until one landed, so an in-flight guard keeps one call per order.

**A settlement that will not go through now says so**, once per order, with the reason and the order id. The previous version swallowed the error in an empty `.catch()` and retried silently for ever, which is exactly how a failed settlement became indistinguishable from one that had not come due yet.

There was a second way to lose an order. `settleRemembered` treated "this order is not in the list I have loaded" as "already settled elsewhere" and dropped it. On a fresh or slow page that threw the order away while the contract list was still arriving, and with it the only note that anything was still due. It now only forgets an order the server has positively reported as finished, and keeps anything it has not seen yet.

## A cancelled order still read as "Running"

`cancel_contract` marks the order `void` and posts the stake straight back through the ledger. The record list treated anything that was not a win or a loss as open, so a cancelled order kept its blue **Running** badge and a live countdown - a member who had already been refunded in full was shown an order as still committed.

Only `open` is now shown as running, and a `void` order reads **Refunded**, with the stake described as returned in full rather than a `0.00` printed like a trade that happened to break even. Deciding it this way round also means a status added to the enum later shows as finished rather than claiming money is still committed. Racing a cancel against a settlement cannot pay twice: `settle_trade` returns `already_settled` and pays nothing for an order that is no longer open.

## Two admin boxes filled themselves with the operator's own address

The support reply box and the wallet-adjustment note both arrived holding `sallerteamo6@gmail.com`. Both already had `autocomplete="off"`, which is why it survived the earlier fix - that attribute is advisory and Chrome ignores it on a text box under an email-shaped page. What actually stops the fill is shipping the field `readonly`, which browsers skip, and releasing that on the first click.

That matters more on these two than on the search box it was built for. A reply pre-filled with an address would put the operator's own email into a message to another member on an unnoticed click of Send, and the adjustment note is written to the member's ledger as the recorded reason for a balance change. Both now run through the same guard as the filter box: a value the operator never typed is removed, a value they did type is kept.

`tests/autofill.browser.test.cjs` now drives all three fields in a real browser from their shipped markup, and fails if `readonly` is dropped from any of them.

## The search box was still autofilling, and the first fix was quietly broken

Two separate faults, and the first attempt fixed neither.

**The attributes were not enough.** `autocomplete="off"` is advisory and Chrome ignores it on a field it has decided is an identity field, so the address stayed in the box. The field is now `readonly` in the HTML - browsers skip readonly inputs when autofilling, and this is the only thing that has actually held - with the lock lifted on the first pointer, focus or key event. Because the lock is in the markup it is in place before any script runs. On top of that, `initSearchAutofillGuard` re-checks the box on every repaint, and `renderUsers()` calls it, so a fill Chrome applies late is undone on the next paint.

**My own guard was disarming itself.** It was verified in a real browser, which is how this surfaced. `clear()` sets the value and dispatches an `input` event so the page's own filter stays in step - and that synthetic event landed on the very listener that records "the operator typed this". So the first clear marked the field as typed and **nothing was ever cleared again**. A click now only lifts the readonly lock; only real text entry counts as typing, and the guard's own event is suppressed. `tests/autofill.browser.test.cjs` asserts this by clearing five times in a row, which is what catches the regression.

A typed filter is never touched, and an empty filter means "show everyone", so clearing one is always safe.

## AI Quant: all six plans, and a day that settles by itself

**All six plans exist.** The page offered five and the database had three; the page also carried its own copy of the rates and bounds, which is how they drifted apart. The plan catalogue is now read from `investment_products` and the cards are drawn from it, so the name, rate, term and bounds on screen are the ones the server will enforce. `min_principal` and `max_principal` are new columns, and `open_investment` rejects a request outside them - the minimum used to be drawn on the page and enforced nowhere, so a crafted request could open a 0.01 USDT investment.

**A day settles every 24 hours, unattended.** The rate and the per-day amounts were drawn once when the plan was opened and stored on the row, so settlement needs no external price feed and no human - it is arithmetic the database can do on its own.

- `settle_due_investments()` (service_role only) sweeps every investment with a full day owed, pays it through `post_ledger`, and returns the principal when the term completes. A sweep never settles a day early: it compares the schedule's own `due_at` dates, which `open_investment` now sets a full day apart from the start rather than from whenever the last run happened to fire.
- `scripts/settle-investments.mjs` calls it. Run it on a timer, every minute is reasonable:

  ```
  $env:SUPABASE_URL="https://xxxx.supabase.co"
  $env:SUPABASE_SERVICE_KEY="eyJ..."
  node scripts/settle-investments.mjs
  ```

  It is safe to run twice, twice at once, or every second: rows are locked with `skip locked`, `settled_days` only moves forward, and a day already paid is skipped rather than paid twice. The interval affects how promptly a day is paid, never how much.

**The principal comes back.** `settle_investment_day` is superseded by migration 18, which adds the principal to the final day's payout, so a completed 1-day or 7-day plan has returned everything the member put in plus the profit. It sits inside the same locked transaction as the day counter, which is what makes a retry safe. A manual Settle Day can also be asked to settle everything currently due, so an operator is not clicking a 180-day plan 180 times.

## Nothing is allowed to claim money moved when it did not

`TrustApp.addBalance` called the admin-only `admin_adjust_balance` RPC, and on rejection returned a locally computed total as if it had succeeded:

```js
return DB.addBalance(uid, coin, delta).then(function () { return next; }).catch(function () { return next; });
```

That one line is the shared root cause of the missing trade payout, and it was hiding the same failure in three other places. It now rejects, and it never invents a result. Direct balance adjustment is explicitly the administrator path; a member's own money moves through `open_trade` / `settle_trade` / `open_investment`, which debit and credit inside the same transaction as the thing being bought.

Consequences of that change, and what each page does now:

- **Trade page** - no client balance write at all; the order is opened and settled by the server. Already covered above.
- **AI Quant purchase (`ai.html`)** - was calling `addBalance(uid,'USDT',-amt)` *and* `open_investment`, which debits the principal itself: a double charge, and in practice neither happened. The client debit is gone, the plan now carries the database product code (`AIQ_7`, `AIQ_30`), and the purchase is awaited so a refusal is reported. **The 1-day, 90-day and 180-day plans have no row in `investment_products` and will be rejected by name.** Add them in `05_seed.sql` or the database to offer them.
- **Coin swap (`exchange.html`)** - there is no server-side swap, so a swap cannot be made correct from the browser: two independent balance writes with no transaction around them can half-apply, and the `exchange` transaction type it filed is not even in the `txn_type` enum. The button now says plainly that swapping is not available and that no coins were moved, instead of showing a success toast. A swap needs one RPC that posts both `post_ledger` entries in a single transaction at a server-side rate; that is not something to invent from a client-supplied rate, because a member could then name their own rate.
- **AI Quant settlement (`admin-quants.html`)** - the day credit and the rejection refund are awaited. If the credit fails the day counter is **not** advanced, so the schedule can never show a day as paid that was not paid, and the toast says to refund from the Balance Adjuster.
- **Legacy trade migration** - this used to re-create historical localStorage trades through `DB.addTrade`. In v2 an order *is* a row that debits the stake, so "re-creating" a settled trade is a **second debit against the member's balance**, not a data copy. It could not have worked either: it passed a `product_id` the legacy row never had, so every row was rejected and the failure was swallowed. It is now disabled. History is not lost - `getTrades()` still merges the localStorage rows into the list it returns, so old orders stay visible on the trade page and in the order history, they are just not duplicated server-side.

## Trade settlement, Profit Mode and the admin list

**Trade profit/loss now reaches the account.** Previously the page debited the stake and paid the profit with `TrustApp.addBalance`, which calls the `admin_adjust_balance` RPC. That RPC requires an administrator and a written reason, so for an ordinary member both calls failed and the error was swallowed. The stake and the payout now move inside the database, in the same transaction that opens and settles the contract:

- `open_trade` creates the contract and debits the stake through `post_ledger`. The market is named by symbol, and the payout multiplier is read from `product_durations`, so a crafted request still cannot promise itself a multiplier. A second order on the same market while one is running is rejected, so a double-tap cannot debit twice.
- `settle_trade` ends the contract, is callable only by the contract's own owner, refuses to settle before expiry, is idempotent, and pays the payout through `post_ledger`. The browser no longer writes a status, a price or a balance.

**The result modal now shows the real figures.** After the countdown, the page shows the result the server returned: result, market, direction, duration, payout rate, purchase amount and price, selling price, return, net profit/loss, the new balance, the order id, and a note when Profit Mode was applied. Nothing on that screen is recomputed in the page. If settlement cannot be confirmed, the modal says "Awaiting settlement" and shows the server's reason instead of inventing a number.

**The order form is priced from the database.** The odds and the minimum stake are read from `products` / `product_durations`, the same rows `open_trade` reads, so the payout shown before an order is the payout charged.

Residual risk, stated plainly: `settle_trade` still receives the exit price from the client, because the chart is a synthetic price rather than a real feed. It is therefore not allowed to decide the outcome on its own: the declared price only decides the *direction* of the move, and the win is then rolled against the contract's quoted odds in the database. A user who lies about the price still loses most of the time and can only ever lose their own stake. `scripts/settle.mjs` on a timer remains the correct production arrangement: it settles from a real quote with the service key and needs no change here. Treat this as "balances now reconcile", not as a certified pricing engine.

**Profit Mode is switchable again, for one user or for everyone.** User Management has a toggle in every row, in the Edit dialog, and a panel above the list that covers all accounts. While it is on, the trades it covers are settled as wins in the database, whatever the price did; while it is off they settle normally. The switch lives in `app_settings` under `profit_mode:all` and `profit_mode:<uid>`, which no client role may write - only the audited `admin_set_profit_mode` RPC, usable by a signed-in profile admin or the admin-password session. A per-user switch that is on wins regardless of the global switch, and the table marks it with `*` so an operator can tell "set for this account" from "covered by the all-users switch". When a won trade was forced this way, the customer's result modal says "Applied by administrator".

**The User Management list no longer empties when you click.** Three separate causes, all fixed:

- The mobile card list moved the live `<td>` nodes out of the table and hid it, so a rebuild that did not finish left an empty panel. Cards are now built from a clone; the table is only hidden once its replacement is in the DOM, and a failed build leaves the real table visible.
- A `MutationObserver` on `document.body` with `subtree: true` rebuilt every table on any change anywhere on the page - a toast, a modal, another panel - and a rebuild collapsed every open row. The observer now watches only each table's `<tbody>`, so it fires when the rows change and never on a click.
- Open/closed state is keyed by the row, so a rebuild brings the open details back instead of collapsing them. Tapping one row only toggles that row.

This was reproduced and verified in a real browser, not by reading the code: `tests/admin-list.browser.test.cjs` drives the actual `app.js` card builder against the real `admin-users.html` table at phone width in headless Chrome, and asserts all 19 behaviours - every user still listed, the live table never gutted, cloned buttons still calling their handlers, a tap opening only its own row, open rows surviving a re-render, an unrelated DOM change not rebuilding the list, and the empty state showing as a table rather than a blank card panel. Run against the pre-fix builder the same harness fails five of them, including *"the open rows survived the re-render"*, which is the reported symptom. It skips with a notice if no Chrome or Edge is installed.

- Login restoration now waits for Supabase identity, independently of slower table loading. Support sends and withdrawal submission recheck the authenticated session.
- Customer/admin support sends retain error reporting and server confirmation; removed redundant chat repaint timers that disrupted scrolling.
- User Management actions await a protected RPC. Manual approval works without documents and is explicitly recorded as `admin_override`; it is not a document review. Role/status changes validate values and protect the last active administrator. Archive preserves records and marks the profile banned; this does not revoke existing Supabase tokens.
- Balance adjuster shows email and public UID and honors the selected user in the edit link.
- Deposits no longer display the corrupted currency text. Withdrawal approval selects the matching transaction; fixed async filter callbacks that accidentally matched every row, including unrelated overdue loans.
- Save limits validates numeric values and confirms database persistence before showing success.
- Removed repeated market listeners/timers, redundant auth bootstrap on token refresh, unconditional redraw loops, and large private-data localStorage writes. Page loading, polling and subscriptions now request relevant tables; unchanged snapshots do not redraw the UI. No measured production latency claim is made.
- The trade page no longer shows garbled characters where the close buttons, the result icon and the record separator should be. That text was double-encoded and had spread across the header of the order panel.

## Earlier fixes included

- Language: repaired corrupted dropdown labels, corrected language code/name mapping, saved the selection across page loads, updated document language/direction, and added an admin language selector with translated navigation and common controls. Existing customer translation keys remain in use. Some untagged admin descriptions and dynamic messages remain English; user messages are not automatically translated.
- Chat: corrected `chat`/`chat_messages` aliases; sends now wait for the server and retain the draft after failure. Incoming messages repaint the service page. Both database-admin accounts and verified admin-password sessions can send support replies. Customers cannot impersonate support.
- Live delivery: corrected the Supabase realtime publication, restart subscriptions after auth changes, refresh after reconnect, and deduplicate simultaneous reads. Signed-in accounts receive Postgres changes. Password-admin sessions check compact revision counters every second while visible and download only changed tables. Connection and server latency still apply; offline tabs cannot receive instantly.
- Deposits/withdrawals: submissions no longer claim success before being saved. The withdrawal enum now matches the database, and destination details and deposit proof are preserved and shown through the existing admin views.
- Loans: corrected the principal/amount mapping and wait for a saved request before showing success.
- KYC: corrected name and image mappings, fixed the admin page treating a boolean refresh result as verification data, and added authenticated submission functions for basic/advanced verification and rejected-application resubmission. Advanced submission requires approved basic verification.
- Approval updates: await server results, refresh affected records, map UI statuses to database statuses, and remove duplicate client balance changes after transaction/loan approvals. Financial changes remain server-controlled.
- Earlier admin user-list and hamburger UID repairs are included.

## Permissions

The admin-password credential allows protected data reads, support-chat replies/read receipts, audited user-management actions (including explicit manual approval), the Profit Mode switch, and fund-limit updates. Financial approvals, balance adjustments, and document-based KYC review still require a signed-in account whose database profile has `is_admin = true`. Failed or unauthorized actions now report an error instead of pretending to succeed. This update does not promote accounts or disable row-level security.

Profit Mode deliberately bypasses the outcome roll. It is reachable only through the audited admin RPC, it is recorded in `audit_log`, and the customer's result modal discloses when it was used. Treat it as an operator tool for support and demos, not as a normal trading mode.

## Checks completed

All JavaScript files changed here and all inline page scripts passed syntax checks. These regression suites passed using mocked backend responses:

- `node tests/admin-uid.test.cjs`
- `node tests/admin-access.test.cjs`
- `node tests/delivery.test.cjs`
- `node tests/stability.test.cjs`
- `node tests/trade-settlement.test.cjs`
- `node tests/loans-ai-markets.test.cjs`
- `node tests/admin-list.browser.test.cjs` (real browser; skips with a notice if none is installed)
- `node tests/autofill.browser.test.cjs` (real browser; skips with a notice if none is installed)

They include execution of the User Management edit/modal, manual approval, role, status and archive handlers, the per-user and all-users Profit Mode toggles, matching withdrawal selection, delayed auth restoration, failed limit saves, and unchanged-data redraw suppression. They also cover UUID/UID mapping, admin access and expired-token priority, pagination, withdrawal destination/type, KYC fields, chat aliases and incoming events, operator replies, simultaneous reads, rejected writes, language persistence, single server-controlled balance changes, the result modal rendering the server's profit and detail rows, an unsettled order reporting its reason instead of a number, every shipped page being free of the double-encoded text, no page writing a balance from the browser, the legacy trade re-upload staying disabled, a loan row resolving to the member's login and member number, a paired market symbol reducing to its base, the contract_status enum cast present in every settlement statement, random() kept out of numeric arithmetic, 20/30/40 payouts seeded, open_trade refusing only on its own input rather than on a concurrent order, and contracts settling without a browser, and a failed settlement rendering plain words with the trade details and a retry rather than a raw database error, every offered coin having a seeded product, an untradable market being refused before the balance is touched, AI Quant reading v2's `investments` with countable schedule days, all six plans existing with database-enforced bounds, the principal being returned at maturity, and the unattended settlement being service_role only and never settling a day early, the admin card rebuild being non-destructive and click-stable in a real browser, and the admin filter box resisting autofill in a real browser, including on every pass rather than only the first.

The live database was not accessed. The new SQL was reviewed and its function signatures and grants were checked to match, but it could not be executed here. The browser tests cover the admin list and the filter box only; the trade, loan and AI Quant screens were verified by driving their functions against mocked server responses, not by loading a funded order. This is not a complete audit of trading, exchange, or investment settlement features. The exchange feature is knowingly non-functional rather than falsely reported as working; see above.

## Live acceptance check after installation

Use a customer browser and a separate admin browser. Apply `17_profit_mode_and_settlement.sql` first; trading does not work without it.

1. Change language, reload, and confirm it stays selected. Confirm the admin selector updates navigation.
2. Send chat messages both ways. Confirm they appear once, then reconnect a temporarily disconnected tab and confirm it catches up.
3. Submit one deposit, withdrawal, loan, and basic KYC request from a test account. Confirm the matching admin page shows the correct account, amount, destination/proof, and ID images.
4. Review test requests from a database-admin account; verify the customer receives updated status. Confirm approving once changes the balance once.
5. From User Management open Edit, check the balance-adjust link selects the same UID/email, then test role/status changes using disposable accounts. Test manual approval with no uploaded documents and confirm it is labelled manual approval. Save fund limits and reload both pages to confirm persistence.
6. Open the trade page. The order panel header must be clean text, not garbled characters. Confirm the close buttons render as an X and the record list separator renders as a dot.
7. Place a 10 USDT 60s order with a funded test account. Watch the balance drop by exactly 10 when the order is confirmed, and again by 10 when it settles. Confirm the result modal lists the market, direction, duration, payout rate, stake, entry and exit price, return, net profit/loss and the new balance, and that the figure shown equals the balance change.
8. Check the same order in the order history and in the admin trade feed. Confirm the history shows the same net profit/loss.
9. Turn Profit Mode ON for one test user in User Management, then place an order as that user. Confirm it settles as a win at the full quoted payout and that the result modal says "Applied by administrator". Turn it OFF and confirm a further order settles normally. Repeat with the all-users switch and confirm it covers accounts whose own toggle is off.
10. On a phone-width admin window, expand a user row, wait through several list refreshes, and confirm the expanded details stay expanded and the other users are still listed. Tap a second row and confirm the first row is unaffected. Confirm the Edit and Manually approve buttons in a card still work.
11. Open the AI Quant page. Buying a 7-day or 30-day plan must debit the principal and create the order. The 1-day, 90-day and 180-day plans should say they are not available rather than reporting a success - add them to `investment_products` if you want to sell them.
12. On the exchange page, confirm the button says swapping is not available and no balance changes.
13. On the AI Quant admin page, settle one day and confirm the credit reaches the member's balance. Click Settle Day twice for the same day and confirm the second call reports "already settled" and pays nothing. Cancel & Refund must return the principal plus the unsettled days exactly once.
14. On the AI Quant page, buy a 7-day plan and confirm it appears in your own order history with the plan name, the amount, the rate, a day counter, and a "settles in" countdown rather than "finalising".
15. Apply for a loan, then open Loan Management as admin and confirm the row shows the member's email and six-digit UID, not a uuid. Check the AI Quant and Balance Adjuster histories for the same.
16. Trade a coin that is not in `products` (for example one only listed on the home page). Confirm the order is refused with the list of tradable markets, and that the balance is unchanged.
17. Sign in as an admin, open User Management, and confirm the search box is empty on load - not filled with your own gmail address - and that all users are listed.
18. Trade every tab in turn: crypto, metals and forex. Each must place an order without an `unknown market` error, and the odds shown before the order must equal the payout charged.
19. Open User Management as admin and confirm the search box is empty on load, stays empty across several list refreshes, and still filters when you type. Refresh a few times: the address must not come back.
20. Buy each of the six AI Quant plans. Confirm the principal leaves the wallet, the plan appears in your history with a day counter and a countdown, and the name and rate on the card match the database.
21. With `scripts/settle-investments.mjs` running, buy the 1-day plan and wait. Confirm the profit is credited about 24 hours later and the principal comes back with it. Run the script twice in a row: the second run must pay nothing.
22. Place three orders in a row on the same market without waiting. All three must be accepted, and the balance must drop by the sum of all three stakes.
23. Start an order and press Close and let it run. Confirm the record list shows it as Running, place another order immediately, then reload the page. Once the time is up the first order must settle on its own and the profit must be credited.
24. Start an order and press Cancel & refund. Confirm the full stake returns and the order shows as void.
25. Check the duration selector reads 20% for 60s, 30% for 120s and 40% for 300s, and that a settled 60s order with a 100 stake pays exactly 120.
26. Buy each of the six AI Quant plans. Each must debit the principal and appear in your history with a day counter and a countdown.
27. Test a failed/offline submission. It must show an error and preserve the input; do not assume a request failed solely because its response timed out-check its history before retrying.


Reference for realtime setup: https://supabase.com/docs/guides/realtime/postgres-changes
