-- Self-registration for identified reporters. Sensitive family/contact data is
-- kept outside public.profiles and remains service-side only.

begin;

create table public.reporter_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  phone text not null check (char_length(phone) between 8 and 32),
  onboarding_status text not null default 'COMPLETE'
    check (onboarding_status in ('COMPLETE')),
  verification_status text not null
    check (verification_status in ('COMMUNITY_CODE','LEGACY_ALLOWLIST','ADMIN_VERIFIED')),
  reporting_status text not null default 'ACTIVE'
    check (reporting_status in ('ACTIVE','SUSPENDED','EXPIRED')),
  academic_year text not null check (academic_year ~ '^[0-9]{4}/[0-9]{4}$'),
  eligibility_expires_at timestamptz not null,
  community_access_code_id uuid references public.community_access_codes(id) on delete set null,
  consent_version text not null,
  consent_at timestamptz not null,
  verified_at timestamptz not null default now(),
  verified_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.reporter_children (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.reporter_profiles(user_id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  child_name text not null check (char_length(child_name) between 2 and 160),
  class_or_cohort text not null check (char_length(class_or_cohort) between 1 and 100),
  academic_year text not null check (academic_year ~ '^[0-9]{4}/[0-9]{4}$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index reporter_profiles_org_status_idx
  on public.reporter_profiles(organization_id, reporting_status, eligibility_expires_at);
create index reporter_profiles_community_code_idx
  on public.reporter_profiles(community_access_code_id)
  where community_access_code_id is not null;
create index reporter_profiles_verified_by_idx
  on public.reporter_profiles(verified_by)
  where verified_by is not null;
create index reporter_children_user_active_idx
  on public.reporter_children(user_id, is_active);
create index reporter_children_org_idx
  on public.reporter_children(organization_id);

alter table public.reporter_profiles enable row level security;
alter table public.reporter_children enable row level security;

revoke all on public.reporter_profiles, public.reporter_children from public, anon, authenticated;
grant all on public.reporter_profiles, public.reporter_children to service_role;

alter table public.case_reporter_identities
  add column reporter_verification_status text
  check (reporter_verification_status is null or reporter_verification_status in (
    'COMMUNITY_CODE','LEGACY_ALLOWLIST','ADMIN_VERIFIED','INTERNAL_ROLE'
  ));

create or replace function public.complete_reporter_onboarding_atomic(
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
set search_path = public, auth, pg_temp
as $function$
declare
  v_now timestamptz := now();
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text := trim(coalesce(p_display_name, ''));
  v_phone text := trim(coalesce(p_phone, ''));
  v_existing_profile public.profiles%rowtype;
  v_existing_reporter public.reporter_profiles%rowtype;
  v_code public.community_access_codes%rowtype;
  v_allowlist public.reporter_allowlist%rowtype;
  v_start_year integer;
  v_end_year integer;
  v_expected_start_year integer;
  v_academic_expiry timestamptz;
  v_eligibility_expiry timestamptz;
  v_member_type text := 'OTS';
  v_child jsonb;
begin
  if p_user_id is null or p_organization_id is null then raise exception 'INVALID_CONTEXT'; end if;
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'INVALID_EMAIL'; end if;
  if char_length(v_name) not between 2 and 200 then raise exception 'INVALID_NAME'; end if;
  if char_length(v_phone) not between 8 and 32 or v_phone !~ '^[0-9+() .-]+$' then raise exception 'INVALID_PHONE'; end if;
  if p_academic_year !~ '^[0-9]{4}/[0-9]{4}$' then raise exception 'INVALID_ACADEMIC_YEAR'; end if;
  if jsonb_typeof(p_children) <> 'array' or jsonb_array_length(p_children) not between 1 and 10 then raise exception 'INVALID_CHILDREN'; end if;
  if char_length(trim(coalesce(p_consent_version, ''))) not between 1 and 80 then raise exception 'INVALID_CONSENT'; end if;
  if not exists(select 1 from public.organizations where id = p_organization_id and is_active) then raise exception 'ORG_NOT_FOUND'; end if;
  if not exists(select 1 from auth.users where id = p_user_id and lower(email) = v_email) then raise exception 'AUTH_USER_MISMATCH'; end if;

  v_start_year := split_part(p_academic_year, '/', 1)::integer;
  v_end_year := split_part(p_academic_year, '/', 2)::integer;
  v_expected_start_year := extract(year from v_now at time zone 'Asia/Jakarta')::integer
    - case when extract(month from v_now at time zone 'Asia/Jakarta')::integer < 7 then 1 else 0 end;
  if v_end_year <> v_start_year + 1 or v_start_year <> v_expected_start_year then raise exception 'INVALID_ACADEMIC_YEAR'; end if;
  v_academic_expiry := make_timestamptz(v_end_year, 7, 1, 0, 0, 0, 'Asia/Jakarta');

  select * into v_existing_profile from public.profiles where user_id = p_user_id for update;
  if found then
    if v_existing_profile.organization_id <> p_organization_id then raise exception 'PROFILE_ORG_MISMATCH'; end if;
    if not v_existing_profile.is_active then raise exception 'PROFILE_INACTIVE'; end if;
    if v_existing_profile.member_type = 'INTERNAL' then raise exception 'INTERNAL_PROFILE'; end if;
    v_member_type := v_existing_profile.member_type;
  end if;

  select * into v_existing_reporter from public.reporter_profiles where user_id = p_user_id for update;
  if found and v_existing_reporter.reporting_status = 'SUSPENDED' then raise exception 'REPORTER_SUSPENDED'; end if;

  if p_verification_status = 'COMMUNITY_CODE' then
    select * into v_code
    from public.community_access_codes
    where id = p_community_access_code_id
      and organization_id = p_organization_id
      and is_active
      and valid_from <= v_now
      and (valid_until is null or valid_until > v_now)
    for share;
    if not found then raise exception 'ACCESS_CODE_INACTIVE'; end if;
    v_member_type := 'OTS';
    v_eligibility_expiry := least(v_academic_expiry, coalesce(v_code.valid_until, v_academic_expiry));
  elsif p_verification_status = 'LEGACY_ALLOWLIST' then
    select * into v_allowlist
    from public.reporter_allowlist
    where organization_id = p_organization_id and lower(email) = v_email and is_active
    for share;
    if not found then raise exception 'ALLOWLIST_INACTIVE'; end if;
    v_member_type := v_allowlist.member_type;
    v_eligibility_expiry := v_academic_expiry;
    p_community_access_code_id := null;
  else
    raise exception 'INVALID_VERIFICATION';
  end if;
  if v_eligibility_expiry <= v_now then raise exception 'VERIFICATION_EXPIRED'; end if;

  for v_child in select value from jsonb_array_elements(p_children)
  loop
    if jsonb_typeof(v_child) <> 'object'
      or char_length(trim(coalesce(v_child->>'name', ''))) not between 2 and 160
      or char_length(trim(coalesce(v_child->>'classOrCohort', ''))) not between 1 and 100
    then raise exception 'INVALID_CHILDREN'; end if;
  end loop;

  insert into public.profiles(user_id, organization_id, display_name, email, member_type, is_active, created_at, updated_at)
  values(p_user_id, p_organization_id, v_name, v_email, v_member_type, true, v_now, v_now)
  on conflict(user_id) do update set
    display_name = excluded.display_name,
    email = excluded.email,
    member_type = case when public.profiles.member_type = 'INTERNAL' then 'INTERNAL' else excluded.member_type end,
    updated_at = v_now;

  insert into public.reporter_profiles(
    user_id, organization_id, phone, onboarding_status, verification_status, reporting_status,
    academic_year, eligibility_expires_at, community_access_code_id, consent_version,
    consent_at, verified_at, verified_by, created_at, updated_at
  ) values(
    p_user_id, p_organization_id, v_phone, 'COMPLETE', p_verification_status, 'ACTIVE',
    p_academic_year, v_eligibility_expiry, p_community_access_code_id, trim(p_consent_version),
    v_now, v_now, null, v_now, v_now
  )
  on conflict(user_id) do update set
    organization_id = excluded.organization_id,
    phone = excluded.phone,
    onboarding_status = 'COMPLETE',
    verification_status = excluded.verification_status,
    reporting_status = 'ACTIVE',
    academic_year = excluded.academic_year,
    eligibility_expires_at = excluded.eligibility_expires_at,
    community_access_code_id = excluded.community_access_code_id,
    consent_version = excluded.consent_version,
    consent_at = excluded.consent_at,
    verified_at = excluded.verified_at,
    verified_by = null,
    updated_at = v_now;

  delete from public.reporter_children where user_id = p_user_id;
  insert into public.reporter_children(user_id, organization_id, child_name, class_or_cohort, academic_year)
  select p_user_id, p_organization_id, trim(value->>'name'), trim(value->>'classOrCohort'), p_academic_year
  from jsonb_array_elements(p_children);

  insert into public.audit_logs(organization_id, actor_user_id, event_type, object_type, object_id, details)
  values(p_organization_id, p_user_id, 'REPORTER_PROFILE_VERIFIED', 'reporter_profile', p_user_id,
    jsonb_build_object('verification_status', p_verification_status, 'academic_year', p_academic_year,
      'children_count', jsonb_array_length(p_children), 'eligibility_expires_at', v_eligibility_expiry));

  return jsonb_build_object('ok', true, 'reportingStatus', 'ACTIVE',
    'verificationStatus', p_verification_status, 'eligibilityExpiresAt', v_eligibility_expiry);
end
$function$;

create or replace function public.update_reporter_profile_atomic(
  p_user_id uuid,
  p_organization_id uuid,
  p_email text,
  p_display_name text,
  p_phone text,
  p_children jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $function$
declare
  v_now timestamptz := now();
  v_email text := lower(trim(coalesce(p_email, '')));
  v_name text := trim(coalesce(p_display_name, ''));
  v_phone text := trim(coalesce(p_phone, ''));
  v_profile public.profiles%rowtype;
  v_reporter public.reporter_profiles%rowtype;
  v_child jsonb;
begin
  if char_length(v_name) not between 2 and 200 then raise exception 'INVALID_NAME'; end if;
  if char_length(v_phone) not between 8 and 32 or v_phone !~ '^[0-9+() .-]+$' then raise exception 'INVALID_PHONE'; end if;
  if jsonb_typeof(p_children) <> 'array' or jsonb_array_length(p_children) not between 1 and 10 then raise exception 'INVALID_CHILDREN'; end if;
  if not exists(select 1 from auth.users where id = p_user_id and lower(email) = v_email) then raise exception 'AUTH_USER_MISMATCH'; end if;
  select * into v_profile from public.profiles where user_id = p_user_id and organization_id = p_organization_id for update;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  if not v_profile.is_active then raise exception 'PROFILE_INACTIVE'; end if;
  select * into v_reporter from public.reporter_profiles where user_id = p_user_id and organization_id = p_organization_id for update;
  if not found then raise exception 'REPORTER_PROFILE_NOT_FOUND'; end if;
  for v_child in select value from jsonb_array_elements(p_children)
  loop
    if jsonb_typeof(v_child) <> 'object'
      or char_length(trim(coalesce(v_child->>'name', ''))) not between 2 and 160
      or char_length(trim(coalesce(v_child->>'classOrCohort', ''))) not between 1 and 100
    then raise exception 'INVALID_CHILDREN'; end if;
  end loop;
  update public.profiles set display_name = v_name, email = v_email, updated_at = v_now where user_id = p_user_id;
  update public.reporter_profiles set phone = v_phone, updated_at = v_now where user_id = p_user_id;
  delete from public.reporter_children where user_id = p_user_id;
  insert into public.reporter_children(user_id, organization_id, child_name, class_or_cohort, academic_year)
  select p_user_id, p_organization_id, trim(value->>'name'), trim(value->>'classOrCohort'), v_reporter.academic_year
  from jsonb_array_elements(p_children);
  insert into public.audit_logs(organization_id, actor_user_id, event_type, object_type, object_id, details)
  values(p_organization_id, p_user_id, 'REPORTER_PROFILE_UPDATED', 'reporter_profile', p_user_id,
    jsonb_build_object('children_count', jsonb_array_length(p_children)));
  return jsonb_build_object('ok', true);
end
$function$;

create or replace function public.admin_set_reporter_status_atomic(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_user_id uuid,
  p_reporting_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_now timestamptz := now();
  v_reporter public.reporter_profiles%rowtype;
begin
  if p_reporting_status not in ('ACTIVE','SUSPENDED') then raise exception 'INVALID_REPORTER_STATUS'; end if;
  if not exists(
    select 1 from public.profiles p
    join public.user_system_roles r on r.user_id = p.user_id and r.organization_id = p.organization_id
    where p.user_id = p_actor_user_id and p.organization_id = p_organization_id and p.is_active
      and r.role_code = 'SYSTEM_ADMIN' and r.active_from <= v_now
      and (r.active_until is null or r.active_until > v_now)
  ) then raise exception 'FORBIDDEN'; end if;
  select * into v_reporter from public.reporter_profiles
  where user_id = p_user_id and organization_id = p_organization_id for update;
  if not found then raise exception 'REPORTER_PROFILE_NOT_FOUND'; end if;
  if p_reporting_status = 'ACTIVE' and v_reporter.eligibility_expires_at <= v_now then raise exception 'REPORTER_EXPIRED'; end if;
  update public.reporter_profiles set reporting_status = p_reporting_status, updated_at = v_now
  where user_id = p_user_id and organization_id = p_organization_id;
  insert into public.audit_logs(organization_id, actor_user_id, event_type, object_type, object_id, details)
  values(p_organization_id, p_actor_user_id,
    case when p_reporting_status = 'SUSPENDED' then 'REPORTER_SUSPENDED' else 'REPORTER_REACTIVATED' end,
    'reporter_profile', p_user_id, jsonb_build_object('target_user_id', p_user_id));
  return jsonb_build_object('ok', true, 'reportingStatus', p_reporting_status);
end
$function$;

create or replace function public.create_identified_submission_v2_atomic(
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
set search_path = public, auth, pg_temp
as $function$
declare
  v_now timestamptz := now();
  v_profile public.profiles%rowtype;
  v_reporter public.reporter_profiles%rowtype;
  v_case public.cases%rowtype;
  v_title text := trim(coalesce(p_intake->>'title',''));
  v_narrative text := trim(coalesce(p_intake->>'narrative',''));
  v_incident_date date := nullif(p_intake->>'incidentDate','')::date;
  v_incident_time text := nullif(trim(coalesce(p_intake->>'incidentTimeText','')), '');
  v_location text := nullif(trim(coalesce(p_intake->>'locationText','')), '');
  v_people text := nullif(trim(coalesce(p_intake->>'peopleInvolvedText','')), '');
  v_child_safety boolean := coalesce((p_intake->>'childSafetyRisk')::boolean, false);
  v_ongoing boolean := coalesce((p_intake->>'ongoingRisk')::boolean, false);
  v_verification text;
  v_phone text;
begin
  if p_user_id is null or p_organization_id is null or p_policy_version_id is null then raise exception 'INVALID_SUBMISSION_CONTEXT'; end if;
  if v_title = '' or v_narrative = '' then raise exception 'INVALID_INTAKE'; end if;
  select * into v_profile from public.profiles where user_id = p_user_id for update;
  if not found then raise exception 'PROFILE_REQUIRED'; end if;
  if v_profile.organization_id <> p_organization_id then raise exception 'PROFILE_ORG_MISMATCH'; end if;
  if not v_profile.is_active then raise exception 'PROFILE_INACTIVE'; end if;
  if v_profile.member_type = 'INTERNAL' then
    v_verification := 'INTERNAL_ROLE';
  else
    select * into v_reporter from public.reporter_profiles
    where user_id = p_user_id and organization_id = p_organization_id for update;
    if not found or v_reporter.onboarding_status <> 'COMPLETE' then raise exception 'PROFILE_REQUIRED'; end if;
    if v_reporter.reporting_status = 'SUSPENDED' then raise exception 'REPORTER_SUSPENDED'; end if;
    if v_reporter.reporting_status = 'EXPIRED' or v_reporter.eligibility_expires_at <= v_now then raise exception 'REPORTER_EXPIRED'; end if;
    if v_reporter.reporting_status <> 'ACTIVE' then raise exception 'REPORTER_NOT_ACTIVE'; end if;
    v_verification := v_reporter.verification_status;
    v_phone := v_reporter.phone;
  end if;

  insert into public.cases(
    organization_id, public_case_id, reporting_mode, status, classification, priority,
    authority_code, policy_version_id, created_by_user_id, submission_token, is_test_data
  ) values (
    p_organization_id, p_public_case_id, 'IDENTIFIED',
    case when p_safety_fast_lane then 'REFERRED_SAFEGUARDING' else 'SUBMITTED' end,
    case when p_safety_fast_lane then 'SAFEGUARDING' else null end,
    case when p_safety_fast_lane then 'CRITICAL' else null end,
    case when p_safety_fast_lane then 'HSE' else 'TRIAGE' end,
    p_policy_version_id, p_user_id, p_submission_token, false
  ) returning * into v_case;

  insert into public.case_reports(
    case_id, title, narrative, incident_date, incident_time_text, location_text,
    child_safety_risk, ongoing_risk, people_involved_text
  ) values (
    v_case.id, v_title, v_narrative, v_incident_date, v_incident_time, v_location,
    v_child_safety, v_ongoing, v_people
  );

  insert into public.case_reporter_identities(
    case_id, user_id, reporter_name, reporter_email, reporter_phone,
    reporter_verification_status, visibility_status
  ) values (
    v_case.id, p_user_id, v_profile.display_name, lower(v_profile.email), v_phone,
    v_verification, 'HIDDEN'
  );

  insert into public.audit_logs(organization_id, case_id, actor_user_id, event_type, object_type, object_id, details)
  values(p_organization_id, v_case.id, p_user_id, 'CASE_SUBMITTED_IDENTIFIED', 'case', v_case.id,
    jsonb_build_object('safety_fast_lane', p_safety_fast_lane, 'reporter_verification', v_verification,
      'idempotency_enabled', p_idempotency_enabled, 'transactional_submission', true));

  return jsonb_build_object('caseId', v_case.id, 'publicCaseId', v_case.public_case_id,
    'submittedAt', v_case.submitted_at, 'status', v_case.status);
end
$function$;

revoke all on function public.complete_reporter_onboarding_atomic(uuid,uuid,text,text,text,text,jsonb,text,uuid,text) from public, anon, authenticated;
revoke all on function public.update_reporter_profile_atomic(uuid,uuid,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.admin_set_reporter_status_atomic(uuid,uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.create_identified_submission_v2_atomic(uuid,bigint,uuid,text,uuid,jsonb,boolean,boolean) from public, anon, authenticated;
grant execute on function public.complete_reporter_onboarding_atomic(uuid,uuid,text,text,text,text,jsonb,text,uuid,text) to service_role;
grant execute on function public.update_reporter_profile_atomic(uuid,uuid,text,text,text,jsonb) to service_role;
grant execute on function public.admin_set_reporter_status_atomic(uuid,uuid,uuid,text) to service_role;
grant execute on function public.create_identified_submission_v2_atomic(uuid,bigint,uuid,text,uuid,jsonb,boolean,boolean) to service_role;

commit;
