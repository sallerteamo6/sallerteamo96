-- Apply after 22. Additive only: no table, column, balance, contract, user or
-- investment row is touched, and no existing grant is weakened.
--
-- What this fixes
--   1. The admin password could not be changed from the panel. The Settings page
--      had a working form with a Current / New / Confirm column, and pressing
--      Update Password returned "The admin password is now stored in the database
--      and cannot be changed from here", because changeAdminPassword() in app.js
--      was a stub that always failed. Rotating the passphrase meant opening the
--      Supabase SQL editor and pasting an UPDATE, which is a poor fit for a
--      routine security action and puts a credential in a query box.
--
--   2. A real account admin could be made to type the shared passphrase. The
--      lock is fail-closed, which is right, but its success test only read the
--      bulk users cache. A real admin could still be prompted, and once inside
--      the branch, a failed user-list refresh raised the lock over them. That is
--      fixed in app.js; the part that belongs here is making sure this function
--      accepts a real admin as well as a passphrase holder, so an account admin
--      can rotate it too.
--
-- Two things this deliberately does not do
--   - It does not store the passphrase. Neither the old nor the new form of it is
--     ever written to a table, a log, or a page; only a hash is.
--   - It does not change any RLS policy or grant a new role anything it did not
--     already have. admin_credentials already has RLS on with no policies, so it
--     is invisible to anon and authenticated and reachable only through these
--     SECURITY DEFINER functions.
--
-- The new hash is salted bcrypt rather than a bare sha256 of the passphrase.
-- A bare sha256 is a rainbow-table lookup away from the original for any password
-- in a wordlist, and rotating to a weak hash while adding the means to rotate
-- would have been the wrong order of operations. admin_login below now accepts
-- both formats, so a project whose credential is still a legacy sha256 keeps
-- working untouched and is upgraded to bcrypt the first time it is rotated.

begin;

-- ---------------------------------------------------------------------------
-- 1. admin_login: accept a legacy sha256 hash or a salted bcrypt one.
--
--    The stored value is self-describing, so no migration of the existing row is
--    needed and nothing has to be re-hashed offline. Everything else about the
--    function is unchanged, including NULL as the only failure signal: the
--    response still does not reveal whether an operator exists.
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
  ok          boolean := false;
begin
  if pass is null or length(pass) = 0 then
    return null;
  end if;

  select passphrase_hash, token_secret into stored_hash, secret
    from public.admin_credentials where id = true;

  if stored_hash is null or secret is null then
    return null;
  end if;

  -- A hash beginning with '$' is bcrypt, written by admin_set_passphrase below.
  -- A bare 64-character hex string is the legacy unsalted sha256, and is still
  -- accepted so an existing install is not locked out by this file. No marker is
  -- stored in front of the salt: crypt() has to be able to parse it, and a
  -- leading 'bf$' stops it doing exactly that. See migration 25.
  if left(stored_hash, 1) = '$' then
    ok := (crypt(pass, stored_hash) = stored_hash);
  else
    ok := (encode(digest(pass, 'sha256'), 'hex') = stored_hash);
  end if;

  if not ok then
    return null;
  end if;

  -- payload is the expiry; the signature is an HMAC over it, so the expiry
  -- cannot be edited by whoever holds the token.
  payload := expires_at::text;
  return payload || '.' || encode(hmac(payload, secret, 'sha256'), 'hex');
end $$;

-- ---------------------------------------------------------------------------
-- 2. Rotate the passphrase.
--
--    Returns the NEW signed token on success, NULL when the current passphrase is
--    wrong. Returning a token is what lets the operator who just changed the
--    password stay signed in: rotating token_secret invalidates every token
--    already issued, which is the point - it signs out every other unlocked tab
--    and any token someone may have copied - and the caller swaps in the fresh
--    one instead of being immediately locked out of the page they are standing on.
--
--    p_current is the passphrase itself and is always required and always
--    verified. p_tok is a separate, optional bearer token from admin_login, used
--    only to authorise a caller who has no account: a passphrase-only operator is
--    exactly who the shared passphrase exists for, so requiring auth.uid() would
--    lock out the person it was built for. The two are deliberately separate
--    arguments, because one of them is a secret to be checked and the other is
--    authority to be granted, and overloading a single argument for both would
--    make "which one was wrong" unanswerable.
--
--    The current passphrase is required even for an account admin. A stolen
--    session must not be able to take the panel over permanently by setting a
--    password it now knows.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_passphrase(
  p_current text,
  p_new     text,
  p_tok     text default null
) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  stored_hash text;
  secret      text;
  new_secret  text;
  tok_exp     text;
  tok_sig     text;
  token_ok    boolean := false;
  v_uid       uuid := auth.uid();
  parts       text;
  expires     bigint;
  sig         text;
  expected    text;
begin
  if p_current is null or length(p_current) = 0 then
    raise exception 'enter the current admin password' using errcode = '22023';
  end if;
  if p_new is null or length(p_new) < 8 then
    raise exception 'the new password must be at least 8 characters' using errcode = '22023';
  end if;
  if p_new = p_current then
    raise exception 'the new password must be different from the current one' using errcode = '22023';
  end if;

  -- May this caller rotate at all? A real account admin, or a valid unexpired
  -- token. The token is checked against the stored secret exactly as admin_users
  -- does, so an edited expiry or a forged signature gets nothing.
  if v_uid is not null and exists (
       select 1 from public.users u where u.id = v_uid and u.is_admin
     ) then
    token_ok := true;
  elsif p_tok is not null and position('.' in p_tok) > 0 then
    parts    := split_part(p_tok, '.', 1) || '|' || split_part(p_tok, '.', 2);
    expires  := split_part(parts, '|', 1)::bigint;
    sig      := split_part(parts, '|', 2);
    select token_secret into secret from public.admin_credentials where id = true;
    if secret is not null then
      expected := encode(hmac(expires::text, secret, 'sha256'), 'hex');
      if expires >= extract(epoch from now())::bigint and sig = expected then
        token_ok := true;
      end if;
    end if;
  end if;

  if not token_ok then
    raise exception 'admin sign-in required' using errcode = '42501';
  end if;

  select passphrase_hash into stored_hash
    from public.admin_credentials where id = true;
  if stored_hash is null then
    raise exception 'no admin password is set' using errcode = 'P0002';
  end if;

  -- The current passphrase must be right, whatever the caller's standing. NULL
  -- is the failure signal, the same as admin_login, so the response does not
  -- reveal whether an operator exists.
  if left(stored_hash, 1) = '$' then
    if crypt(p_current, stored_hash) is distinct from stored_hash then
      return null;
    end if;
  elsif encode(digest(p_current, 'sha256'), 'hex') is distinct from stored_hash then
    return null;
  end if;

  -- Rotate the signing key as well as the password. This is what signs out every
  -- other unlocked admin tab, and is why the function hands back a new token.
  new_secret := encode(gen_random_bytes(32), 'hex');

  update public.admin_credentials
     set passphrase_hash = crypt(p_new, gen_salt('bf')),
         token_secret    = new_secret,
         updated_at      = now()
   where id = true;

  tok_exp := (extract(epoch from now())::bigint + 3600)::text;
  tok_sig := encode(hmac(tok_exp, new_secret, 'sha256'), 'hex');
  return tok_exp || '.' || tok_sig;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Grants. anon is included on purpose: an operator holding only the shared
--    passphrase has no account, and the passphrase is precisely the credential
--    this rotates. Neither call can do anything without also proving the current
--    passphrase, and neither returns the hash.
-- ---------------------------------------------------------------------------
grant execute on function public.admin_login(text) to anon, authenticated;

-- The 3-argument form is what a client calls; revoking from public first means a
-- blanket execute left over from an earlier signature cannot survive this file.
revoke all on function public.admin_set_passphrase(text, text, text) from public;
grant  execute on function public.admin_set_passphrase(text, text, text) to anon, authenticated;

-- Belt and braces, restated: the table still cannot be written from the client, so
-- a compromised session cannot repoint the credential without going through this
-- function, which checks the current passphrase first.
revoke insert, update, delete on public.admin_credentials from anon, authenticated;

notify pgrst, 'reload schema';
commit;
