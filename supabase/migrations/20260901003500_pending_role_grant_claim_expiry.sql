alter table public.pending_system_role_grants
  add column if not exists claim_until timestamptz;

update public.pending_system_role_grants
set claim_until = created_at + interval '7 days'
where claim_until is null;

alter table public.pending_system_role_grants
  alter column claim_until set default (now() + interval '7 days'),
  alter column claim_until set not null;

alter table public.pending_system_role_grants
  drop constraint if exists pending_role_grant_claim_window;

alter table public.pending_system_role_grants
  add constraint pending_role_grant_claim_window
  check (claim_until > created_at);

create index if not exists pending_system_role_grants_claim_idx
  on public.pending_system_role_grants(email, status, active_from, claim_until);

create or replace function public.expire_pending_system_role_grants(
  p_organization_id uuid default null,
  p_email text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  with expired as (
    update public.pending_system_role_grants
    set status = 'EXPIRED', updated_at = now()
    where status = 'PENDING'
      and claim_until <= now()
      and (p_organization_id is null or organization_id = p_organization_id)
      and (p_email is null or email = lower(trim(p_email)))
    returning id, organization_id, email, role_code, claim_until
  ), audited as (
    insert into public.audit_logs(
      organization_id, actor_user_id, event_type, object_type, object_id, details
    )
    select
      organization_id,
      null,
      'PENDING_SYSTEM_ROLE_GRANT_EXPIRED',
      'pending_system_role_grant',
      id,
      jsonb_build_object(
        'email', email,
        'role_code', role_code,
        'claim_until', claim_until
      )
    from expired
    returning 1
  )
  select count(*) into v_count from audited;

  return v_count;
end;
$$;

revoke all on function public.expire_pending_system_role_grants(uuid, text) from public;
revoke all on function public.expire_pending_system_role_grants(uuid, text) from anon;
revoke all on function public.expire_pending_system_role_grants(uuid, text) from authenticated;
grant execute on function public.expire_pending_system_role_grants(uuid, text) to service_role;

create or replace function public.claim_pending_system_role_grants(
  p_user_id uuid,
  p_email text,
  p_display_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(trim(p_email));
  v_org uuid;
  v_grant public.pending_system_role_grants%rowtype;
  v_role_id uuid;
  v_claimed integer := 0;
  v_roles jsonb;
begin
  if p_user_id is null or v_email = '' then raise exception 'INVALID_IDENTITY'; end if;

  perform public.expire_pending_system_role_grants(null, v_email);

  select organization_id into v_org
  from public.pending_system_role_grants
  where email=v_email and status='PENDING'
    and claim_until>now()
    and active_from<=now() and (active_until is null or active_until>now())
  order by created_at
  limit 1;

  if v_org is null then
    select organization_id into v_org from public.profiles where user_id=p_user_id;
    if v_org is null then
      return jsonb_build_object('ok',true,'claimedCount',0,'roles','[]'::jsonb);
    end if;
  end if;

  if exists(
    select 1 from public.pending_system_role_grants
    where email=v_email and status='PENDING'
      and claim_until>now()
      and active_from<=now() and (active_until is null or active_until>now())
      and organization_id<>v_org
  ) then raise exception 'MULTI_ORG_GRANTS_NOT_SUPPORTED'; end if;

  insert into public.profiles(user_id,organization_id,display_name,email,member_type,is_active,created_at,updated_at)
  values(p_user_id,v_org,nullif(trim(p_display_name),''),v_email,'INTERNAL',true,now(),now())
  on conflict (user_id) do update set
    display_name=coalesce(nullif(trim(excluded.display_name),''),public.profiles.display_name),
    email=excluded.email,
    member_type='INTERNAL',
    is_active=true,
    updated_at=now();

  if exists(select 1 from public.profiles where user_id=p_user_id and organization_id<>v_org) then
    raise exception 'PROFILE_ORG_MISMATCH';
  end if;

  for v_grant in
    select * from public.pending_system_role_grants
    where organization_id=v_org and email=v_email and status='PENDING'
      and claim_until>now()
      and active_from<=now() and (active_until is null or active_until>now())
    order by created_at
    for update
  loop
    insert into public.user_system_roles(user_id,organization_id,role_code,active_from,active_until,granted_by,created_at)
    values(p_user_id,v_org,v_grant.role_code,greatest(v_grant.active_from,now()),v_grant.active_until,v_grant.granted_by,now())
    on conflict (user_id,organization_id,role_code) do update set
      active_from=excluded.active_from,
      active_until=excluded.active_until,
      granted_by=excluded.granted_by;

    select id into v_role_id from public.user_system_roles
    where user_id=p_user_id and organization_id=v_org and role_code=v_grant.role_code;

    update public.pending_system_role_grants set
      status='CLAIMED',claimed_by=p_user_id,claimed_at=now(),updated_at=now()
    where id=v_grant.id;

    insert into public.audit_logs(organization_id,actor_user_id,event_type,object_type,object_id,details)
    values(v_org,p_user_id,'PENDING_SYSTEM_ROLE_GRANT_CLAIMED','user_system_role',v_role_id,
      jsonb_build_object('role_code',v_grant.role_code,'pending_grant_id',v_grant.id,'email',v_email));
    v_claimed := v_claimed + 1;
  end loop;

  select coalesce(jsonb_agg(role_code order by role_code),'[]'::jsonb) into v_roles
  from public.user_system_roles
  where user_id=p_user_id and organization_id=v_org and active_from<=now() and (active_until is null or active_until>now());

  return jsonb_build_object('ok',true,'claimedCount',v_claimed,'organizationId',v_org,'roles',v_roles);
end;
$$;
