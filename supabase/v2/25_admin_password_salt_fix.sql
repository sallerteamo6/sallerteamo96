-- Apply after 24. Corrective only: one column value on one row is rewritten, and
-- two functions are replaced with bodies identical to migration 23 apart from the
-- salt handling below. No user, balance, contract or investment row is touched.
--
-- What this fixes
--   Migration 23 stored the new passphrase as
--
--       passphrase_hash = 'bf$' || crypt(p_new, gen_salt('bf'))
--
--   and pgcrypto's crypt() cannot read that. crypt(text, text) takes a crypt(3)
--   salt, which has to begin with the algorithm marker - '$2b$', '$2a$', '$5$'
--   and so on. Prefixing the hash with 'bf$' means the salt it is handed starts
--   with "bf$$2b$...", which is not a salt crypt recognises, so it raises or
--   returns NULL and the comparison can never be true.
--
--   The result was that changing the admin password appeared to work - the form
--   reported success and the old password stopped working - and then the NEW
--   password was rejected as incorrect as well, locking the operator out of the
--   panel entirely. Nothing was lost: the bcrypt hash underneath the three extra
--   characters is untouched and still describes the passphrase they chose.
--
--   The marker was only ever needed so admin_login could tell the two hash formats
--   apart, and it was not needed: a bcrypt hash always begins with '$', and a
--   legacy sha256 of a passphrase is 64 hex characters, which never can.
--
-- ---------------------------------------------------------------------------
-- The update below strips the three characters and leaves the bcrypt hash exactly
-- as it was, so the password that was just set starts working again immediately.
-- It is safe to re-run: the WHERE only matches rows that still carry the prefix.
--
-- Confirm it worked before trying to sign in:
--
--   select left(passphrase_hash, 4) from public.admin_credentials;
--   -- expect $2b$ ; a leading bf$ means it has not been repaired yet

begin;

-- ---------------------------------------------------------------------------
-- 1. Undo the prefix. The passphrase itself is unchanged by this.
-- ---------------------------------------------------------------------------
update public.admin_credentials
   set passphrase_hash = substring(passphrase_hash from 4),
       updated_at      = now()
 where id = true
   and left(passphrase_hash, 3) = 'bf$'
   and left(substring(passphrase_hash from 4), 4) in ('$2a$', '$2b$', '$2y$');

-- ---------------------------------------------------------------------------
-- 2. admin_login, corrected.
--
-- Three formats are accepted, so no project is locked out by any of them:
--
--   '$2b$...'                 a correct bcrypt hash, written from here on
--   'bf$$2b$...'              the broken form migration 23 wrote, stripped and
--                             accepted, and left in place so an operator who
--                             applied only migration 23 can still get in
--   64 hex characters          the original unsalted sha256
--
-- The broken form is verified rather than rejected because refusing it would
-- lock out exactly the person this file exists to help. The next password change
-- rewrites the row in the correct form and the second branch stops being reachable.
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

  if left(stored_hash, 3) = 'bf$' and left(substring(stored_hash from 4), 4) in ('$2a$', '$2b$', '$2y$') then
    ok := (crypt(pass, substring(stored_hash from 4)) = substring(stored_hash from 4));
  elsif left(stored_hash, 1) = '$' then
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
-- 3. admin_set_passphrase, corrected the same way: it verifies the current
--    password the same three-way way, and writes the salt with nothing in front
--    of it. The 'bf$' marker is gone, which is what stops the fault recurring.
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
  -- token, checked against the stored secret exactly as admin_users does.
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
  -- is the failure signal, the same as admin_login.
  if left(stored_hash, 3) = 'bf$' and left(substring(stored_hash from 4), 4) in ('$2a$', '$2b$', '$2y$') then
    if crypt(p_current, substring(stored_hash from 4)) is distinct from substring(stored_hash from 4) then
      return null;
    end if;
  elsif left(stored_hash, 1) = '$' then
    if crypt(p_current, stored_hash) is distinct from stored_hash then
      return null;
    end if;
  elsif encode(digest(p_current, 'sha256'), 'hex') is distinct from stored_hash then
    return null;
  end if;

  -- Rotating the signing key signs out every other unlocked admin tab, which is
  -- why the function hands back a new token for this one.
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
-- 4. Grants restated: replacing a function body does not touch its grants, but
--    being explicit costs nothing and survives a signature change.
-- ---------------------------------------------------------------------------
revoke all on function public.admin_login(text) from public;
grant  execute on function public.admin_login(text) to anon, authenticated;
revoke all on function public.admin_set_passphrase(text, text, text) from public;
grant  execute on function public.admin_set_passphrase(text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
