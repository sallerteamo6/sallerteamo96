# Wallet login repair — 27 September 2026

## Install this update

Website upload alone does not install the server fix. Complete all three parts:

1. **Upload the updated website files** from this project folder to your existing host. The page script versions were updated so browsers request the repaired JavaScript.
2. **Apply the database repair** in your existing Supabase project's SQL Editor. If migration 24 has not already been installed, run `supabase/v2/24_wallet_login_challenges.sql` first. Then run the complete `supabase/v2/26_wallet_login_repair.sql`. Keep your existing migrations and records; do not recreate or reset the database. Migration 26 is safe to run again.
3. **Redeploy the wallet-login Edge Function** with the updated `supabase/functions/wallet-login/index.ts`. Disable its **Verify JWT** setting: the endpoint runs before login and verifies the wallet signature itself. For CLI deployment, the setting is now correctly located in `supabase/config.toml`.

In **Edge Functions → Secrets**, set `SITE_URL` to the real website origin, for example `https://your-website.com` (replace the example with your domain). This is the website named in the sign-in message. The function uses Supabase's injected `SUPABASE_SERVICE_ROLE_KEY` or the default key in `SUPABASE_SECRET_KEYS`. Do not add a service key to `scripts/config.js` or any browser file. The old instruction to create a `SUPABASE_SERVICE_KEY` secret is no longer needed; Supabase reserves the `SUPABASE_` prefix.

If you deploy using the CLI, run these commands from the extracted project folder. The project reference below is the one already configured in this archive:

```sh
supabase login
supabase secrets set SITE_URL=https://YOUR-WEBSITE-DOMAIN --project-ref mpiqktgpgmbsljqgypzk
supabase functions deploy wallet-login --project-ref mpiqktgpgmbsljqgypzk --no-verify-jwt
```

Use the Supabase dashboard instead if you do not use the CLI: update the function code, deploy it, disable Verify JWT, and set SITE_URL. Keep Email authentication enabled because this implementation uses an internal Auth email identity to issue a session. Wallet users do not receive or need an email confirmation.

## What was fixed

- **Duplicate sign-in attempts:** the login page polled for a connected address and started a second handshake while `connectWallet()` was already signing in. The second nonce could replace the first. One shared promise now owns connection, signature approval, verification, and login.
- **Hidden failures:** the old code reported successful connection even when authentication failed. The login page now keeps the actual failure visible, and Try again retries wallet authentication.
- **Server credential and deployment configuration:** the function expected a nonstandard service-key name, and its configuration file was in a directory the CLI does not use. Both are corrected.
- **Missing session token:** the function called the raw Supabase Auth REST API but read the SDK's nested response format. It now reads the REST `hashed_token` correctly and validates the returned account identity.
- **Missing admin profile:** the server now inserts or updates the verified wallet's `public.users` row before issuing a token. It records the wallet address, marks `login_method = wallet`, and clears the guest flag. Existing UIDs, balances, roles, and orders are preserved. The existing admin user list shows this row with its WALLET label and member number.
- **Retry after partial account creation:** newly created Auth identities contain server-owned wallet metadata. If profile creation fails, a retry recovers that identity instead of creating another user. User-editable metadata or a matching email alone cannot claim an account.
- **Wallet compatibility:** the signed challenge is ordinary EIP-191 text, encoded to UTF-8 hexadecimal for `personal_sign`. The old message resembled SIWE but lacked required fields. Installed wallets are selected first; QR connection is the fallback.
- **Successful login requires a saved profile:** the client exchanges the one-time token for a Supabase session and reads the actual profile. It no longer manufactures a local user when the profile is missing.

The flow supports ordinary Ethereum-compatible accounts that implement `personal_sign`, including compatible MetaMask and Trust Wallet accounts. Smart-contract signature validation (EIP-1271), Solana, and Bitcoin login are not implemented. A sign-in signature does not approve a transaction, token allowance, or transfer.

Existing wallet accounts that were already linked to their public profile retain their identity. An older failed account with only user-editable wallet metadata is not automatically treated as a trusted wallet link; ambiguous legacy records require owner review rather than automatic merging.

## Tests completed

Run the wallet suite with Node 22.13+ or Node 24:

```sh
node --test tests/wallet-login.test.cjs
```

All **22 wallet tests passed**. They execute the actual client and Edge Function code with controlled wallet, Auth REST, and database responses. They cover a single handshake, double clicks, cancelled connection/signature and retry, repeated login with the same UID, profile creation recovery, token parsing, rejection of wrong/invalid signatures and expired/reused challenges, missing sessions/profiles, network/server errors, QR fallback, new key formats, suspended accounts, admin row rendering, and safe return URLs. One test uses the project's actual bundled Supabase client to exchange a token and restore the session from storage in a fresh client instance.

The tests mock signature recovery and the database. They do not validate ethers' cryptography, execute the migration against a live database, or exercise a real wallet extension. The production endpoint still verifies signatures with ethers on the server.

Related regression suites also passed:

```sh
node tests/admin-uid.test.cjs
node tests/admin-access.test.cjs
node tests/delivery.test.cjs
node tests/stability.test.cjs
node tests/sql-structure.check.cjs
```

JavaScript syntax was checked for the changed shared scripts and all inline page scripts. SQL checks verify structure and privilege declarations, not execution in Postgres. No live account or balance was changed during this repair.

## Live check after deployment

1. Open `login.html` in a fresh browser session, select Connect Wallet, approve the connection, then approve the **sign-in message**. Expect one signature request and a redirect to the website.
2. Reload the page. The same user should remain signed in.
3. In a separate administrator session, open User Management and clear any search filter. Confirm the wallet address appears with the WALLET label and its member number. Refresh if necessary.
4. Sign out, then sign in with the same wallet. Confirm the same UID, history, and balance, with no duplicate account.
5. Reject the sign-in message once. Confirm an error appears and Try again successfully restarts wallet sign-in.

If you see "not set up on the server", confirm migration 26 was applied to the same Supabase project as `scripts/config.js`, then check the wallet-login Edge Function logs. If no signature prompt appears, check function deployment, Verify JWT, and wallet permissions. Do not solve an error by disabling database RLS or trusting a wallet address without its verified signature.

References: [Supabase function configuration](https://supabase.com/docs/guides/functions/function-configuration), [Supabase environment variables](https://supabase.com/docs/guides/functions/secrets), and [Auth response transformation](https://github.com/supabase/auth-js/blob/master/src/lib/fetch.ts).
