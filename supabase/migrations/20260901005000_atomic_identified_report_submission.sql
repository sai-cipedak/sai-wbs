create or replace function public.create_identified_submission_atomic(
  p_organization_id uuid,
  p_policy_version_id bigint,
  p_user_id uuid,
  p_email text,
  p_display_name text,
  p_profile_member_type text,
  p_profile_is_active boolean,
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
as $$
declare
  v_existing_org uuid;
  v_case public.cases%rowtype;
  v_title text := trim(coalesce(p_intake->>'title',''));
  v_narrative text := trim(coalesce(p_intake->>'narrative',''));
  v_incident_date date := nullif(p_intake->>'incidentDate','')::date;
  v_incident_time text := nullif(trim(coalesce(p_intake->>'incidentTimeText','')), '');
  v_location text := nullif(trim(coalesce(p_intake->>'locationText','')), '');
  v_people text := nullif(trim(coalesce(p_intake->>'peopleInvolvedText','')), '');
  v_child_safety boolean := coalesce((p_intake->>'childSafetyRisk')::boolean, false);
  v_ongoing boolean := coalesce((p_intake->>'ongoingRisk')::boolean, false);
begin
  if p_user_id is null or p_organization_id is null or p_policy_version_id is null then
    raise exception 'INVALID_SUBMISSION_CONTEXT';
  end if;
  if trim(coalesce(p_email,'')) = '' then raise exception 'INVALID_EMAIL'; end if;
  if v_title = '' or v_narrative = '' then raise exception 'INVALID_INTAKE'; end if;
  if p_profile_member_type not in ('INTERNAL','OTS','STAFF') then raise exception 'INVALID_MEMBER_TYPE'; end if;

  select organization_id into v_existing_org
  from public.profiles
  where user_id = p_user_id;

  if v_existing_org is not null and v_existing_org <> p_organization_id then
    raise exception 'PROFILE_ORG_MISMATCH';
  end if;

  insert into public.profiles(
    user_id, organization_id, display_name, email, member_type, is_active, updated_at
  ) values (
    p_user_id,
    p_organization_id,
    nullif(trim(coalesce(p_display_name,'')),''),
    lower(trim(p_email)),
    p_profile_member_type,
    p_profile_is_active,
    now()
  )
  on conflict (user_id) do update set
    display_name = excluded.display_name,
    email = excluded.email,
    member_type = excluded.member_type,
    is_active = excluded.is_active,
    updated_at = now();

  insert into public.cases(
    organization_id,
    public_case_id,
    reporting_mode,
    status,
    classification,
    priority,
    authority_code,
    policy_version_id,
    created_by_user_id,
    submission_token,
    is_test_data
  ) values (
    p_organization_id,
    p_public_case_id,
    'IDENTIFIED',
    case when p_safety_fast_lane then 'REFERRED_SAFEGUARDING' else 'SUBMITTED' end,
    case when p_safety_fast_lane then 'SAFEGUARDING' else null end,
    case when p_safety_fast_lane then 'CRITICAL' else null end,
    case when p_safety_fast_lane then 'HSE' else 'TRIAGE' end,
    p_policy_version_id,
    p_user_id,
    p_submission_token,
    false
  ) returning * into v_case;

  insert into public.case_reports(
    case_id,
    title,
    narrative,
    incident_date,
    incident_time_text,
    location_text,
    child_safety_risk,
    ongoing_risk,
    people_involved_text
  ) values (
    v_case.id,
    v_title,
    v_narrative,
    v_incident_date,
    v_incident_time,
    v_location,
    v_child_safety,
    v_ongoing,
    v_people
  );

  insert into public.case_reporter_identities(
    case_id,
    user_id,
    reporter_name,
    reporter_email,
    visibility_status
  ) values (
    v_case.id,
    p_user_id,
    nullif(trim(coalesce(p_display_name,'')),''),
    lower(trim(p_email)),
    'HIDDEN'
  );

  insert into public.audit_logs(
    organization_id,
    case_id,
    actor_user_id,
    event_type,
    object_type,
    object_id,
    details
  ) values (
    p_organization_id,
    v_case.id,
    p_user_id,
    'CASE_SUBMITTED_IDENTIFIED',
    'case',
    v_case.id,
    jsonb_build_object(
      'safety_fast_lane', p_safety_fast_lane,
      'profile_member_type_preserved', p_profile_member_type = 'INTERNAL',
      'idempotency_enabled', p_idempotency_enabled,
      'transactional_submission', true
    )
  );

  return jsonb_build_object(
    'caseId', v_case.id,
    'publicCaseId', v_case.public_case_id,
    'submittedAt', v_case.submitted_at,
    'status', v_case.status
  );
end;
$$;

revoke all on function public.create_identified_submission_atomic(uuid,bigint,uuid,text,text,text,boolean,text,uuid,jsonb,boolean,boolean) from public;
revoke all on function public.create_identified_submission_atomic(uuid,bigint,uuid,text,text,text,boolean,text,uuid,jsonb,boolean,boolean) from anon;
revoke all on function public.create_identified_submission_atomic(uuid,bigint,uuid,text,text,text,boolean,text,uuid,jsonb,boolean,boolean) from authenticated;
grant execute on function public.create_identified_submission_atomic(uuid,bigint,uuid,text,text,text,boolean,text,uuid,jsonb,boolean,boolean) to service_role;
