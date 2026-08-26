create or replace function public.complete_case_followup(
  p_followup_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_check_method text,
  p_outcome text,
  p_risk_level text,
  p_notes text,
  p_escalation_note text default null
) returns jsonb
language plpgsql
security definer
set search_path='public','pg_temp'
as $$
declare
  v_followup public.case_followups%rowtype;
  v_case public.cases%rowtype;
  v_now timestamptz := now();
  v_escalation_required boolean;
  v_escalation_status text;
  v_linked_case_id uuid;
  v_linked_public_id text;
  v_remediation_id uuid;
  v_try integer := 0;
begin
  select * into v_followup from public.case_followups where id=p_followup_id for update;
  if not found then raise exception 'FOLLOWUP_NOT_FOUND'; end if;
  if v_followup.status <> 'SCHEDULED' then raise exception 'FOLLOWUP_ALREADY_COMPLETED'; end if;

  select * into v_case from public.cases where id=v_followup.case_id and organization_id=p_organization_id for update;
  if not found then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.status <> 'CLOSED' then raise exception 'CASE_NOT_CLOSED'; end if;

  if p_check_method not in ('INTERNAL_REVIEW','REPORTER_CHECK_IN','OTHER') then raise exception 'INVALID_CHECK_METHOD'; end if;
  if p_outcome not in ('NO_CONCERN','CONTINUE_MONITORING','RETALIATION_CONCERN','REMEDIATION_FAILURE','OTHER') then raise exception 'INVALID_OUTCOME'; end if;
  if p_risk_level not in ('LOW','MEDIUM','HIGH','CRITICAL') then raise exception 'INVALID_RISK'; end if;
  if char_length(trim(coalesce(p_notes,''))) < 5 or char_length(trim(coalesce(p_notes,''))) > 5000 then raise exception 'NOTES_REQUIRED'; end if;

  v_escalation_required := p_outcome in ('RETALIATION_CONCERN','REMEDIATION_FAILURE') or p_risk_level in ('HIGH','CRITICAL');
  if v_escalation_required and char_length(trim(coalesce(p_escalation_note,''))) < 5 then raise exception 'ESCALATION_NOTE_REQUIRED'; end if;
  v_escalation_status := case when v_escalation_required then 'OPEN' else 'NONE' end;

  update public.case_followups set
    status='COMPLETED', check_method=p_check_method, outcome=p_outcome, risk_level=p_risk_level,
    notes=trim(p_notes), completed_by=p_actor_user_id, completed_at=v_now, updated_at=v_now,
    escalation_required=v_escalation_required, escalation_note=case when v_escalation_required then trim(p_escalation_note) else null end,
    escalation_status=v_escalation_status, escalation_resolved_by=null, escalation_resolved_at=null,
    escalation_resolution_note=null, escalation_resolution_mode=null
  where id=p_followup_id;

  if p_outcome='RETALIATION_CONCERN' then
    loop
      v_try := v_try + 1;
      v_linked_public_id := 'SAI-CIP-'||to_char(v_now,'YY')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
      exit when not exists(select 1 from public.cases where public_case_id=v_linked_public_id);
      if v_try > 10 then raise exception 'CASE_ID_GENERATION_FAILED'; end if;
    end loop;

    insert into public.cases(
      organization_id,public_case_id,reporting_mode,status,classification,priority,authority_code,
      policy_version_id,created_by_user_id,submitted_at,created_at,updated_at
    ) values(
      v_case.organization_id,v_linked_public_id,v_case.reporting_mode,'UNDER_REVIEW','INTEGRITY',
      case when p_risk_level='CRITICAL' then 'CRITICAL' else 'HIGH' end,
      'TRIAGE',v_case.policy_version_id,p_actor_user_id,v_now,v_now,v_now
    ) returning id into v_linked_case_id;

    insert into public.case_reports(case_id,title,narrative,child_safety_risk,ongoing_risk,submitted_at)
    values(
      v_linked_case_id,
      'Tindak Lanjut Retaliation — '||v_case.public_case_id,
      'Case ini dibuat otomatis dari follow-up '||v_followup.day_offset||' hari atas '||v_case.public_case_id||'.'||chr(10)||chr(10)||
      'Temuan follow-up: '||trim(p_notes)||chr(10)||chr(10)||
      'Catatan eskalasi: '||trim(p_escalation_note),
      false,false,v_now
    );

    insert into public.case_links(source_case_id,linked_case_id,source_followup_id,relation_type,created_by)
    values(v_case.id,v_linked_case_id,p_followup_id,'RETALIATION_FOLLOWUP',p_actor_user_id);

    update public.case_followups set linked_case_id=v_linked_case_id, escalation_resolution_mode='LINKED_CASE' where id=p_followup_id;

    insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
    values
      (p_organization_id,v_case.id,p_actor_user_id,'FOLLOWUP_RETALIATION_CASE_CREATED','case_followup',p_followup_id,jsonb_build_object('linked_case_id',v_linked_case_id,'linked_public_case_id',v_linked_public_id,'day_offset',v_followup.day_offset)),
      (p_organization_id,v_linked_case_id,p_actor_user_id,'LINKED_RETALIATION_CASE_CREATED','case',v_linked_case_id,jsonb_build_object('source_case_id',v_case.id,'source_public_case_id',v_case.public_case_id,'source_followup_id',p_followup_id));

  elsif p_outcome='REMEDIATION_FAILURE' then
    update public.cases set status='REMEDIATION',closed_at=null,updated_at=v_now where id=v_case.id;

    insert into public.case_remediation_actions(case_id,action_text,owner_text,status,created_by,created_at,updated_at)
    values(
      v_case.id,
      left('Remediation dibuka kembali karena follow-up '||v_followup.day_offset||' hari menunjukkan tindak lanjut sebelumnya tidak efektif/gagal. '||trim(p_notes),5000),
      'Sekretariat DS','PENDING',p_actor_user_id,v_now,v_now
    ) returning id into v_remediation_id;

    update public.case_followups set status='CANCELLED',updated_at=v_now
    where closure_id=v_followup.closure_id and id<>p_followup_id and status='SCHEDULED';

    update public.case_followups set
      escalation_status='RESOLVED', escalation_resolved_by=p_actor_user_id, escalation_resolved_at=v_now,
      escalation_resolution_note='Remediation pada case asal dibuka kembali secara otomatis.',
      escalation_resolution_mode='REMEDIATION_REOPENED'
    where id=p_followup_id;

    insert into public.case_messages(case_id,sender_type,sender_user_id,body,visible_to_reporter,created_at)
    values(v_case.id,'SYSTEM',null,'Berdasarkan evaluasi berkala, tindak lanjut atas laporan ini sedang dilakukan kembali.',true,v_now);

    insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
    values(p_organization_id,v_case.id,p_actor_user_id,'CASE_REMEDIATION_REOPENED','case_remediation_action',v_remediation_id,jsonb_build_object('source_followup_id',p_followup_id,'day_offset',v_followup.day_offset));
  end if;

  insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
  values(p_organization_id,v_case.id,p_actor_user_id,'FOLLOWUP_COMPLETED','case_followup',p_followup_id,
    jsonb_build_object('day_offset',v_followup.day_offset,'outcome',p_outcome,'risk_level',p_risk_level,'completed_early',v_followup.due_at>v_now,'escalation_required',v_escalation_required,'linked_case_id',v_linked_case_id));

  return jsonb_build_object(
    'ok',true,'followupId',p_followup_id,'escalationOpen',case when p_outcome='REMEDIATION_FAILURE' then false else v_escalation_required end,
    'linkedCaseId',v_linked_case_id,'linkedPublicCaseId',v_linked_public_id,
    'remediationReopened',p_outcome='REMEDIATION_FAILURE','caseStatus',case when p_outcome='REMEDIATION_FAILURE' then 'REMEDIATION' else 'CLOSED' end
  );
end;
$$;

revoke all on function public.complete_case_followup(uuid,uuid,uuid,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.complete_case_followup(uuid,uuid,uuid,text,text,text,text,text) to service_role;

update public.case_reports
set narrative = replace(narrative, '\n', chr(10))
where title like 'Tindak Lanjut Retaliation — %'
  and narrative like '%\n%';
