# Admin user data and hamburger UID repair

## Update: authorized admin access

This update removes the obsolete “Admin data is hidden” banner and the matching User Management empty-state restriction. Both verified admin-password sessions and signed-in database admins are recognized. An expired password-session token no longer overrides a signed-in database admin. Repeated fetch loops in Users, Loans, and Balance Adjuster are removed. An unrelated table failure no longer blocks the loaded user list.

Replace the website files and press Ctrl+Shift+R. If you already successfully ran `14_admin_data_fix.sql` from the previous download, no additional SQL migration is needed. Otherwise apply it using the steps below. Database access still requires valid server authorization.


## Apply to the existing platform

1. Back up the existing database and website files.
2. In Supabase > SQL Editor, run `supabase/v2/14_admin_data_fix.sql` in full. This upgrades the existing v2 database; it does not reset the admin password or change balances. It includes the six-digit UID migration. It requires the existing schema and `13_admin_passphrase.sql` setup. If admin sign-in already works, do not rerun the older setup scripts.
3. Upload the contents of this project folder to replace the existing website files. Preserve your production `scripts/config.js` settings if they differ.
4. Refresh the browser and unlock admin again. If an older cached page remains, use Ctrl+Shift+R.
5. Register a test account. Open Admin > Users, then visit another admin page and return. The user should appear within 15 seconds while admin is visible. Confirm the hamburger menu shows the same six-digit UID as Admin > Users.

## Problems found and fixed

- `admin_users` declared its token parser as `text[]` but used it as text, breaking the server-side user query.
- Raw database rows contain `id`, but the app mapper only read `uid`. Admin user identities were lost, breaking related-record lookups.
- Shared-password admin sign-in loaded users only. The new allowlisted read-only RPC loads related balances, verification, transactions, loans, investments, trades, and chat using the existing server-verified admin token. RLS and write permissions remain enforced.
- The admin snapshot was not restored on page navigation. Admin now validates and reloads on entry, visible-tab return, and every 15 seconds while visible. Failed reads show an error rather than silently becoming an empty list.
- The menu used the internal UUID instead of `uid_code`. It now displays the stable six-digit UID, preserving leading zeros. Until the profile arrives, it falls back to the actual UUID rather than inventing a number.
- The backend startup promise did not return a successful value after loading. It now resolves true when the load attempt completes.
- User reads now paginate in 500-row batches.
- Rerunning the original admin setup no longer resets an existing password and signing secret.

## Validation and limits

Run `node tests/admin-uid.test.cjs` and `node tests/admin-access.test.cjs` for regression checks. JavaScript syntax and mocked data-flow tests passed locally. These checks do not contact the production database. The SQL migration was reviewed but could not be executed against a live PostgreSQL database in this environment.

This repair covers admin reads and the menu UID. Shared-password access remains read-only; financial/admin write actions still require a signed-in account with database administrator permission. This is not a complete audit of trading, investment payouts, or other platform features.

If an account exists in Supabase Authentication but still does not appear after this repair, check whether it has a matching row in `public.users`. That indicates a separate missing profile/auth trigger issue; do not recreate accounts or overwrite balances to resolve it.
