# Wallet login repair — 27 September 2026

## Fix the error in your screenshot

The live Supabase project configured in this archive was checked on 27 September
2026. `/auth/v1/settings` returned **200**, but both GET and OPTIONS requests to
`/functions/v1/wallet-login` returned **404** with:

```json
{"code":"NOT_FOUND","message":"Requested function was not found"}
```

This confirms that the configured project has no deployed `wallet-login`
function. A failed browser preflight hid the 404 and produced "Could not reach
the server". The new frontend diagnoses this condition and shows a server-setup
error. The function still needs deployment before wallet login can work.

## Install through the Supabase dashboard

1. Extract this ZIP. In your existing project's [SQL Editor](https://supabase.com/dashboard/project/mpiqktgpgmbsljqgypzk/sql/new), paste and run the complete **WALLET-SETUP.sql** file at the top of the extracted project. It combines the required wallet migrations 24 and 26 in one transaction and can be rerun. It preserves existing users, balances, orders, roles, and member numbers. Do not reset the database.
2. Open [Edge Functions](https://supabase.com/dashboard/project/mpiqktgpgmbsljqgypzk/functions). Choose **Deploy a new function → Via Editor**. Name the function exactly **wallet-login**. Replace the editor's `index.ts` with the entire contents of **supabase/functions/wallet-login/index.ts** from this ZIP, then deploy. If the function already exists, edit its code and deploy the update.
3. Open the function's configuration and turn **Verify JWT** off. This endpoint runs before login; its code verifies the wallet signature before issuing a session. Do not disable database RLS.
4. In **Edge Functions → Secrets**, set **SITE_URL** to **https://sallerteamo6.github.io**, the website origin shown in the screenshot. If your website domain differs, use that actual origin. Supabase supplies the server credential through `SUPABASE_SERVICE_ROLE_KEY` or the default key in `SUPABASE_SECRET_KEYS`; do not put a service key in the website files. Keep Email authentication enabled because wallet accounts use internal Auth email identities.
5. Upload this ZIP's updated website files to your current host, reopen the site in Trust Wallet, and connect again. Approve both the connection and the sign-in message.

A normal account will appear in User Management after successful verified sign-in.
No private key, seed phrase, transaction, or token approval is needed for login.

### If you prefer the CLI

Run `WALLET-SETUP.sql` in SQL Editor first, then run these commands from the
extracted project folder:

```sh
supabase login
supabase secrets set SITE_URL=https://sallerteamo6.github.io --project-ref mpiqktgpgmbsljqgypzk
supabase functions deploy wallet-login --project-ref mpiqktgpgmbsljqgypzk --no-verify-jwt
```

The function configuration is in `supabase/config.toml`. The project reference
above is the one in `scripts/config.js`. Uploading files only to GitHub Pages
cannot deploy a Supabase Edge Function.

I did not deploy or modify the live Supabase account: deployment credentials were
not available in this workspace. The prepared code, SQL and instructions are
ready to apply with the project owner's Supabase access.

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

All **26 wallet tests passed**. They execute the actual client and Edge Function code with controlled wallet, Auth REST, and database responses. They cover a single handshake, double clicks, cancelled connection/signature and retry, repeated login with the same UID, profile creation recovery, token parsing, rejection of wrong/invalid signatures and expired/reused challenges, missing sessions/profiles, network/server errors, QR fallback, new key formats, suspended accounts, admin row rendering, and safe return URLs. Four additional tests reproduce a failed browser preflight and check diagnosis of missing functions, gateway blocks, and a reachable server without retrying sign-in or sending wallet data in the diagnostic request. One test uses the project's actual bundled Supabase client to exchange a token and restore the session from storage in a fresh client instance.

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
