-- Apply after 14 and 15. No balance, transaction or trade outcome changes.
begin;
alter table public.verifications add column if not exists verification_method text not null default 'documents';

create or replace function public.admin_action_authorized() returns boolean
language plpgsql security definer set search_path=public,extensions as $$
declare token text:=current_setting('app.admin_action_token',true);
begin
  if public.is_admin() then return true; end if;
  if coalesce(token,'')='' then return false; end if;
  perform public.admin_users(token); return true;
exception when others then return false;
end $$;
revoke all on function public.admin_action_authorized() from public,anon,authenticated;

create or replace function public.guard_user_privileges() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if public.admin_action_authorized() then return new; end if;
  if new.is_admin is distinct from old.is_admin then raise exception 'only an administrator may change roles' using errcode='42501'; end if;
  if new.status is distinct from old.status then raise exception 'only an administrator may change status' using errcode='42501'; end if;
  return new;
end $$;

-- Preserve the submission exceptions from migration 15, adding an explicit
-- authenticated manual-administrator path that does not claim document review.
create or replace function public.guard_verification_review() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if public.admin_action_authorized() then
    new.reviewed_by:=case when public.is_admin() then auth.uid() else null end;
    new.reviewed_at:=now(); return new;
  end if;
  if new.uid is distinct from old.uid or new.verification_method is distinct from old.verification_method then
    raise exception 'cannot change verification owner or method';
  end if;
  if auth.uid()=old.uid and old.status='rejected' and new.status='pending'
    and new.reviewed_by is null and new.reviewed_at is null
    and new.advanced_status is not distinct from old.advanced_status
    and new.advanced_reviewed_at is not distinct from old.advanced_reviewed_at then return new; end if;
  if auth.uid()=old.uid and old.status='approved' and new.status=old.status
    and new.reviewed_by is not distinct from old.reviewed_by and new.reviewed_at is not distinct from old.reviewed_at
    and (old.advanced_status is null or old.advanced_status='rejected') and new.advanced_status='pending'
    and new.advanced_reviewed_at is null then return new; end if;
  if new.status is distinct from old.status or new.reviewed_at is distinct from old.reviewed_at
    or new.reviewed_by is distinct from old.reviewed_by or new.advanced_status is distinct from old.advanced_status
    or new.advanced_reviewed_at is distinct from old.advanced_reviewed_at then
    raise exception 'only an administrator may review verification' using errcode='42501';
  end if;
  return new;
end $$;

create or replace function public.admin_manage_user(tok text,p_uid uuid,p_action text,p_value text default null)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare target public.users; old_row jsonb; previous_token text; actor_id uuid; result jsonb;
begin
  if not public.is_admin() then perform public.admin_users(tok); end if;
  if p_action not in ('role','status','archive','manual_verify') or p_action is null then raise exception 'unsupported user action'; end if;
  -- Serialize role/status changes so concurrent actions cannot remove all admins.
  perform pg_advisory_xact_lock(16092026);
  select * into target from public.users where id=p_uid for update;
  if not found then raise exception 'user not found'; end if;
  old_row:=to_jsonb(target);
  if public.is_admin() then actor_id:=auth.uid(); end if;
  if p_action='role' and (p_value is null or p_value not in ('true','false')) then raise exception 'invalid role value'; end if;
  if p_action='status' and (p_value is null or p_value not in ('active','suspended')) then raise exception 'invalid status'; end if;
  if p_action='role' and p_value='false' or p_action='archive' or p_action='status' and p_value<>'active' then
    if p_uid=actor_id then raise exception 'cannot remove your own access'; end if;
    if target.is_admin and not exists(select 1 from public.users where is_admin and status='active' and id<>p_uid) then raise exception 'cannot remove the last active administrator'; end if;
  end if;
  previous_token:=current_setting('app.admin_action_token',true);
  perform set_config('app.admin_action_token',coalesce(tok,''),true);
  if p_action='role' then update public.users set is_admin=(p_value='true') where id=p_uid;
  elsif p_action='status' then update public.users set status=p_value::public.user_status where id=p_uid;
  elsif p_action='archive' then update public.users set status='banned' where id=p_uid;
  elsif p_action='manual_verify' then
    insert into public.verifications(uid,full_name,email,status,verification_method,submitted_at,reviewed_by,reviewed_at)
      values(p_uid,target.display_name,target.email,'approved','admin_override',now(),actor_id,now())
      on conflict(uid) do update set status='approved',verification_method='admin_override',reviewed_by=actor_id,reviewed_at=now(),rejection_reason=null;
  end if;
  select * into target from public.users where id=p_uid;
  result:=jsonb_build_object('user',to_jsonb(target),'method',case when p_action='manual_verify' then 'admin_override' else null end);
  insert into public.audit_log(actor,action,entity,entity_id,before,after)
    values(actor_id,'admin_user_'||p_action,'users',p_uid::text,old_row,
      result || jsonb_build_object('value',p_value,'credential',case when actor_id is null then 'verified_admin_password' else 'admin_account' end));
  perform set_config('app.admin_action_token',coalesce(previous_token,''),true);
  return result;
end $$;
revoke all on function public.admin_manage_user(text,uuid,text,text) from public;
grant execute on function public.admin_manage_user(text,uuid,text,text) to anon,authenticated;
create or replace function public.admin_save_fund_limits(tok text,p_deposit numeric,p_withdrawal numeric)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare old_config jsonb; config jsonb; actor_id uuid;
begin
  if not public.is_admin() then perform public.admin_users(tok); else actor_id:=auth.uid(); end if;
  if p_deposit is null or p_withdrawal is null or p_deposit<0 or p_withdrawal<0
     or p_deposit::text in ('NaN','Infinity','-Infinity') or p_withdrawal::text in ('NaN','Infinity','-Infinity') then
    raise exception 'enter valid non-negative amounts';
  end if;
  perform pg_advisory_xact_lock(16092027);
  select value into old_config from public.app_settings where key='config' for update;
  config:=coalesce(old_config,'{}'::jsonb);
  if jsonb_typeof(config)='string' then config:=(config #>> '{}')::jsonb; end if;
  if jsonb_typeof(config)<>'object' then raise exception 'invalid existing config'; end if;
  config:=config || jsonb_build_object('minRechargeAmount',p_deposit,'minWithdrawAmount',p_withdrawal);
  insert into public.app_settings(key,value,updated_by) values('config',config,actor_id)
    on conflict(key) do update set value=excluded.value,updated_by=excluded.updated_by;
  insert into public.audit_log(actor,action,entity,entity_id,before,after)
    values(actor_id,'save_fund_limits','app_settings','config',old_config,config);
  return config;
end $$;
revoke all on function public.admin_save_fund_limits(text,numeric,numeric) from public;
grant execute on function public.admin_save_fund_limits(text,numeric,numeric) to anon,authenticated;
notify pgrst,'reload schema';
commit;
