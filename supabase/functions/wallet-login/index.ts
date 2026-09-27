/*
 * wallet-login: sign in with an Ethereum wallet, verified server-side.
 *
 * WHY THIS EXISTS
 *   The browser cannot do this. Signing in with a wallet means recovering the
 *   signer from an Ethereum signature and checking it against the address being
 *   claimed. If the page did that itself, a visitor could type any address and
 *   any signature and be let in, because they would be checking their own lie.
 *   The page calls this public endpoint. Signature verification and the service
 *   credential stay on the server; callers cannot choose a verified identity.
 *
 * WHAT IT DOES
 *   nonce  - ask the database for a single-use challenge. The message is built
 *            and stored there, not here, so the text the member signs cannot be
 *            edited by the page afterwards.
 *   verify - consume the challenge, recover the signer from the signature, check
 *            it equals the address the challenge was issued for, make sure the
 *            account exists, and hand back a one-time token the client exchanges
 *            for a session.
 *
 * DEPLOY
 *   Apply 24_wallet_login_challenges.sql and 26_wallet_login_repair.sql first.
 *   supabase functions deploy wallet-login --no-verify-jwt
 *
 *   Set SITE_URL in the secrets to the address members actually use, including
 *   the scheme. It goes into the signed text. Supabase supplies the service
 *   role key automatically; never place it in the browser configuration.
 *
 * WHAT IT WILL NOT DO
 *   It never accepts an address on trust. The address in the request is only ever
 *   used to look up a challenge that was issued for that same address, and the
 *   signature has to recover to it. A caller who controls the request body
 *   controls nothing that matters.
 */

import { verifyMessage } from "npm:ethers@6";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const ADDR = /^0x[0-9a-fA-F]{40}$/;

function env(name: string): string {
  // Supabase exposes Deno.env and the older Deno.env.get; support both so this
  // runs on the current runtime without a version pin.
  const e = (globalThis as any).Deno?.env;
  if (e && typeof e.get === "function") return e.get(name) ?? "";
  return e?.[name] ?? "";
}

function authHeaders(extra: Record<string, string> = {}) {
  // SUPABASE_SERVICE_KEY was a local-script convention, not a hosted default.
  // Prefer the injected key. Also support the new secret-key environment map.
  let key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_SERVICE_KEY");
  if (!key) {
    try { key = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}").default || ""; } catch { /* reported below */ }
  }
  if (!key || !env("SUPABASE_URL")) throw new Error("Missing server auth configuration");
  return {
    apikey: key,
    ...(key.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${key}` }),
    "Content-Type": "application/json",
    ...extra,
  };
}

/** Call a Postgres function as the service role. */
async function rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T> {
  const url = `${env("SUPABASE_URL")}/rest/v1/rpc/${fn}`;
  const res = await fetch(url, { method: "POST", headers: authHeaders(), body: JSON.stringify(args) });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `${fn} failed (${res.status})`);
  return text ? JSON.parse(text) : (null as T);
}

/** Call the Supabase Auth admin API. */
async function authAdmin(path: string, method: string, body?: unknown) {
  const url = `${env("SUPABASE_URL")}/auth/v1${path}`;
  const res = await fetch(url, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!res.ok) {
    const msg = parsed?.msg || parsed?.message || parsed?.error_description || text || `auth ${res.status}`;
    throw new Error(msg);
  }
  return parsed;
}

function randomPassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * This flow uses a confirmed Auth email identity for each wallet. The email is
 * a non-deliverable internal placeholder; the wallet signature is the proof.
 * Existing linked accounts keep their original Auth email.
 */
function derivedEmail(address: string): string {
  // A reserved, non-deliverable domain independent of a website/domain change.
  // Returning accounts use the email from auth.users, never this fallback.
  return `${address.toLowerCase().replace(/^0x/, "")}@wallet.invalid`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Use POST" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "Expected a JSON body" }, 400);
  }

  const action = String(body?.action || "").toLowerCase();
  const address = String(body?.address || "").trim();

  if (!ADDR.test(address)) {
    return json({ ok: false, error: "That is not a valid wallet address" }, 400);
  }
  const addr = address.toLowerCase();

  try {
    // ---- 1. Challenge -----------------------------------------------------
    if (action === "nonce") {
      const origin = new URL(env("SITE_URL") || env("SUPABASE_URL")).origin;
      const out = await rpc("wallet_issue_nonce", { p_address: addr, p_origin: origin });
      return json({
        ok: true,
        address: out.address,
        nonce: out.nonce,
        message: out.message,
        expires_at: out.expires_at,
      });
    }

    if (action !== "verify") {
      return json({ ok: false, error: "Unknown action" }, 400);
    }

    // ---- 2. Consume the challenge ----------------------------------------
    // Single use, and burnt whatever happens next, so a captured signature
    // cannot be replayed against a second address.
    const claim = await rpc("wallet_consume_nonce", {
      p_address: addr,
      p_nonce: String(body?.nonce || ""),
    });
    if (!claim?.ok) {
      const why: Record<string, string> = {
        no_challenge: "Sign-in expired before it was signed. Try again.",
        already_used: "That sign-in link has already been used. Try again.",
        expired: "Sign-in expired before it was signed. Try again.",
        bad_nonce: "That sign-in could not be matched. Try again.",
        bad_address: "That is not a valid wallet address",
      };
      return json({ ok: false, error: why[claim?.reason] || "Sign-in could not be verified. Try again." }, 400);
    }

    // ---- 3. The actual verification --------------------------------------
    // This is the line the browser is not allowed to draw. The message comes
    // from the row the database stored, not from the request, so it is the same
    // text that was displayed to the member.
    const signature = String(body?.signature || "");
    if (!/^0x[0-9a-fA-F]+$/.test(signature)) {
      return json({ ok: false, error: "The wallet returned something that is not a signature" }, 400);
    }

    let recovered: string;
    try {
      // EIP-191, which is what personal_sign produces. A contract wallet can
      // return an EIP-1271 magic value instead, which cannot be checked from
      // here without calling the chain; that is reported plainly rather than
      // being guessed at.
      recovered = verifyMessage(claim.message, signature);
    } catch {
      return json({ ok: false, error: "The signature could not be read. Try again." }, 400);
    }
    if (!ADDR.test(recovered)) {
      return json(
        { ok: false, error: "This wallet signs through a smart contract, which cannot be verified here. Use email and password." },
        400,
      );
    }
    if (recovered.toLowerCase() !== claim.address.toLowerCase()) {
      return json({ ok: false, error: "That signature is from a different wallet" }, 400);
    }

    // ---- 4. Account -------------------------------------------------------
    // One address, one account, permanently: wallet_link_profile refuses if the
    // address is already on another profile, so an address cannot be attached
    // twice and take a balance with it.
    const email = derivedEmail(addr);
    let link0 = await rpc<{ uid: string; email: string } | null>("wallet_user_email", { p_address: addr });

    if (!link0?.uid) {
      // First time this wallet has been seen. The password is random and is
      // never sent anywhere: it exists only so GoTrue will accept the account,
      // and the session below is minted separately.
      try {
        const created = await authAdmin("/admin/users", "POST", {
          email,
          password: randomPassword(),
          email_confirm: true,
          user_metadata: { wallet_address: addr, login_method: "wallet" },
          // Only the server can write this. It allows recovery if the profile
          // write fails after Auth created the account, without trusting metadata
          // that an ordinary email user can edit.
          app_metadata: { wallet_address: addr, login_method: "wallet" },
        });
        link0 = { uid: created?.id, email: created?.email || email };
      } catch (e) {
        // Another completed verification may have created this same account.
        // Reuse only a linked or server-marked identity, never an email match.
        link0 = await rpc("wallet_user_email", { p_address: addr });
        if (!link0?.uid) throw e;
      }
    }
    if (!link0?.uid) {
      return json({ ok: false, error: "The account could not be prepared. Try again." }, 500);
    }

    // The insert trigger in 06_auth.sql sets account from the email, so a wallet
    // profile is created with the derived placeholder and rewritten here to the
    // real 0x address. This also fails if the address is already on another
    // profile, which is the point.
    try {
      await rpc("wallet_link_profile", {
        p_uid: link0.uid,
        p_address: addr,
        p_email: link0.email,
      });
    } catch (e) {
      const message = String((e as Error)?.message || e);
      if (/already linked/i.test(message)) {
        return json(
          { ok: false, error: "That wallet is already linked to another account. Sign in with email and password." },
          409,
        );
      }
      throw e;
    }

    // ---- 5. Hand back a session ------------------------------------------
    // generate_link does not send an email, it mints a one-time token. The
    // client exchanges it for a session with verifyOtp, so no long-lived
    // credential is ever passed to the browser and the password generated above
    // is never transmitted anywhere.
    const link = await authAdmin("/admin/generate_link", "POST", {
      type: "magiclink",
      email: link0.email,
    });
    // Raw GoTrue REST returns these fields at the top level. Only auth-js
    // wraps them in `properties`; reading that wrapper here lost every token.
    const tokenHash = link?.hashed_token || link?.properties?.hashed_token;
    const linkUserId = link?.id || link?.user?.id;
    if (linkUserId && linkUserId !== link0.uid) {
      throw new Error("Session identity does not match the verified wallet");
    }
    if (!tokenHash) {
      return json({ ok: false, error: "No sign-in session was returned. Please try again or contact support." }, 500);
    }

    return json({ ok: true, address: addr, email: link0.email, token_hash: tokenHash });
  } catch (e) {
    const message = String((e as Error)?.message || e);
    // GoTrue reports a bad generate_link for a user that does not exist. That is
    // a real misconfiguration, not a member error, so it is not dressed up as one.
    console.error("wallet-login failed:", message);
    if (/suspended or banned/i.test(message)) {
      return json({ ok: false, error: "This account is suspended or banned. Please contact support." }, 403);
    }
    if (/already linked/i.test(message)) {
      return json({ ok: false, error: "This wallet has conflicting account records. Please contact support." }, 409);
    }
    return json({ ok: false, error: "Wallet sign-in is not set up on the server yet." }, 500);
  }
});
