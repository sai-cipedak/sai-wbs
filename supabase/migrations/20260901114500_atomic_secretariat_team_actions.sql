create or replace function public.add_case_team_member_atomic(
  p_case_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_email text,
  p_display_name text,
  p_member_category text,
  p_committee_role text,
  p_rationale text,
  p_conflict_context text
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_case public.cases%rowtype;
  v_member public.case_team_members%rowtype;
  v_email text:=lower(trim(coalesce(p_email,'')));
  v_name text:=nullif(trim(coalesce(p_display_name,'')),'');
  v_rationale text:=trim(coalesce(p_rationale,''));
  v_context text:=trim(coalesce(p_conflict_context,''));
begin
  select * into v_case from public.cases where id=p_case_id for update;
  if not found or v_case.organization_id<>p_organization_id then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.authority_code<>'SECRETARIAT' or v_case.status<>'COMMITTEE_FORMATION' then raise exception 'TEAM_FORMATION_NOT_ACTIVE'; end if;
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'INVALID_EMAIL'; end if;
  if p_member_category not in ('DS','MANAGEMENT','STAFF','OTS','EXTERNAL') then raise exception 'INVALID_MEMBER_CATEGORY'; end if;
  if p_committee_role not in ('CASE_LEAD','INVESTIGATOR','SUBJECT_MATTER_ADVISER') then raise exception 'INVALID_COMMITTEE_ROLE'; end if;
  if char_length(v_rationale)<5 or char_length(v_context)<3 then raise exception 'INVALID_MEMBER_DATA'; end if;

  insert into public.case_team_members(
    case_id,email,display_name,member_category,committee_role,rationale,conflict_context,
    nomination_status,nominated_by
  ) values (
    p_case_id,v_email,left(v_name,200),p_member_category,p_committee_role,v_rationale,v_context,
    'PENDING_ACCOUNT',p_actor_user_id
  ) returning * into v_member;

  insert into public.audit_logs(
    organization_id,case_id,actor_user_id,event_type,object_type,object_id,details
  ) values (
    p_organization_id,p_case_id,p_actor_user_id,'TEAM_MEMBER_NOMINATED','case_team_member',v_member.id,
    jsonb_build_object('committee_role',v_member.committee_role,'member_category',v_member.member_category,'nomination_status',v_member.nomination_status)
  );

  return jsonb_build_object('ok',true,'memberId',v_member.id,'nominationStatus',v_member.nomination_status,'linkedUserId',v_member.linked_user_id);
end;$$;

create or replace function public.revoke_case_team_member_atomic(
  p_case_id uuid,
  p_member_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
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
    where case_id=p_case_id and user_id=v_member.linked_user_id and access_status<>'REVOKED';
    get diagnostics v_assignment_count = row_count;
  end if;

  insert into public.audit_logs(
    organization_id,case_id,actor_user_id,event_type,object_type,object_id,details
  ) values (
    p_organization_id,p_case_id,p_actor_user_id,'TEAM_MEMBER_REVOKED','case_team_member',v_member.id,
    jsonb_build_object('committee_role',v_member.committee_role,'assignment_rows_revoked',v_assignment_count)
  );

  return jsonb_build_object('ok',true,'memberId',v_member.id,'assignmentRowsRevoked',v_assignment_count);
end;$$;

create or replace function public.activate_case_team_atomic(
  p_case_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare
  v_case public.cases%rowtype;
  v_user_count integer;
  v_missing_assignments integer;
  v_has_lead boolean;
  v_now timestamptz:=now();
begin
  select * into v_case from public.cases where id=p_case_id for update;
  if not found or v_case.organization_id<>p_organization_id then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.authority_code<>'SECRETARIAT' or v_case.status<>'COMMITTEE_FORMATION' then raise exception 'TEAM_FORMATION_NOT_ACTIVE'; end if;

  select count(distinct linked_user_id),bool_or(committee_role='CASE_LEAD')
  into v_user_count,v_has_lead
  from public.case_team_members
  where case_id=p_case_id
    and nomination_status='CLEARED'
    and linked_user_id is not null
    and committee_role in ('CASE_LEAD','INVESTIGATOR');

  if coalesce(v_user_count,0)<2 then raise exception 'MINIMUM_TEAM_NOT_MET'; end if;
  if not coalesce(v_has_lead,false) then raise exception 'CASE_LEAD_REQUIRED'; end if;

  select count(*) into v_missing_assignments
  from public.case_team_members m
  where m.case_id=p_case_id
    and m.nomination_status='CLEARED'
    and m.linked_user_id is not null
    and m.committee_role in ('CASE_LEAD','INVESTIGATOR')
    and not exists (
      select 1 from public.case_assignments a
      where a.case_id=m.case_id
        and a.user_id=m.linked_user_id
        and a.assignment_role=m.committee_role
        and a.access_status<>'REVOKED'
    );
  if v_missing_assignments>0 then raise exception 'TEAM_ASSIGNMENT_MISSING'; end if;

  update public.case_assignments a
  set access_status='ACTIVE',revoked_at=null
  where a.case_id=p_case_id
    and a.access_status<>'REVOKED'
    and exists (
      select 1 from public.case_team_members m
      where m.case_id=a.case_id
        and m.linked_user_id=a.user_id
        and m.nomination_status='CLEARED'
        and m.committee_role=a.assignment_role
        and m.committee_role in ('CASE_LEAD','INVESTIGATOR')
    );

  update public.cases set status='INVESTIGATION',updated_at=v_now where id=p_case_id;
  return jsonb_build_object('ok',true,'investigatorCount',v_user_count);
end;$$;

revoke all on function public.add_case_team_member_atomic(uuid,uuid,uuid,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.revoke_case_team_member_atomic(uuid,uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.activate_case_team_atomic(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.add_case_team_member_atomic(uuid,uuid,uuid,text,text,text,text,text,text) to service_role;
grant execute on function public.revoke_case_team_member_atomic(uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.activate_case_team_atomic(uuid,uuid,uuid) to service_role;
