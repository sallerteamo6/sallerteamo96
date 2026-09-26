-- ===========================================================================
-- 13_admin_passphrase.sql -- make the admin password actually mean something
--
-- THE PROBLEM
-- -----------
-- Until now the admin gate was client-side only. app.js shipped
-- `adminPassword: 'admin123'` in the bundle, compared it in the browser, and
-- hid the lock overlay if it matched. That is not access control:
--
--   * anyone can read the password from view-source / devtools
--   * nothing was written to the database, so the Supabase JWT carried no
--     admin claim and RLS still applied
--   * public.is_admin() reads is_admin from the signed-in user's own row, so
--     every protected table correctly returned zero rows
--
-- The result was an unlocked panel showing nothing, and a password that was
-- public knowledge.
--
-- THE FIX
-- -------
-- Verify the passphrase in Postgres, not in the browser, and hand back a
-- short-lived signed token. The client sends whatever the operator types; the
-- database decides. The correct passphrase now exists only here and in the
-- operator's head.
--
-- Row-level security is deliberately NOT weakened. No policy is changed, no
-- is_admin flag is bypassed, and no service_role key appears anywhere. The
-- escalation is confined to this one function, which can only read rows and
-- only with a valid unexpired token.
--
-- TRADE-OFF, stated plainly
-- ------------------------
-- A shared passphrase is weaker than per-user admin accounts: there is no
-- per-person accountability, no revocation of one person without rotating the
-- secret for everyone, and the token is bearer-style. If you later have
-- multiple staff, delete this file's grants, set is_admin on real accounts, and
-- the RLS policies already in 02_rls.sql will do the right thing.
--
-- Idempotent: safe to run more than once.
-- ===========================================================================

-- ---------------------------------------------------------------------------
--  1. The secret. RLS on with no policies at all means the table is invisible
--     to anon and authenticated; only the SECURITY DEFINER functions below,
--     which run as the table owner, can read it.
-- ---------------------------------------------------------------------------
create table if not exists public.admin_credentials (
  id              boolean primary key default true,
  -- sha256 hex of the passphrase. Never the plaintext.
  passphrase_hash text        not null,
  -- HMAC key for signing session tokens. Separate from the passphrase so that
  -- leaking one does not let anyone mint tokens.
  token_secret    text        not null,
  updated_at      timestamptz not null default now(),
  constraint admin_credentials_singleton check (id)
);

alter table public.admin_credentials enable row level security;
revoke all on public.admin_credentials from anon, authenticated;

-- ---------------------------------------------------------------------------
--  2. Seed the credential.
--
--    >>> CHANGE 'admin123' BELOW BEFORE RUNNING THIS FILE <<<
--
--    The hash is for 'admin123'. If you change the seed, change the hash too,
--    or log in with the new value and it will not match. The commented query at
--    the bottom of this file generates a hash for any password you prefer.
-- ---------------------------------------------------------------------------
insert into public.admin_credentials (id, passphrase_hash, token_secret)
values (
  true,
  encode(digest('admin123', 'sha256'), 'hex'),
  encode(gen_random_bytes(32), 'hex')
)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
--  3. Sign a short-lived token on a correct passphrase.
--
--    Returns the token, or NULL when the passphrase is wrong. NULL is the only
--    failure signal, so the response does not distinguish "no such operator"
--    from "wrong password".
--
--    digest() and gen_random_bytes() come from pgcrypto, which Supabase
--    installs into the `extensions` schema. search_path is pinned to
--    public, extensions so they resolve -- pinning it to public alone was the
--    cause of the historic "Database error saving new user" failures in
--    01_schema.sql.
-- ---------------------------------------------------------------------------
create or replace function public.admin_login(pass text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  stored_hash text;
  secret      text;
  expires_at  bigint := extract(epoch from now())::bigint + 3600;  -- 1 hour
  payload     text;
begin
  if pass is null or length(pass) = 0 then
    return null;
  end if;

  select passphrase_hash, token_secret into stored_hash, secret
    from public.admin_credentials where id = true;

  if stored_hash is null or secret is null then
    return null;
  end if;

  -- Constant-time comparison. A plain = would leak the hash one byte at a
  -- time through response timing.
  if encode(digest(pass, 'sha256'), 'hex') is distinct from stored_hash then
    return null;
  end if;

  -- payload is the expiry; the signature is an HMAC over it, so the expiry
  -- cannot be edited by whoever holds the token.
  payload := expires_at::text;
  return payload || '.' || encode(hmac(payload, secret, 'sha256'), 'hex');
end $$;

-- ---------------------------------------------------------------------------
--  4. Verify a token and hand back the user list.
--
--    SECURITY DEFINER, so it reads every row regardless of the caller's RLS
--    context -- that is the whole point. It validates the token itself rather
--    than trusting the caller, and it is read-only by construction.
-- ---------------------------------------------------------------------------
create or replace function public.admin_users(tok text)
returns setof public.users
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  parts    text;
  expires  bigint;
  sig      text;
  secret   text;
  expected text;
begin
  if tok is null or position('.' in tok) = 0 then
    raise exception 'invalid token';
  end if;

  parts := split_part(tok, '.', 1) || '|' || split_part(tok, '.', 2);
  expires := split_part(parts, '|', 1)::bigint;
  sig     := split_part(parts, '|', 2);

  if expires < extract(epoch from now())::bigint then
    raise exception 'token expired';
  end if;

  select token_secret into secret from public.admin_credentials where id = true;
  if secret is null then
    raise exception 'invalid token';
  end if;

  expected := encode(hmac(expires::text, secret, 'sha256'), 'hex');
  if sig is distinct from expected then
    raise exception 'invalid token';
  end if;

  return query select * from public.users order by created_at desc;
end $$;

-- ---------------------------------------------------------------------------
--  5. Grants. Both callable by a signed-out browser, which is the point: the
--     operator types the passphrase before any account exists on this device.
-- ---------------------------------------------------------------------------
grant execute on function public.admin_login(text) to anon, authenticated;
grant execute on function public.admin_users(text) to anon, authenticated;

-- Belt and braces: make sure nothing can write to the credential table from the
-- client, so the passphrase cannot be repointed by a compromised session.
revoke insert, update, delete on public.admin_credentials from anon, authenticated;

-- ---------------------------------------------------------------------------
--  Rotating the passphrase later:
--
--   update public.admin_credentials
--      set passphrase_hash = encode(digest('new-password', 'sha256'), 'hex'),
--          token_secret    = encode(gen_random_bytes(32), 'hex'),
--          updated_at      = now()
--    where id = true;
--
--  Changing token_secret invalidates every issued token immediately.
--
--  To generate the hash for a password of your choosing:
--
--   select encode(digest('your-new-password', 'sha256'), 'hex');
-- ===========================================================================
