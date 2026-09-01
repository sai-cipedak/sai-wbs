create or replace function public.hse_review_findings_atomic(
  p_case_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_decision text,
  p_review_notes text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case public.cases%rowtype;
  v_review_id uuid;
  v_active_count integer;
  v_missing_count integer;
  v_next_status text;
begin
  if p_decision not in ('APPROVED','RETURNED_FOR_REVISION') then raise exception 'INVALID_DECISION'; end if;
  if char_length(trim(coalesce(p_review_notes,'')))<5 or char_length(trim(coalesce(p_review_notes,'')))>5000 then raise exception 'REVIEW_NOTES_REQUIRED'; end if;

  select * into v_case from public.cases where id=p_case_id for update;
  if not found or v_case.organization_id<>p_organization_id or v_case.authority_code<>'HSE' then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.status<>'AUTHORITY_REVIEW' then raise exception 'CASE_CHANGED'; end if;
  if v_case.classification<>'SAFEGUARDING' then raise exception 'INVALID_CLASSIFICATION'; end if;

  select count(*) into v_active_count from public.case_allegations where case_id=p_case_id and status='ACTIVE';
  if v_active_count=0 then raise exception 'INCOMPLETE_FINDINGS'; end if;
  select count(*) into v_missing_count
  from public.case_allegations a
  where a.case_id=p_case_id and a.status='ACTIVE'
    and not exists(select 1 from public.case_findings f where f.case_id=p_case_id and f.allegation_id=a.id);
  if v_missing_count>0 then raise exception 'INCOMPLETE_FINDINGS'; end if;

  insert into public.case_authority_reviews(case_id,reviewer_user_id,decision,review_notes)
  values(p_case_id,p_actor_user_id,p_decision,trim(p_review_notes)) returning id into v_review_id;

  v_next_status:=case when p_decision='APPROVED' then 'REMEDIATION' else 'INVESTIGATION' end;
  update public.cases set status=v_next_status,updated_at=now() where id=p_case_id;

  insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
  values(p_organization_id,p_case_id,p_actor_user_id,
    case when p_decision='APPROVED' then 'FINDINGS_APPROVED' else 'FINDINGS_RETURNED_FOR_REVISION' end,
    'case_authority_review',v_review_id,jsonb_build_object('next_status',v_next_status,'authority_code','HSE'));

  return jsonb_build_object('ok',true,'status',v_next_status,'reviewId',v_review_id);
end;
$$;

create or replace function public.hse_add_remediation_action_atomic(
  p_case_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_action_text text,
  p_owner_text text default null,
  p_due_date date default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case public.cases%rowtype;
  v_id uuid;
  v_owner text;
begin
  if char_length(trim(coalesce(p_action_text,'')))<5 or char_length(trim(coalesce(p_action_text,'')))>5000 then raise exception 'ACTION_TEXT_REQUIRED'; end if;
  v_owner:=nullif(left(trim(coalesce(p_owner_text,'')),500),'');

  select * into v_case from public.cases where id=p_case_id for update;
  if not found or v_case.organization_id<>p_organization_id or v_case.authority_code<>'HSE' or v_case.classification<>'SAFEGUARDING' then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.status<>'REMEDIATION' then raise exception 'CASE_CHANGED'; end if;

  insert into public.case_remediation_actions(case_id,action_text,owner_text,due_date,status,created_by)
  values(p_case_id,trim(p_action_text),v_owner,p_due_date,'PENDING',p_actor_user_id) returning id into v_id;

  insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
  values(p_organization_id,p_case_id,p_actor_user_id,'REMEDIATION_ACTION_ADDED','case_remediation_action',v_id,jsonb_build_object('authority_code','HSE'));

  return jsonb_build_object('ok',true,'id',v_id,'remediationId',v_id);
end;
$$;

create or replace function public.hse_finish_remediation_action_atomic(
  p_case_id uuid,
  p_remediation_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_final_status text,
  p_completion_note text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case public.cases%rowtype;
  v_item public.case_remediation_actions%rowtype;
begin
  if p_final_status not in ('COMPLETED','WAIVED') then raise exception 'INVALID_FINAL_STATUS'; end if;
  if char_length(trim(coalesce(p_completion_note,'')))<5 or char_length(trim(coalesce(p_completion_note,'')))>5000 then raise exception 'COMPLETION_NOTE_REQUIRED'; end if;

  select * into v_case from public.cases where id=p_case_id for update;
  if not found or v_case.organization_id<>p_organization_id or v_case.authority_code<>'HSE' or v_case.classification<>'SAFEGUARDING' then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.status<>'REMEDIATION' then raise exception 'CASE_CHANGED'; end if;

  select * into v_item from public.case_remediation_actions where id=p_remediation_id and case_id=p_case_id for update;
  if not found then raise exception 'REMEDIATION_NOT_FOUND'; end if;
  if v_item.status in ('COMPLETED','WAIVED') then raise exception 'REMEDIATION_ALREADY_FINISHED'; end if;

  update public.case_remediation_actions
  set status=p_final_status,completion_note=trim(p_completion_note),completed_by=p_actor_user_id,completed_at=now(),updated_at=now()
  where id=p_remediation_id;

  insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
  values(p_organization_id,p_case_id,p_actor_user_id,
    case when p_final_status='COMPLETED' then 'REMEDIATION_ACTION_COMPLETED' else 'REMEDIATION_ACTION_WAIVED' end,
    'case_remediation_action',p_remediation_id,jsonb_build_object('authority_code','HSE'));

  return jsonb_build_object('ok',true,'status',p_final_status,'remediationId',p_remediation_id);
end;
$$;

revoke all on function public.hse_review_findings_atomic(uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.hse_add_remediation_action_atomic(uuid,uuid,uuid,text,text,date) from public,anon,authenticated;
revoke all on function public.hse_finish_remediation_action_atomic(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.hse_review_findings_atomic(uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.hse_add_remediation_action_atomic(uuid,uuid,uuid,text,text,date) to service_role;
grant execute on function public.hse_finish_remediation_action_atomic(uuid,uuid,uuid,uuid,text,text) to service_role;