-- Run after 14_admin_data_fix.sql. Preserves records, credentials and financial permissions.
begin;

alter table public.transactions add column if not exists request_details jsonb not null default '{}'::jsonb;
comment on column public.transactions.request_details is 'Withdrawal destination details; protected by the existing transaction RLS policies.';

-- Hosted Supabase listens to supabase_realtime, not the old app_public publication.
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname='supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['users','balances','transactions','contracts','investments','loans','chat_messages','verifications'] loop
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
      execute format('alter publication supabase_realtime add table public.%I',t);
    end if;
  end loop;
end $$;

-- Trigger-only helper. A support RPC places the already-validated token in the
-- current transaction; the trigger independently verifies it before preserving
-- the admin sender role. No profile or financial permissions are promoted.
create or replace function public.support_rpc_authorized() returns boolean
language plpgsql security definer set search_path=public,extensions as $$
declare tok text := current_setting('app.support_token',true);
begin
  if tok is null or tok='' then return false; end if;
  perform public.admin_users(tok);
  return true;
exception when others then return false;
end $$;
revoke all on function public.support_rpc_authorized() from public,anon,authenticated;

create or replace function public.guard_chat_insert() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if public.is_admin() or public.support_rpc_authorized() then return new; end if;
  new.from_role := 'user';
  if new.read_at is not null then raise exception 'read_at cannot be set on insert' using errcode='42501'; end if;
  return new;
end $$;

create or replace function public.guard_chat_mutation() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if public.is_admin() or public.support_rpc_authorized() then return new; end if;
  if exists(select 1 from public.chat_messages m where m.thread_id=old.thread_id and m.from_role='admin' and m.created_at>old.created_at) then
    raise exception 'cannot modify a message after an admin reply' using errcode='42501';
  end if;
  if new.from_role is distinct from old.from_role or new.uid is distinct from old.uid or new.thread_id is distinct from old.thread_id or new.read_at is distinct from old.read_at then
    raise exception 'cannot change message identity, role or receipt' using errcode='42501';
  end if;
  new.edited := true; new.edited_at := now();
  return new;
end $$;

create or replace function public.admin_support_send(tok text,p_uid uuid,p_body text,p_attachments jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare thread bigint; msg public.chat_messages; previous_token text;
begin
  perform public.admin_users(tok);
  if p_uid is null or not exists(select 1 from public.users where id=p_uid) then raise exception 'user not found'; end if;
  if jsonb_typeof(p_attachments) is distinct from 'array' then raise exception 'attachments must be an array'; end if;
  if jsonb_array_length(p_attachments)>6 or length(coalesce(p_body,''))>2000 then raise exception 'message too large'; end if;
  if length(btrim(coalesce(p_body,'')))=0 and jsonb_array_length(p_attachments)=0 then raise exception 'empty message'; end if;
  insert into public.chat_threads(uid) values(p_uid) on conflict (uid) where closed_at is null do nothing;
  select id into thread from public.chat_threads where uid=p_uid and closed_at is null;
  previous_token := current_setting('app.support_token',true);
  perform set_config('app.support_token',tok,true);
  insert into public.chat_messages(thread_id,uid,from_role,body,attachments)
    values(thread,p_uid,'admin',coalesce(p_body,''),p_attachments) returning * into msg;
  update public.chat_threads set last_at=now() where id=thread;
  perform set_config('app.support_token',coalesce(previous_token,''),true);
  return to_jsonb(msg);
end $$;

create or replace function public.admin_support_read(tok text,p_uid uuid)
returns void language plpgsql security definer set search_path=public,extensions as $$
declare previous_token text;
begin
  perform public.admin_users(tok);
  previous_token := current_setting('app.support_token',true);
  perform set_config('app.support_token',tok,true);
  update public.chat_messages set read_at=now() where uid=p_uid and from_role='user' and read_at is null;
  perform set_config('app.support_token',coalesce(previous_token,''),true);
end $$;
revoke all on function public.admin_support_send(text,uuid,text,jsonb) from public;
revoke all on function public.admin_support_read(text,uuid) from public;
grant execute on function public.admin_support_send(text,uuid,text,jsonb) to anon,authenticated;
grant execute on function public.admin_support_read(text,uuid) to anon,authenticated;

-- Real account administrators can reply and acknowledge messages under RLS.
drop policy if exists chat_threads_insert_admin on public.chat_threads;
create policy chat_threads_insert_admin on public.chat_threads for insert to authenticated with check(public.is_admin());
drop policy if exists chat_messages_insert_admin on public.chat_messages;
create policy chat_messages_insert_admin on public.chat_messages for insert to authenticated with check(public.is_admin() and exists(select 1 from public.chat_threads t where t.id=chat_messages.thread_id and t.uid=chat_messages.uid));
drop policy if exists chat_messages_update_admin on public.chat_messages;
create policy chat_messages_update_admin on public.chat_messages for update to authenticated using(public.is_admin()) with check(public.is_admin());

-- Only these owner-initiated pending submissions may reset review metadata.
create or replace function public.guard_verification_review() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if public.is_admin() then
    new.reviewed_by:=auth.uid(); new.reviewed_at:=now(); return new;
  end if;
  if new.uid is distinct from old.uid then raise exception 'cannot change verification owner'; end if;
  if auth.uid()=old.uid and old.status='rejected' and new.status='pending'
    and new.reviewed_by is null and new.reviewed_at is null
    and new.advanced_status is not distinct from old.advanced_status
    and new.advanced_reviewed_at is not distinct from old.advanced_reviewed_at then
    return new;
  end if;
  if auth.uid()=old.uid and old.status='approved' and new.status=old.status
    and new.reviewed_by is not distinct from old.reviewed_by and new.reviewed_at is not distinct from old.reviewed_at
    and (old.advanced_status is null or old.advanced_status='rejected') and new.advanced_status='pending'
    and new.advanced_reviewed_at is null then return new; end if;
  if new.status is distinct from old.status or new.reviewed_at is distinct from old.reviewed_at
    or new.reviewed_by is distinct from old.reviewed_by or new.advanced_status is distinct from old.advanced_status
    or new.advanced_reviewed_at is distinct from old.advanced_reviewed_at then
    raise exception 'only an admin may review a verification' using errcode='42501';
  end if;
  return new;
end $$;

create or replace function public.customer_submit_kyc(p_name text,p_email text,p_number text,p_phone text,p_front text,p_back text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare caller uuid:=auth.uid(); result public.verifications;
begin
  if caller is null then raise exception 'sign in required' using errcode='42501'; end if;
  if coalesce(btrim(p_name),'')='' or coalesce(btrim(p_number),'')='' or coalesce(p_front,'')='' or coalesce(p_back,'')='' then raise exception 'missing verification fields'; end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text,15));
  select * into result from public.verifications where uid=caller for update;
  if found and result.status in ('pending','approved') then raise exception 'verification already pending or approved'; end if;
  insert into public.verifications(uid,full_name,email,id_number,phone,id_front_url,id_back_url,status,submitted_at)
    values(caller,p_name,p_email,p_number,p_phone,p_front,p_back,'pending',now())
    on conflict(uid) do update set full_name=excluded.full_name,email=excluded.email,id_number=excluded.id_number,
      phone=excluded.phone,id_front_url=excluded.id_front_url,id_back_url=excluded.id_back_url,status='pending',
      submitted_at=now(),reviewed_by=null,reviewed_at=null,rejection_reason=null
    returning * into result;
  return to_jsonb(result);
end $$;

create or replace function public.customer_submit_advanced_kyc(p_image text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare caller uuid:=auth.uid(); result public.verifications;
begin
  if caller is null then raise exception 'sign in required' using errcode='42501'; end if;
  if coalesce(p_image,'')='' then raise exception 'upload your handheld ID photo'; end if;
  select * into result from public.verifications where uid=caller for update;
  if not found or result.status<>'approved' then raise exception 'basic verification must be approved first'; end if;
  if result.advanced_status in ('pending','approved') then raise exception 'advanced verification already pending or approved'; end if;
  update public.verifications set advanced=p_image,advanced_status='pending',advanced_submitted_at=now(),advanced_reviewed_at=null,advanced_note=''
    where uid=caller returning * into result;
  return to_jsonb(result);
end $$;
revoke all on function public.customer_submit_kyc(text,text,text,text,text,text) from public,anon;
revoke all on function public.customer_submit_advanced_kyc(text) from public,anon;
grant execute on function public.customer_submit_kyc(text,text,text,text,text,text) to authenticated;
grant execute on function public.customer_submit_advanced_kyc(text) to authenticated;

-- Password-admin fallback polls compact revisions, fetching private rows only
-- when a table changed. No customer data is broadcast on public channels.
create table if not exists public.admin_live_versions(table_name text primary key,version bigint not null default 0);
alter table public.admin_live_versions enable row level security;
revoke all on public.admin_live_versions from anon,authenticated;
insert into public.admin_live_versions(table_name) select unnest(array['users','balances','transactions','contracts','investments','loans','chat_messages','verifications']) on conflict do nothing;
create or replace function public.bump_admin_live_version() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  update public.admin_live_versions set version=version+1 where table_name=tg_table_name;
  return null;
end $$;
revoke all on function public.bump_admin_live_version() from public,anon,authenticated;
do $$ declare t text; begin
  foreach t in array array['users','balances','transactions','contracts','investments','loans','chat_messages','verifications'] loop
    execute format('drop trigger if exists delivery_version on public.%I',t);
    execute format('create trigger delivery_version after insert or update or delete on public.%I for each statement execute function public.bump_admin_live_version()',t);
  end loop;
end $$;
create or replace function public.admin_live_revisions(tok text) returns jsonb
language plpgsql security definer set search_path=public,extensions as $$
declare result jsonb;
begin
  perform public.admin_users(tok);
  select coalesce(jsonb_object_agg(table_name,version::text),'{}'::jsonb) into result from public.admin_live_versions;
  return result;
end $$;
revoke all on function public.admin_live_revisions(text) from public;
grant execute on function public.admin_live_revisions(text) to anon,authenticated;

create or replace function public.admin_review_advanced_kyc(p_uid uuid,p_status public.kyc_status,p_reason text default null)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'admin account required' using errcode='42501'; end if;
  if p_status not in ('approved','rejected') then raise exception 'invalid review status'; end if;
  if p_status='rejected' and coalesce(btrim(p_reason),'')='' then raise exception 'a rejection reason is required'; end if;
  update public.verifications set advanced_status=p_status,advanced_note=coalesce(p_reason,''),advanced_reviewed_at=now()
    where uid=p_uid and advanced_status='pending' and advanced is not null;
  if not found then raise exception 'pending advanced verification not found'; end if;
end $$;
revoke all on function public.admin_review_advanced_kyc(uuid,public.kyc_status,text) from public,anon;
grant execute on function public.admin_review_advanced_kyc(uuid,public.kyc_status,text) to authenticated;
notify pgrst,'reload schema';
commit;
