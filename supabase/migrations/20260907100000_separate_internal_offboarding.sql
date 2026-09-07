-- Separate routine internal offboarding from the global portal account block.

create or replace function public.admin_revoke_all_internal_roles_atomic(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := now();
  v_roles text[];
  v_admin_count integer;
  v_revoked_count integer;
begin
  if not exists(
    select 1
    from public.profiles p
    join public.user_system_roles r
      on r.user_id = p.user_id
      and r.organization_id = p.organization_id
    where p.user_id = p_actor_user_id
      and p.organization_id = p_organization_id
      and p.is_active
      and r.role_code = 'SYSTEM_ADMIN'
      and r.active_from <= v_now
      and (r.active_until is null or r.active_until > v_now)
  ) then
    raise exception 'FORBIDDEN';
  end if;

  perform 1
  from public.profiles
  where user_id = p_user_id and organization_id = p_organization_id
  for update;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;

  select array_agg(role_code order by role_code)
  into v_roles
  from public.user_system_roles
  where user_id = p_user_id
    and organization_id = p_organization_id
    and active_from <= v_now
    and (active_until is null or active_until > v_now);

  if coalesce(array_length(v_roles, 1), 0) = 0 then
    return jsonb_build_object('ok', true, 'revokedCount', 0, 'revokedRoles', '[]'::jsonb);
  end if;

  if 'SYSTEM_ADMIN' = any(v_roles) then
    select count(distinct user_id)
    into v_admin_count
    from public.user_system_roles
    where organization_id = p_organization_id
      and role_code = 'SYSTEM_ADMIN'
      and active_from <= v_now
      and (active_until is null or active_until > v_now);
    if v_admin_count <= 1 then raise exception 'LAST_ADMIN'; end if;
  end if;

  update public.user_system_roles
  set active_until = v_now
  where user_id = p_user_id
    and organization_id = p_organization_id
    and active_from <= v_now
    and (active_until is null or active_until > v_now);
  get diagnostics v_revoked_count = row_count;

  insert into public.audit_logs(
    organization_id, actor_user_id, event_type, object_type, object_id, details
  ) values (
    p_organization_id,
    p_actor_user_id,
    'ALL_INTERNAL_ROLES_REVOKED',
    'profile',
    p_user_id,
    jsonb_build_object(
      'target_user_id', p_user_id,
      'revoked_roles', to_jsonb(v_roles),
      'revoked_count', v_revoked_count,
      'profile_remains_active', true,
      'reporter_eligibility_unchanged', true
    )
  );

  return jsonb_build_object(
    'ok', true,
    'revokedCount', v_revoked_count,
    'revokedRoles', to_jsonb(v_roles)
  );
end
$function$;

revoke all on function public.admin_revoke_all_internal_roles_atomic(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_revoke_all_internal_roles_atomic(uuid, uuid, uuid)
  to service_role;

-- Transition a former internal user into the normal reporter onboarding flow.
-- The existing onboarding function remains the single writer for reporter data.
create or replace function public.complete_reporter_onboarding_v2_atomic(
  p_user_id uuid,
  p_organization_id uuid,
  p_email text,
  p_display_name text,
  p_phone text,
  p_academic_year text,
  p_children jsonb,
  p_verification_status text,
  p_community_access_code_id uuid,
  p_consent_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := now();
begin
  if exists(
    select 1
    from public.user_system_roles
    where user_id = p_user_id
      and organization_id = p_organization_id
      and active_from <= v_now
      and (active_until is null or active_until > v_now)
  ) then
    raise exception 'INTERNAL_PROFILE';
  end if;

  -- INTERNAL was historically used as both a membership label and an access
  -- decision. Once no active role remains, onboarding reclassifies the user
  -- according to community-code/allowlist verification in the existing RPC.
  update public.profiles
  set member_type = 'OTS', updated_at = v_now
  where user_id = p_user_id
    and organization_id = p_organization_id
    and is_active
    and member_type = 'INTERNAL';

  return public.complete_reporter_onboarding_atomic(
    p_user_id,
    p_organization_id,
    p_email,
    p_display_name,
    p_phone,
    p_academic_year,
    p_children,
    p_verification_status,
    p_community_access_code_id,
    p_consent_version
  );
end
$function$;

-- Enforce internal bypass from active role rows, never from a stale profile
-- label. Temporary member_type normalization is transaction-local and restored.
create or replace function public.create_identified_submission_v3_atomic(
  p_organization_id uuid,
  p_policy_version_id bigint,
  p_user_id uuid,
  p_public_case_id text,
  p_submission_token uuid,
  p_intake jsonb,
  p_safety_fast_lane boolean,
  p_idempotency_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := now();
  v_profile public.profiles%rowtype;
  v_has_internal_role boolean;
  v_result jsonb;
  v_restore_member_type boolean := false;
begin
  select * into v_profile
  from public.profiles
  where user_id = p_user_id
  for update;

  if not found then raise exception 'PROFILE_REQUIRED'; end if;
  if v_profile.organization_id <> p_organization_id then raise exception 'PROFILE_ORG_MISMATCH'; end if;
  if not v_profile.is_active then raise exception 'PROFILE_INACTIVE'; end if;

  select exists(
    select 1
    from public.user_system_roles
    where user_id = p_user_id
      and organization_id = p_organization_id
      and active_from <= v_now
      and (active_until is null or active_until > v_now)
  ) into v_has_internal_role;

  if not v_has_internal_role and v_profile.member_type = 'INTERNAL' then
    raise exception 'PROFILE_REQUIRED';
  end if;

  if v_has_internal_role and v_profile.member_type <> 'INTERNAL' then
    update public.profiles set member_type = 'INTERNAL' where user_id = p_user_id;
    v_restore_member_type := true;
  end if;

  v_result := public.create_identified_submission_v2_atomic(
    p_organization_id,
    p_policy_version_id,
    p_user_id,
    p_public_case_id,
    p_submission_token,
    p_intake,
    p_safety_fast_lane,
    p_idempotency_enabled
  );

  if v_restore_member_type then
    update public.profiles set member_type = v_profile.member_type where user_id = p_user_id;
  end if;

  return v_result;
end
$function$;

revoke all on function public.complete_reporter_onboarding_v2_atomic(uuid, uuid, text, text, text, text, jsonb, text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.create_identified_submission_v3_atomic(uuid, bigint, uuid, text, uuid, jsonb, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.complete_reporter_onboarding_v2_atomic(uuid, uuid, text, text, text, text, jsonb, text, uuid, text)
  to service_role;
grant execute on function public.create_identified_submission_v3_atomic(uuid, bigint, uuid, text, uuid, jsonb, boolean, boolean)
  to service_role;
