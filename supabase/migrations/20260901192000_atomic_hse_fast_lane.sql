create unique index if not exists case_safeguarding_assessments_case_id_ux on public.case_safeguarding_assessments(case_id);

create or replace function public.hse_assess_risk_atomic(p_case_id uuid,p_actor_user_id uuid,p_organization_id uuid,p_immediate_danger boolean,p_risk_summary text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_case public.cases%rowtype;v_assessment_id uuid;v_next_status text;
begin
 if char_length(trim(coalesce(p_risk_summary,'')))<10 or char_length(trim(coalesce(p_risk_summary,'')))>5000 then raise exception 'RISK_SUMMARY_REQUIRED';end if;
 select * into v_case from public.cases where id=p_case_id for update;
 if not found or v_case.organization_id<>p_organization_id or v_case.authority_code<>'HSE' or v_case.classification<>'SAFEGUARDING' then raise exception 'CASE_NOT_FOUND';end if;
 if v_case.status<>'REFERRED_SAFEGUARDING' then raise exception 'FAST_LANE_NOT_ACTIVE';end if;
 if exists(select 1 from public.case_safeguarding_assessments where case_id=p_case_id) then raise exception 'ASSESSMENT_ALREADY_EXISTS';end if;
 insert into public.case_safeguarding_assessments(case_id,assessed_by,immediate_danger,risk_summary,assessed_at) values(p_case_id,p_actor_user_id,p_immediate_danger,trim(p_risk_summary),now()) returning id into v_assessment_id;
 v_next_status:=case when p_immediate_danger then 'REFERRED_SAFEGUARDING' else 'COMMITTEE_FORMATION' end;
 if not p_immediate_danger then update public.cases set status='COMMITTEE_FORMATION',updated_at=now() where id=p_case_id;end if;
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_case_id,p_actor_user_id,'SAFEGUARDING_RISK_ASSESSED','case_safeguarding_assessment',v_assessment_id,jsonb_build_object('immediate_danger',p_immediate_danger,'next_status',v_next_status));
 if not p_immediate_danger then insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_case_id,p_actor_user_id,'SAFEGUARDING_FAST_LANE_CLEARED','case',p_case_id,jsonb_build_object('reason','NO_IMMEDIATE_DANGER'));end if;
 return jsonb_build_object('ok',true,'assessmentId',v_assessment_id,'immediateDanger',p_immediate_danger,'status',v_next_status,'protectiveActionRequired',p_immediate_danger);
end;$$;

create or replace function public.hse_record_protective_action_atomic(p_case_id uuid,p_actor_user_id uuid,p_organization_id uuid,p_action_text text,p_owner_text text default null) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_case public.cases%rowtype;v_assessment public.case_safeguarding_assessments%rowtype;v_action_id uuid;v_same_day boolean;v_owner text;
begin
 if char_length(trim(coalesce(p_action_text,'')))<10 or char_length(trim(coalesce(p_action_text,'')))>5000 then raise exception 'PROTECTIVE_ACTION_REQUIRED';end if;
 v_owner:=nullif(left(trim(coalesce(p_owner_text,'')),240),'');
 select * into v_case from public.cases where id=p_case_id for update;
 if not found or v_case.organization_id<>p_organization_id or v_case.authority_code<>'HSE' or v_case.classification<>'SAFEGUARDING' then raise exception 'CASE_NOT_FOUND';end if;
 if v_case.status<>'REFERRED_SAFEGUARDING' then raise exception 'PROTECTIVE_GATE_NOT_ACTIVE';end if;
 select * into v_assessment from public.case_safeguarding_assessments where case_id=p_case_id;
 if not found or not v_assessment.immediate_danger then raise exception 'IMMEDIATE_DANGER_NOT_ASSESSED';end if;
 insert into public.case_protective_actions(case_id,assessment_id,action_text,owner_text,initiated_by,initiated_at,status) values(p_case_id,v_assessment.id,trim(p_action_text),v_owner,p_actor_user_id,now(),'ACTIVE') returning id into v_action_id;
 v_same_day:=((v_case.submitted_at at time zone 'Asia/Jakarta')::date=(now() at time zone 'Asia/Jakarta')::date);
 update public.cases set status='COMMITTEE_FORMATION',updated_at=now() where id=p_case_id;
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_case_id,p_actor_user_id,'PROTECTIVE_ACTION_INITIATED','case_protective_action',v_action_id,jsonb_build_object('same_day_sla_met',v_same_day,'owner',v_owner));
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_case_id,p_actor_user_id,'SAFEGUARDING_PROTECTIVE_GATE_CLEARED','case',p_case_id,jsonb_build_object('protective_action_id',v_action_id,'same_day_sla_met',v_same_day,'next_status','COMMITTEE_FORMATION'));
 return jsonb_build_object('ok',true,'protectiveActionId',v_action_id,'status','COMMITTEE_FORMATION','sameDaySlaMet',v_same_day);
end;$$;

create or replace function public.hse_complete_protective_action_atomic(p_case_id uuid,p_protective_action_id uuid,p_actor_user_id uuid,p_organization_id uuid,p_completion_note text) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_case public.cases%rowtype;v_action public.case_protective_actions%rowtype;
begin
 if char_length(trim(coalesce(p_completion_note,'')))<5 or char_length(trim(coalesce(p_completion_note,'')))>5000 then raise exception 'COMPLETION_NOTE_REQUIRED';end if;
 select * into v_case from public.cases where id=p_case_id for update;
 if not found or v_case.organization_id<>p_organization_id or v_case.authority_code<>'HSE' or v_case.classification<>'SAFEGUARDING' then raise exception 'CASE_NOT_FOUND';end if;
 select * into v_action from public.case_protective_actions where id=p_protective_action_id and case_id=p_case_id for update;
 if not found then raise exception 'PROTECTIVE_ACTION_NOT_FOUND';end if;
 if v_action.status<>'ACTIVE' then raise exception 'PROTECTIVE_ACTION_NOT_ACTIVE';end if;
 update public.case_protective_actions set status='COMPLETED',completion_note=trim(p_completion_note),completed_by=p_actor_user_id,completed_at=now(),updated_at=now() where id=p_protective_action_id;
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_case_id,p_actor_user_id,'PROTECTIVE_ACTION_COMPLETED','case_protective_action',p_protective_action_id,'{}'::jsonb);
 return jsonb_build_object('ok',true,'status','COMPLETED','protectiveActionId',p_protective_action_id);
end;$$;

revoke all on function public.hse_assess_risk_atomic(uuid,uuid,uuid,boolean,text) from public,anon,authenticated;
revoke all on function public.hse_record_protective_action_atomic(uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.hse_complete_protective_action_atomic(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.hse_assess_risk_atomic(uuid,uuid,uuid,boolean,text) to service_role;
grant execute on function public.hse_record_protective_action_atomic(uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.hse_complete_protective_action_atomic(uuid,uuid,uuid,uuid,text) to service_role;
