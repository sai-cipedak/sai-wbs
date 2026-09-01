create or replace function public.apply_triage_action_atomic(
  p_case_id uuid,
  p_actor_user_id uuid,
  p_expected_status text,
  p_action text,
  p_internal_reason text default null,
  p_reporter_explanation text default null,
  p_reporter_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case public.cases%rowtype;
  v_now timestamptz := now();
  v_action text := upper(trim(coalesce(p_action,'')));
  v_internal_reason text := nullif(trim(coalesce(p_internal_reason,'')), '');
  v_reporter_explanation text := nullif(trim(coalesce(p_reporter_explanation,'')), '');
  v_reporter_message text := nullif(trim(coalesce(p_reporter_message,'')), '');
  v_next_status text;
  v_next_classification text;
  v_next_authority text;
  v_next_closed_at timestamptz;
  v_decision_classification text;
  v_target_authority text := 'TRIAGE';
  v_audit_event text;
  v_message_body text;
  v_decision_reporter_explanation text;
  v_decision_id uuid;
  v_message_id uuid;
begin
  if p_case_id is null or p_actor_user_id is null then
    raise exception 'INVALID_ARGUMENT';
  end if;

  if v_action not in (
    'START_REVIEW','REQUEST_INFO','ROUTE_INTEGRITY','ROUTE_SAFEGUARDING',
    'ROUTE_GRIEVANCE','ROUTE_DEKOM','CLOSE_OUT_OF_SCOPE'
  ) then
    raise exception 'INVALID_ACTION';
  end if;

  select * into v_case
  from public.cases
  where id = p_case_id
  for update;

  if not found then
    raise exception 'CASE_NOT_FOUND';
  end if;

  if v_case.authority_code <> 'TRIAGE' or v_case.status in ('CLOSED','OUT_OF_SCOPE') then
    raise exception 'TRIAGE_AUTHORITY_CHANGED';
  end if;

  if p_expected_status is null or v_case.status <> p_expected_status then
    raise exception 'CASE_CHANGED';
  end if;

  v_next_status := v_case.status;
  v_next_classification := v_case.classification;
  v_next_authority := v_case.authority_code;
  v_next_closed_at := v_case.closed_at;

  case v_action
    when 'START_REVIEW' then
      if v_case.status not in ('SUBMITTED','MORE_INFO_REQUIRED') then
        raise exception 'INVALID_START_REVIEW_STATUS';
      end if;
      v_next_status := 'UNDER_REVIEW';
      v_audit_event := 'TRIAGE_REVIEW_STARTED';

    when 'REQUEST_INFO' then
      if v_reporter_message is null or char_length(v_reporter_message) < 10 or char_length(v_reporter_message) > 4000 then
        raise exception 'INVALID_REPORTER_MESSAGE';
      end if;
      v_next_status := 'MORE_INFO_REQUIRED';
      v_message_body := v_reporter_message;
      v_decision_reporter_explanation := v_reporter_message;
      v_audit_event := 'TRIAGE_INFO_REQUESTED';

    when 'ROUTE_INTEGRITY' then
      if v_internal_reason is null or char_length(v_internal_reason) < 10 or char_length(v_internal_reason) > 4000 then
        raise exception 'INVALID_INTERNAL_REASON';
      end if;
      v_next_status := 'COMMITTEE_FORMATION';
      v_next_classification := 'INTEGRITY';
      v_next_authority := 'SECRETARIAT';
      v_decision_classification := 'INTEGRITY';
      v_target_authority := 'SECRETARIAT';
      v_audit_event := 'CASE_ROUTED_INTEGRITY';

    when 'ROUTE_SAFEGUARDING' then
      if v_internal_reason is null or char_length(v_internal_reason) < 10 or char_length(v_internal_reason) > 4000 then
        raise exception 'INVALID_INTERNAL_REASON';
      end if;
      v_next_status := 'REFERRED_SAFEGUARDING';
      v_next_classification := 'SAFEGUARDING';
      v_next_authority := 'HSE';
      v_decision_classification := 'SAFEGUARDING';
      v_target_authority := 'HSE';
      v_audit_event := 'CASE_ROUTED_SAFEGUARDING';

    when 'ROUTE_GRIEVANCE' then
      if v_internal_reason is null or char_length(v_internal_reason) < 10 or char_length(v_internal_reason) > 4000 then
        raise exception 'INVALID_INTERNAL_REASON';
      end if;
      v_next_status := 'REFERRED_GRIEVANCE';
      v_next_classification := 'GRIEVANCE';
      v_next_authority := 'GRIEVANCE';
      v_decision_classification := 'GRIEVANCE';
      v_target_authority := 'GRIEVANCE';
      v_audit_event := 'CASE_ROUTED_GRIEVANCE';

    when 'ROUTE_DEKOM' then
      if v_internal_reason is null or char_length(v_internal_reason) < 10 or char_length(v_internal_reason) > 4000 then
        raise exception 'INVALID_INTERNAL_REASON';
      end if;
      v_next_status := 'COMMITTEE_FORMATION';
      v_next_authority := 'DEKOM';
      v_target_authority := 'DEKOM';
      v_audit_event := 'CASE_ROUTED_DEKOM';

    when 'CLOSE_OUT_OF_SCOPE' then
      if v_internal_reason is null or char_length(v_internal_reason) < 10 or char_length(v_internal_reason) > 4000 then
        raise exception 'INVALID_INTERNAL_REASON';
      end if;
      if v_reporter_explanation is null or char_length(v_reporter_explanation) < 10 or char_length(v_reporter_explanation) > 4000 then
        raise exception 'INVALID_REPORTER_EXPLANATION';
      end if;
      v_next_status := 'OUT_OF_SCOPE';
      v_next_classification := 'OUT_OF_SCOPE';
      v_next_closed_at := v_now;
      v_decision_classification := 'OUT_OF_SCOPE';
      v_message_body := v_reporter_explanation;
      v_decision_reporter_explanation := v_reporter_explanation;
      v_audit_event := 'CASE_CLOSED_OUT_OF_SCOPE';
  end case;

  update public.cases
  set status = v_next_status,
      classification = v_next_classification,
      authority_code = v_next_authority,
      closed_at = v_next_closed_at,
      updated_at = v_now
  where id = v_case.id;

  if v_message_body is not null then
    insert into public.case_messages(
      case_id, sender_type, sender_user_id, body, visible_to_reporter
    ) values (
      v_case.id, 'INTERNAL', p_actor_user_id, v_message_body, true
    ) returning id into v_message_id;
  end if;

  insert into public.case_triage_decisions(
    case_id, reviewer_user_id, action, classification, target_authority,
    internal_reason, reporter_explanation
  ) values (
    v_case.id, p_actor_user_id, v_action, v_decision_classification, v_target_authority,
    v_internal_reason, v_decision_reporter_explanation
  ) returning id into v_decision_id;

  insert into public.audit_logs(
    organization_id, case_id, actor_user_id, event_type, object_type, object_id, details
  ) values (
    v_case.organization_id,
    v_case.id,
    p_actor_user_id,
    v_audit_event,
    'case',
    v_case.id,
    jsonb_build_object(
      'action', v_action,
      'target_authority', v_target_authority,
      'classification', v_decision_classification
    )
  );

  return jsonb_build_object(
    'ok', true,
    'nomorLaporan', v_case.public_case_id,
    'action', v_action,
    'status', v_next_status,
    'classification', v_next_classification,
    'authorityCode', v_next_authority,
    'decisionId', v_decision_id,
    'messageId', v_message_id
  );
end;
$$;

revoke all on function public.apply_triage_action_atomic(uuid,uuid,text,text,text,text,text) from public;
revoke all on function public.apply_triage_action_atomic(uuid,uuid,text,text,text,text,text) from anon;
revoke all on function public.apply_triage_action_atomic(uuid,uuid,text,text,text,text,text) from authenticated;
grant execute on function public.apply_triage_action_atomic(uuid,uuid,text,text,text,text,text) to service_role;
