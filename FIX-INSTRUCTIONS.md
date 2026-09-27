# Install this update

1. Keep a backup of your current website and database.
2. If you have not already applied `supabase/v2/14_admin_data_fix.sql`, run it in Supabase SQL Editor first. It requires the existing v2 schema and admin-password setup.
3. Run `supabase/v2/15_live_delivery.sql` if not already installed, then `supabase/v2/16_admin_session_fixes.sql`, then the NEW `supabase/v2/17_profit_mode_and_settlement.sql` in full, in that order. These upgrades preserve records, balances, UIDs, and the admin password. Do not rerun schema/seed/reset scripts on a live project.
4. Replace the website files with this folder's contents. Preserve your production `scripts/config.js` if its settings differ.
5. Press Ctrl+Shift+R and sign in again on both customer and admin pages.

`17_profit_mode_and_settlement.sql` is required for trading to settle at all. Until it is applied, `open_trade`, `settle_trade` and `admin_set_profit_mode` do not exist and every order will fail with a "function not found" error. It adds functions only: no table is dropped, no balance or transaction row is rewritten, and no account is promoted.

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

They include execution of the User Management edit/modal, manual approval, role, status and archive handlers, the per-user and all-users Profit Mode toggles, matching withdrawal selection, delayed auth restoration, failed limit saves, and unchanged-data redraw suppression. They also cover UUID/UID mapping, admin access and expired-token priority, pagination, withdrawal destination/type, KYC fields, chat aliases and incoming events, operator replies, simultaneous reads, rejected writes, language persistence, single server-controlled balance changes, the result modal rendering the server's profit and detail rows, an unsettled order reporting its reason instead of a number, every shipped page being free of the double-encoded text, no page writing a balance from the browser, the legacy trade re-upload staying disabled, a loan row resolving to the member's login and member number, an untradable market being refused before the balance is touched, AI Quant reading v2's `investments` with countable schedule days, the admin card rebuild being non-destructive and click-stable in a real browser, and the admin filter box resisting autofill in a real browser.

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
18. Test a failed/offline submission. It must show an error and preserve the input; do not assume a request failed solely because its response timed out-check its history before retrying.


Reference for realtime setup: https://supabase.com/docs/guides/realtime/postgres-changes
