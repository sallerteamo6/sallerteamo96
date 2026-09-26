# Install this update

1. Keep a backup of your current website and database.
2. If you have not already applied `supabase/v2/14_admin_data_fix.sql`, run it in Supabase SQL Editor first. It requires the existing v2 schema and admin-password setup.
3. Run `supabase/v2/15_live_delivery.sql` if not already installed, then run the NEW `supabase/v2/16_admin_session_fixes.sql` in full. These upgrades preserve records, balances, UIDs, and the admin password. Do not rerun schema/seed/reset scripts on a live project.
4. Replace the website files with this folder's contents. Preserve your production `scripts/config.js` if its settings differ.
5. Press Ctrl+Shift+R and sign in again on both customer and admin pages.

## Latest fixes

- Login restoration now waits for Supabase identity, independently of slower table loading. Support sends and withdrawal submission recheck the authenticated session.
- Customer/admin support sends retain error reporting and server confirmation; removed redundant chat repaint timers that disrupted scrolling.
- User Management actions await a protected RPC. Manual approval works without documents and is explicitly recorded as `admin_override`; it is not a document review. Role/status changes validate values and protect the last active administrator. Archive preserves records and marks the profile banned; this does not revoke existing Supabase tokens.
- Balance adjuster shows email and public UID and honors the selected user in the edit link.
- Deposits no longer display the corrupted currency text. Withdrawal approval selects the matching transaction; fixed async filter callbacks that accidentally matched every row, including unrelated overdue loans.
- Save limits validates numeric values and confirms database persistence before showing success.
- Removed repeated market listeners/timers, redundant auth bootstrap on token refresh, unconditional redraw loops, and large private-data localStorage writes. Page loading, polling and subscriptions now request relevant tables; unchanged snapshots do not redraw the UI. No measured production latency claim is made.
- Profit Mode is disabled in User Management because it forces winning outcomes. It was not enabled or tested as a real-money outcome override. Legacy trading/AI settlement code elsewhere still requires separate review; this patch is not a trading-engine certification. Removed automatic client settlement/investment writes during general page loading.

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

The admin-password credential allows protected data reads, support-chat replies/read receipts, audited user-management actions (including explicit manual approval), and fund-limit updates. Financial approvals, balance adjustments, and document-based KYC review still require a signed-in account whose database profile has `is_admin = true`. Failed or unauthorized actions now report an error instead of pretending to succeed. This update does not promote accounts or disable row-level security.

## Checks completed

All JavaScript files changed here and all inline page scripts passed syntax checks. These regression suites passed using mocked backend responses:

- `node tests/admin-uid.test.cjs`
- `node tests/admin-access.test.cjs`
- `node tests/delivery.test.cjs`
- `node tests/stability.test.cjs`

They include execution of the User Management edit/modal, manual approval, role, status and archive handlers, matching withdrawal selection, delayed auth restoration, failed limit saves, and unchanged-data redraw suppression. They also cover UUID/UID mapping, admin access and expired-token priority, pagination, withdrawal destination/type, KYC fields, chat aliases and incoming events, operator replies, simultaneous reads, rejected writes, language persistence, and single server-controlled balance changes.

The live database was not accessed. The new SQL was reviewed but could not be executed here. Browser rendering tests could not run because the browser executable was unavailable. This is not a complete audit of trading, exchange, or investment settlement features.

## Live acceptance check after installation

Use a customer browser and a separate admin browser:

1. Change language, reload, and confirm it stays selected. Confirm the admin selector updates navigation.
2. Send chat messages both ways. Confirm they appear once, then reconnect a temporarily disconnected tab and confirm it catches up.
3. Submit one deposit, withdrawal, loan, and basic KYC request from a test account. Confirm the matching admin page shows the correct account, amount, destination/proof, and ID images.
4. Review test requests from a database-admin account; verify the customer receives updated status. Confirm approving once changes the balance once.
5. From User Management open Edit, check the balance-adjust link selects the same UID/email, then test role/status changes using disposable accounts. Test manual approval with no uploaded documents and confirm it is labelled manual approval. Save fund limits and reload both pages to confirm persistence.
6. Test a failed/offline submission. It must show an error and preserve the input; do not assume a request failed solely because its response timed out—check its history before retrying.

Reference for realtime setup: https://supabase.com/docs/guides/realtime/postgres-changes
