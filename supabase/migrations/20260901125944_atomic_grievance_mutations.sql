create or replace function public.grievance_start_resolution_atomic(
  p_case_id uuid,p_actor_user_id uuid,p_organization_id uuid,p_assessment_summary text,p_resolution_scope text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_case public.cases%rowtype; v_review_id uuid; v_now timestamptz:=now();
begin
  if char_length(trim(coalesce(p_assessment_summary,'')))<10 or char_length(trim(coalesce(p_assessment_summary,'')))>5000 then raise exception 'ASSESSMENT_REQUIRED'; end if;
  if char_length(trim(coalesce(p_resolution_scope,'')))<5 or char_length(trim(coalesce(p_resolution_scope,'')))>1000 then raise exception 'SCOPE_REQUIRED'; end if;
  select * into v_case from public.cases where id=p_case_id for update;
  if not found or v_case.organization_id<>p_organization_id or v_case.authority_code<>'GRIEVANCE' or v_case.classification<>'GRIEVANCE' then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.status<>'REFERRED_GRIEVANCE' then raise exception 'CASE_CHANGED'; end if;
  insert into public.case_grievance_reviews(case_id,coordinator_user_id,assessment_summary,resolution_scope,updated_at)
  values(p_case_id,p_actor_user_id,trim(p_assessment_summary),trim(p_resolution_scope),v_now)
  on conflict(case_id) do update set coordinator_user_id=excluded.coordinator_user_id,assessment_summary=excluded.assessment_summary,resolution_scope=excluded.resolution_scope,updated_at=v_now
  returning id into v_review_id;
  update public.cases set status='REMEDIATION',updated_at=v_now where id=p_case_id;
  insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
  values(p_organization_id,p_case_id,p_actor_user_id,'GRIEVANCE_RESOLUTION_STARTED','case_grievance_review',v_review_id,jsonb_build_object('resolution_scope',trim(p_resolution_scope),'authority_code','GRIEVANCE'));
  return jsonb_build_object('ok',true,'status','REMEDIATION','reviewId',v_review_id);
end;$$;

create or replace function public.grievance_send_message_atomic(
  p_case_id uuid,p_actor_user_id uuid,p_organization_id uuid,p_message text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_case public.cases%rowtype; v_message_id uuid;
begin
  if char_length(trim(coalesce(p_message,'')))<5 or char_length(trim(coalesce(p_message,'')))>5000 then raise exception 'MESSAGE_REQUIRED'; end if;
  select * into v_case from public.cases where id=p_case_id for update;
  if not found or v_case.organization_id<>p_organization_id or v_case.authority_code<>'GRIEVANCE' or v_case.classification<>'GRIEVANCE' then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.status not in ('REFERRED_GRIEVANCE','REMEDIATION') then raise exception 'CASE_CHANGED'; end if;
  insert into public.case_messages(case_id,sender_type,sender_user_id,body,visible_to_reporter)
  values(p_case_id,'INTERNAL',p_actor_user_id,trim(p_message),true) returning id into v_message_id;
  insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
  values(p_organization_id,p_case_id,p_actor_user_id,'GRIEVANCE_REPORTER_MESSAGE_SENT','case_message',v_message_id,jsonb_build_object('authority_code','GRIEVANCE'));
  return jsonb_build_object('ok',true,'messageId',v_message_id);
end;$$;

create or replace function public.grievance_add_action_atomic(
  p_case_id uuid,p_actor_user_id uuid,p_organization_id uuid,p_action_text text,p_owner_text text default null,p_due_date date default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_case public.cases%rowtype; v_id uuid; v_owner text;
begin
  if char_length(trim(coalesce(p_action_text,'')))<5 or char_length(trim(coalesce(p_action_text,'')))>5000 then raise exception 'ACTION_TEXT_REQUIRED'; end if;
  v_owner:=nullif(left(trim(coalesce(p_owner_text,'')),500),'');
  select * into v_case from public.cases where id=p_case_id for update;
  if not found or v_case.organization_id<>p_organization_id or v_case.authority_code<>'GRIEVANCE' or v_case.classification<>'GRIEVANCE' then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.status<>'REMEDIATION' then raise exception 'CASE_CHANGED'; end if;
  insert into public.case_remediation_actions(case_id,action_text,owner_text,due_date,status,created_by)
  values(p_case_id,trim(p_action_text),v_owner,p_due_date,'PENDING',p_actor_user_id) returning id into v_id;
  insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
  values(p_organization_id,p_case_id,p_actor_user_id,'GRIEVANCE_ACTION_ADDED','case_remediation_action',v_id,jsonb_build_object('authority_code','GRIEVANCE'));
  return jsonb_build_object('ok',true,'id',v_id,'actionId',v_id);
end;$$;

create or replace function public.grievance_finish_action_atomic(
  p_case_id uuid,p_action_id uuid,p_actor_user_id uuid,p_organization_id uuid,p_final_status text,p_completion_note text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_case public.cases%rowtype; v_item public.case_remediation_actions%rowtype;
begin
  if p_final_status not in ('COMPLETED','WAIVED') then raise exception 'INVALID_FINAL_STATUS'; end if;
  if char_length(trim(coalesce(p_completion_note,'')))<5 or char_length(trim(coalesce(p_completion_note,'')))>5000 then raise exception 'COMPLETION_NOTE_REQUIRED'; end if;
  select * into v_case from public.cases where id=p_case_id for update;
  if not found or v_case.organization_id<>p_organization_id or v_case.authority_code<>'GRIEVANCE' or v_case.classification<>'GRIEVANCE' then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.status<>'REMEDIATION' then raise exception 'CASE_CHANGED'; end if;
  select * into v_item from public.case_remediation_actions where id=p_action_id and case_id=p_case_id for update;
  if not found then raise exception 'ACTION_NOT_FOUND'; end if;
  if v_item.status in ('COMPLETED','WAIVED') then raise exception 'ACTION_ALREADY_FINISHED'; end if;
  update public.case_remediation_actions set status=p_final_status,completion_note=trim(p_completion_note),completed_by=p_actor_user_id,completed_at=now(),updated_at=now() where id=p_action_id;
  insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
  values(p_organization_id,p_case_id,p_actor_user_id,case when p_final_status='WAIVED' then 'GRIEVANCE_ACTION_WAIVED' else 'GRIEVANCE_ACTION_COMPLETED' end,'case_remediation_action',p_action_id,jsonb_build_object('authority_code','GRIEVANCE'));
  return jsonb_build_object('ok',true,'status',p_final_status,'actionId',p_action_id);
end;$$;

create or replace function public.grievance_return_to_triage_atomic(
  p_case_id uuid,p_actor_user_id uuid,p_organization_id uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_case public.cases%rowtype; v_message_id uuid; v_now timestamptz:=now();
begin
  if char_length(trim(coalesce(p_reason,'')))<10 or char_length(trim(coalesce(p_reason,'')))>5000 then raise exception 'REASON_REQUIRED'; end if;
  select * into v_case from public.cases where id=p_case_id for update;
  if not found or v_case.organization_id<>p_organization_id or v_case.authority_code<>'GRIEVANCE' or v_case.classification<>'GRIEVANCE' then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.status<>'REFERRED_GRIEVANCE' then raise exception 'CASE_CHANGED'; end if;
  update public.cases set status='UNDER_REVIEW',classification=null,authority_code='TRIAGE',priority=null,updated_at=v_now where id=p_case_id;
  insert into public.case_messages(case_id,sender_type,body,visible_to_reporter)
  values(p_case_id,'SYSTEM','Laporan sedang ditelaah kembali untuk memastikan jalur penanganan yang tepat.',true) returning id into v_message_id;
  insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
  values(p_organization_id,p_case_id,p_actor_user_id,'GRIEVANCE_RETURNED_TO_TRIAGE','case',p_case_id,jsonb_build_object('reason',trim(p_reason),'message_id',v_message_id,'target_authority','TRIAGE'));
  return jsonb_build_object('ok',true,'status','UNDER_REVIEW','authorityCode','TRIAGE');
end;$$;

create or replace function public.grievance_escalate_safeguarding_atomic(
  p_case_id uuid,p_actor_user_id uuid,p_organization_id uuid,p_reason text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_case public.cases%rowtype; v_message_id uuid; v_now timestamptz:=now();
begin
  if char_length(trim(coalesce(p_reason,'')))<10 or char_length(trim(coalesce(p_reason,'')))>5000 then raise exception 'REASON_REQUIRED'; end if;
  select * into v_case from public.cases where id=p_case_id for update;
  if not found or v_case.organization_id<>p_organization_id or v_case.authority_code<>'GRIEVANCE' or v_case.classification<>'GRIEVANCE' then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.status not in ('REFERRED_GRIEVANCE','REMEDIATION') then raise exception 'CASE_CHANGED'; end if;
  update public.cases set status='REFERRED_SAFEGUARDING',classification='SAFEGUARDING',authority_code='HSE',priority='CRITICAL',updated_at=v_now where id=p_case_id;
  insert into public.case_messages(case_id,sender_type,body,visible_to_reporter)
  values(p_case_id,'SYSTEM','Laporan dialihkan ke jalur perlindungan untuk penanganan risiko keselamatan yang memerlukan perhatian segera.',true) returning id into v_message_id;
  insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
  values(p_organization_id,p_case_id,p_actor_user_id,'GRIEVANCE_ESCALATED_SAFEGUARDING','case',p_case_id,jsonb_build_object('reason',trim(p_reason),'message_id',v_message_id,'target_authority','HSE'));
  return jsonb_build_object('ok',true,'status','REFERRED_SAFEGUARDING','authorityCode','HSE');
end;$$;

revoke all on function public.grievance_start_resolution_atomic(uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.grievance_send_message_atomic(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.grievance_add_action_atomic(uuid,uuid,uuid,text,text,date) from public,anon,authenticated;
revoke all on function public.grievance_finish_action_atomic(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.grievance_return_to_triage_atomic(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.grievance_escalate_safeguarding_atomic(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.grievance_start_resolution_atomic(uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.grievance_send_message_atomic(uuid,uuid,uuid,text) to service_role;
grant execute on function public.grievance_add_action_atomic(uuid,uuid,uuid,text,text,date) to service_role;
grant execute on function public.grievance_finish_action_atomic(uuid,uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.grievance_return_to_triage_atomic(uuid,uuid,uuid,text) to service_role;
grant execute on function public.grievance_escalate_safeguarding_atomic(uuid,uuid,uuid,text) to service_role;