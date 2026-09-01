create or replace function public.prepare_team_member_nominations_atomic(
  p_user_id uuid,
  p_email text,
  p_display_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_organization_id uuid;
  v_linked_count integer := 0;
begin
  if v_email = '' then raise exception 'INVALID_EMAIL'; end if;

  select c.organization_id into v_organization_id
  from public.case_team_members m
  join public.cases c on c.id = m.case_id
  where lower(m.email) = v_email
    and m.nomination_status <> 'REVOKED'
  order by m.nominated_at desc
  limit 1;

  if v_organization_id is null then
    return jsonb_build_object('ok', true, 'linkedCount', 0);
  end if;

  insert into public.profiles(user_id, organization_id, display_name, email, member_type, is_active)
  values(p_user_id, v_organization_id, left(coalesce(nullif(trim(p_display_name), ''), v_email), 200), v_email, 'INTERNAL', true)
  on conflict (user_id) do nothing;

  update public.case_team_members
  set linked_user_id = p_user_id,
      nomination_status = 'PENDING_DECLARATION',
      updated_at = now()
  where lower(email) = v_email
    and nomination_status = 'PENDING_ACCOUNT'
    and declaration_at is null
    and (linked_user_id is null or linked_user_id = p_user_id);
  get diagnostics v_linked_count = row_count;

  return jsonb_build_object('ok', true, 'linkedCount', v_linked_count);
end
$function$;

revoke all on function public.prepare_team_member_nominations_atomic(uuid, text, text) from public, anon, authenticated;
grant execute on function public.prepare_team_member_nominations_atomic(uuid, text, text) to service_role;

create or replace function public.declare_team_member_conflict_atomic(
  p_member_id uuid,
  p_user_id uuid,
  p_email text,
  p_declaration text,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_member public.case_team_members%rowtype;
  v_case public.cases%rowtype;
  v_now timestamptz := now();
  v_status text;
begin
  if p_declaration not in ('NO_CONFLICT', 'POSSIBLE_CONFLICT') then
    raise exception 'INVALID_DECLARATION';
  end if;

  select * into v_member
  from public.case_team_members
  where id = p_member_id
    and lower(email) = lower(trim(coalesce(p_email, '')))
    and nomination_status <> 'REVOKED'
  for update;
  if not found then raise exception 'TEAM_MEMBER_NOT_FOUND'; end if;
  if v_member.nomination_status in ('CLEARED', 'CONFLICT') then raise exception 'DECLARATION_ALREADY_SUBMITTED'; end if;

  select * into v_case from public.cases where id = v_member.case_id for update;
  if not found then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.status <> 'COMMITTEE_FORMATION' then raise exception 'TEAM_FORMATION_CLOSED'; end if;

  insert into public.case_conflict_declarations(case_id, user_id, declaration, notes, declared_at)
  values(v_member.case_id, p_user_id, p_declaration, nullif(left(trim(coalesce(p_notes, '')), 2000), ''), v_now)
  on conflict(case_id, user_id) do update
    set declaration = excluded.declaration,
        notes = excluded.notes,
        declared_at = excluded.declared_at;

  if p_declaration = 'POSSIBLE_CONFLICT' then
    v_status := 'CONFLICT';
    update public.case_team_members
    set linked_user_id = p_user_id, nomination_status = v_status, declaration_at = v_now, updated_at = v_now
    where id = p_member_id;

    update public.case_assignments
    set access_status = 'REVOKED', revoked_at = v_now
    where case_id = v_member.case_id
      and user_id = p_user_id
      and assignment_role = v_member.committee_role
      and access_status <> 'REVOKED';
  else
    v_status := 'CLEARED';
    update public.case_team_members
    set linked_user_id = p_user_id, nomination_status = v_status, declaration_at = v_now, updated_at = v_now
    where id = p_member_id;

    insert into public.case_assignments(case_id, user_id, assignment_role, access_status, assigned_by, assigned_at, revoked_at)
    values(v_member.case_id, p_user_id, v_member.committee_role, 'PENDING', v_member.nominated_by, v_now, null)
    on conflict(case_id, user_id, assignment_role) do update
      set access_status = 'PENDING',
          assigned_by = excluded.assigned_by,
          assigned_at = excluded.assigned_at,
          revoked_at = null;
  end if;

  insert into public.audit_logs(organization_id, case_id, actor_user_id, event_type, object_type, object_id, details)
  values(
    v_case.organization_id,
    v_member.case_id,
    p_user_id,
    case when p_declaration = 'POSSIBLE_CONFLICT' then 'TEAM_MEMBER_CONFLICT_DECLARED' else 'TEAM_MEMBER_CONFLICT_CLEARED' end,
    'case_team_member',
    p_member_id,
    jsonb_build_object('committee_role', v_member.committee_role, 'authority_code', v_case.authority_code)
  );

  return jsonb_build_object(
    'ok', true,
    'nomorLaporan', v_case.public_case_id,
    'nominationStatus', v_status,
    'accessGranted', false
  );
end
$function$;

revoke all on function public.declare_team_member_conflict_atomic(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.declare_team_member_conflict_atomic(uuid, uuid, text, text, text) to service_role;

