create or replace function public.revoke_case_team_member_atomic(
  p_case_id uuid,
  p_member_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case public.cases%rowtype;
  v_member public.case_team_members%rowtype;
  v_now timestamptz:=now();
  v_assignment_count integer:=0;
begin
  select * into v_case from public.cases where id=p_case_id for update;
  if not found or v_case.organization_id<>p_organization_id then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.authority_code<>'SECRETARIAT' or v_case.status<>'COMMITTEE_FORMATION' then raise exception 'TEAM_FORMATION_NOT_ACTIVE'; end if;

  select * into v_member from public.case_team_members where id=p_member_id and case_id=p_case_id for update;
  if not found then raise exception 'TEAM_MEMBER_NOT_FOUND'; end if;
  if v_member.nomination_status='REVOKED' then raise exception 'TEAM_MEMBER_ALREADY_REVOKED'; end if;

  update public.case_team_members
  set nomination_status='REVOKED',revoked_at=v_now,updated_at=v_now
  where id=v_member.id;

  if v_member.linked_user_id is not null then
    update public.case_assignments
    set access_status='REVOKED',revoked_at=v_now
    where case_id=p_case_id
      and user_id=v_member.linked_user_id
      and assignment_role=v_member.committee_role
      and access_status<>'REVOKED';
    get diagnostics v_assignment_count = row_count;
  end if;

  insert into public.audit_logs(
    organization_id,case_id,actor_user_id,event_type,object_type,object_id,details
  ) values (
    p_organization_id,p_case_id,p_actor_user_id,'TEAM_MEMBER_REVOKED','case_team_member',v_member.id,
    jsonb_build_object('committee_role',v_member.committee_role,'assignment_rows_revoked',v_assignment_count)
  );

  return jsonb_build_object('ok',true,'memberId',v_member.id,'assignmentRowsRevoked',v_assignment_count);
end;
$$;

create or replace function public.hse_revoke_case_team_member_atomic(
  p_case_id uuid,
  p_member_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case public.cases%rowtype;
  v_member public.case_team_members%rowtype;
  v_now timestamptz := now();
  v_assignment_count integer := 0;
begin
  select * into v_case from public.cases where id=p_case_id for update;
  if not found or v_case.organization_id<>p_organization_id then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.authority_code<>'HSE' or v_case.status<>'COMMITTEE_FORMATION' or v_case.classification<>'SAFEGUARDING' then raise exception 'TEAM_FORMATION_NOT_ACTIVE'; end if;

  select * into v_member from public.case_team_members where id=p_member_id and case_id=p_case_id for update;
  if not found then raise exception 'TEAM_MEMBER_NOT_FOUND'; end if;
  if v_member.nomination_status='REVOKED' then raise exception 'TEAM_MEMBER_ALREADY_REVOKED'; end if;

  update public.case_team_members
  set nomination_status='REVOKED',revoked_at=v_now,updated_at=v_now
  where id=v_member.id;

  if v_member.linked_user_id is not null then
    update public.case_assignments
    set access_status='REVOKED',revoked_at=v_now
    where case_id=p_case_id
      and user_id=v_member.linked_user_id
      and assignment_role=v_member.committee_role
      and access_status<>'REVOKED';
    get diagnostics v_assignment_count = row_count;
  end if;

  insert into public.audit_logs(
    organization_id,case_id,actor_user_id,event_type,object_type,object_id,details
  ) values (
    p_organization_id,p_case_id,p_actor_user_id,'TEAM_MEMBER_REVOKED','case_team_member',v_member.id,
    jsonb_build_object('committee_role',v_member.committee_role,'assignment_rows_revoked',v_assignment_count,'authority_code','HSE')
  );

  return jsonb_build_object('ok',true,'memberId',v_member.id,'assignmentRowsRevoked',v_assignment_count);
end;
$$;

revoke all on function public.revoke_case_team_member_atomic(uuid,uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.hse_revoke_case_team_member_atomic(uuid,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.revoke_case_team_member_atomic(uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.hse_revoke_case_team_member_atomic(uuid,uuid,uuid,uuid) to service_role;