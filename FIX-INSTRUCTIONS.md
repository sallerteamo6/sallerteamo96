# Install this update

1. Keep a backup of your current website and database.
2. If you have not already applied `supabase/v2/14_admin_data_fix.sql`, run it in Supabase SQL Editor first. It requires the existing v2 schema and admin-password setup.
3. Run the NEW `supabase/v2/15_live_delivery.sql` in full. This step is required even if the previous fix was installed. It preserves your records, balances, UIDs, and admin password.
4. Replace the website files with this folder's contents. Preserve your production `scripts/config.js` if its settings differ.
5. Press Ctrl+Shift+R and sign in again on both customer and admin pages.

## What changed

- Language: repaired corrupted dropdown labels, corrected language code/name mapping, saved the selection across page loads, updated document language/direction, and added an admin language selector with translated navigation and common controls. Existing customer translation keys remain in use. Some untagged admin descriptions and dynamic messages remain English; user messages are not automatically translated.
- Chat: corrected `chat`/`chat_messages` aliases; sends now wait for the server and retain the draft after failure. Incoming messages repaint the service page. Both database-admin accounts and verified admin-password sessions can send support replies. Customers cannot impersonate support.
- Live delivery: corrected the Supabase realtime publication, restart subscriptions after auth changes, refresh after reconnect, and deduplicate simultaneous reads. Signed-in accounts receive Postgres changes. Password-admin sessions check compact revision counters every second while visible and download only changed tables. Connection and server latency still apply; offline tabs cannot receive instantly.
- Deposits/withdrawals: submissions no longer claim success before being saved. The withdrawal enum now matches the database, and destination details and deposit proof are preserved and shown through the existing admin views.
- Loans: corrected the principal/amount mapping and wait for a saved request before showing success.
- KYC: corrected name and image mappings, fixed the admin page treating a boolean refresh result as verification data, and added authenticated submission functions for basic/advanced verification and rejected-application resubmission. Advanced submission requires approved basic verification.
- Approval updates: await server results, refresh affected records, map UI statuses to database statuses, and remove duplicate client balance changes after transaction/loan approvals. Financial changes remain server-controlled.
- Earlier admin user-list and hamburger UID repairs are included.

## Permissions

The admin-password credential allows protected data reads and support-chat replies/read receipts. Financial approvals, balance adjustments, and KYC review still require a signed-in account whose database profile has `is_admin = true`. Failed or unauthorized actions now report an error instead of pretending to succeed. This update does not promote accounts or disable row-level security.

## Checks completed

All JavaScript files changed here and all inline page scripts passed syntax checks. These regression suites passed using mocked backend responses:

- `node tests/admin-uid.test.cjs`
- `node tests/admin-access.test.cjs`
- `node tests/delivery.test.cjs`

They cover UUID/UID mapping, admin access and expired-token priority, pagination, withdrawal destination/type, KYC fields, chat aliases and incoming events, operator replies, simultaneous reads, rejected writes, language persistence, and single server-controlled balance changes.

The live database was not accessed. The new SQL was reviewed but could not be executed here. Browser rendering tests could not run because the browser executable was unavailable. This is not a complete audit of trading, exchange, or investment settlement features.

## Live acceptance check after installation

Use a customer browser and a separate admin browser:

1. Change language, reload, and confirm it stays selected. Confirm the admin selector updates navigation.
2. Send chat messages both ways. Confirm they appear once, then reconnect a temporarily disconnected tab and confirm it catches up.
3. Submit one deposit, withdrawal, loan, and basic KYC request from a test account. Confirm the matching admin page shows the correct account, amount, destination/proof, and ID images.
4. Review test requests from a database-admin account; verify the customer receives updated status. Confirm approving once changes the balance once.
5. Test a failed/offline submission. It must show an error and preserve the input; do not assume a request failed solely because its response timed out—check its history before retrying.

Reference for realtime setup: https://supabase.com/docs/guides/realtime/postgres-changes
