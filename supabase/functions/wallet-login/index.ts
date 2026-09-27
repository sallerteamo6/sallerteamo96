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

// The service credential, resolved once per isolate and then remembered.
//
// Supabase injects SUPABASE_SERVICE_ROLE_KEY automatically. On this project that
// injected legacy JWT was measured answering 200, but the project's legacy *anon*
// key was measured being refused outright and then accepted again, with no change
// to the key string - the gateway's acceptance of legacy keys is not something
// this file can assume. So the injected key is not trusted merely because it
// exists: each candidate is tried against the project and the first one actually
// accepted is used and cached. The current sb_secret_ key is preferred, since
// that is the credential Supabase now treats as current.
//
// If no candidate passes the probe the preferred one is used anyway, so this can
// never be worse than trusting the injected key, and the real call then reports
// the real error.
let resolvedKey: string | null = null;

function serviceKeyCandidates(): string[] {
  const out: string[] = [];
  // Newest first: SUPABASE_SECRET_KEYS holds the sb_secret_ key.
  try {
    const map = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}");
    if (map && typeof map.default === "string" && map.default) out.push(map.default);
  } catch { /* not a JSON map; fall through to the individual variables */ }
  for (const n of ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"]) {
    const v = env(n);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

async function serviceKey(): Promise<string> {
  if (resolvedKey) return resolvedKey;
  const url = env("SUPABASE_URL");
  if (!url) throw new Error("Missing server auth configuration: SUPABASE_URL is not set");

  const candidates = serviceKeyCandidates();
  if (!candidates.length) {
    throw new Error("Missing server auth configuration: no service key is available to this function");
  }

  // A cheap authenticated read. /auth/v1/settings needs only a valid key and
  // returns the provider list, so it proves the credential without touching data.
  for (const key of candidates) {
    try {
      const res = await fetch(`${url}/auth/v1/settings`, {
        headers: {
          apikey: key,
          // An sb_secret_ key is not a JWT and must not be sent as a bearer token.
          ...(key.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${key}` }),
        },
      });
      if (res.ok) {
        resolvedKey = key;
        return key;
      }
    } catch { /* try the next candidate */ }
  }

  // Nothing verified. Carry on with the preferred candidate rather than refusing:
  // the request it is about to make produces a better error than this would.
  resolvedKey = candidates[0];
  return resolvedKey;
}

async function authHeaders(extra: Record<string, string> = {}) {
  const key = await serviceKey();
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
  const res = await fetch(url, { method: "POST", headers: await authHeaders(), body: JSON.stringify(args) });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `${fn} failed (${res.status})`);
  return text ? JSON.parse(text) : (null as T);
}

/** Call the Supabase Auth admin API. */
async function authAdmin(path: string, method: string, body?: unknown) {
  const url = `${env("SUPABASE_URL")}/auth/v1${path}`;
  const res = await fetch(url, {
    method,
    headers: await authHeaders(),
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

    // ---- 2. Consume the challenge, and look the account up, together ------
    // Single use, and burnt whatever happens next, so a captured signature
    // cannot be replayed against a second address.
    //
    // These two used to run one after the other and cost two round trips. The
    // lookup is a read and the consume is a write to a different row, so they
    // cannot conflict, and a failed consume still rejects everything below: the
    // result is only used after claim.ok is confirmed. Measured on this project,
    // verify took 2.5-3.1s as a chain of four or five sequential calls; running
    // the independent ones together is most of the difference between that and
    // something that feels immediate.
    const [claim, linked] = await Promise.all([
      rpc<{ ok: boolean; address: string; message: string; reason?: string }>("wallet_consume_nonce", {
        p_address: addr,
        p_nonce: String(body?.nonce || ""),
      }),
      rpc<{ uid: string; email: string } | null>("wallet_user_email", { p_address: addr }).catch(() => null),
    ]);

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
    let link0: { uid: string; email: string } | null = linked;

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

    // ---- 5. Link the profile and mint the session, together ---------------
    // Both need only the uid and the email, which are both settled by now, and
    // neither reads what the other writes: the link writes public.users, the
    // mint talks to GoTrue. So they run at the same time instead of one after
    // the other, which is one round trip instead of two.
    //
    // generate_link does not send an email, it mints a one-time token. The
    // client exchanges it for a session with verifyOtp, so no long-lived
    // credential is ever passed to the browser and the password generated above
    // is never transmitted anywhere.
    //
    // The insert trigger in 06_auth.sql sets account from the email, so a wallet
    // profile is created with the derived placeholder and rewritten here to the
    // real 0x address. This also fails if the address is already on another
    // profile, which is the point.
    const [, link] = await Promise.all([
      rpc("wallet_link_profile", {
        p_uid: link0.uid,
        p_address: addr,
        p_email: link0.email,
      }),
      authAdmin("/admin/generate_link", "POST", {
        type: "magiclink",
        email: link0.email,
      }),
    ]);

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
      // wallet_link_profile is what refuses an address that is already on a
      // different profile. That is a member-facing answer, not an operator one,
      // so it keeps its own wording instead of falling through to the generic
      // conflicting-records message below.
      return json(
        { ok: false, error: "That wallet is already linked to another account. Sign in with email and password." },
        409,
      );
    }
    return json({ ok: false, error: "Wallet sign-in is not set up on the server yet." }, 500);
  }
});
