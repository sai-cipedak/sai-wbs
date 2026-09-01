-- Synchronize the verified live atomic Dekom and investigation mutations.
-- All RPCs are private implementation details callable only by service_role.

CREATE OR REPLACE FUNCTION public.dekom_activate_case_team_atomic(p_case_id uuid, p_actor_user_id uuid, p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_case public.cases%rowtype; v_user_count integer; v_missing_assignments integer; v_has_lead boolean; v_now timestamptz:=now();
begin
 select * into v_case from public.cases where id=p_case_id for update;
 if not found or v_case.organization_id<>p_organization_id then raise exception 'CASE_NOT_FOUND'; end if;
 if v_case.authority_code<>'DEKOM' or v_case.status<>'COMMITTEE_FORMATION' then raise exception 'TEAM_FORMATION_NOT_ACTIVE'; end if;
 select count(distinct linked_user_id),bool_or(committee_role='CASE_LEAD') into v_user_count,v_has_lead
 from public.case_team_members where case_id=p_case_id and nomination_status='CLEARED' and linked_user_id is not null and committee_role in ('CASE_LEAD','INVESTIGATOR');
 if coalesce(v_user_count,0)<2 then raise exception 'MINIMUM_TEAM_NOT_MET'; end if;
 if not coalesce(v_has_lead,false) then raise exception 'CASE_LEAD_REQUIRED'; end if;
 select count(*) into v_missing_assignments from public.case_team_members m
 where m.case_id=p_case_id and m.nomination_status='CLEARED' and m.linked_user_id is not null and m.committee_role in ('CASE_LEAD','INVESTIGATOR')
 and not exists(select 1 from public.case_assignments a where a.case_id=m.case_id and a.user_id=m.linked_user_id and a.assignment_role=m.committee_role and a.access_status<>'REVOKED');
 if v_missing_assignments>0 then raise exception 'TEAM_ASSIGNMENT_MISSING'; end if;
 update public.case_assignments a set access_status='ACTIVE',revoked_at=null,assigned_at=v_now
 where a.case_id=p_case_id and a.access_status<>'REVOKED' and exists(select 1 from public.case_team_members m where m.case_id=a.case_id and m.linked_user_id=a.user_id and m.nomination_status='CLEARED' and m.committee_role=a.assignment_role and m.committee_role in ('CASE_LEAD','INVESTIGATOR'));
 update public.cases set status='INVESTIGATION',updated_at=v_now where id=p_case_id;
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
 values(p_organization_id,p_case_id,p_actor_user_id,'TEAM_ACTIVATED','case',p_case_id,jsonb_build_object('authority_code','DEKOM','investigator_count',v_user_count,'previous_status','COMMITTEE_FORMATION','next_status','INVESTIGATION'));
 return jsonb_build_object('ok',true,'status','INVESTIGATION','investigatorCount',v_user_count);
end $function$;

revoke all on function public.dekom_activate_case_team_atomic(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.dekom_activate_case_team_atomic(uuid, uuid, uuid) to service_role;

CREATE OR REPLACE FUNCTION public.dekom_add_case_team_member_atomic(p_case_id uuid, p_actor_user_id uuid, p_organization_id uuid, p_email text, p_display_name text, p_member_category text, p_committee_role text, p_rationale text, p_conflict_context text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_case public.cases%rowtype; v_member public.case_team_members%rowtype; v_email text:=lower(trim(coalesce(p_email,''))); v_name text:=nullif(trim(coalesce(p_display_name,'')),''); v_rationale text:=trim(coalesce(p_rationale,'')); v_context text:=trim(coalesce(p_conflict_context,''));
begin
 select * into v_case from public.cases where id=p_case_id for update;
 if not found or v_case.organization_id<>p_organization_id then raise exception 'CASE_NOT_FOUND'; end if;
 if v_case.authority_code<>'DEKOM' or v_case.status<>'COMMITTEE_FORMATION' then raise exception 'TEAM_FORMATION_NOT_ACTIVE'; end if;
 if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'INVALID_EMAIL'; end if;
 if p_member_category not in ('DS','MANAGEMENT','STAFF','OTS','EXTERNAL') then raise exception 'INVALID_MEMBER_CATEGORY'; end if;
 if p_committee_role not in ('CASE_LEAD','INVESTIGATOR','SUBJECT_MATTER_ADVISER') then raise exception 'INVALID_COMMITTEE_ROLE'; end if;
 if char_length(v_rationale)<5 or char_length(v_context)<3 then raise exception 'INVALID_MEMBER_DATA'; end if;
 insert into public.case_team_members(case_id,email,display_name,member_category,committee_role,rationale,conflict_context,nomination_status,nominated_by)
 values(p_case_id,v_email,left(v_name,200),p_member_category,p_committee_role,v_rationale,v_context,'PENDING_ACCOUNT',p_actor_user_id) returning * into v_member;
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
 values(p_organization_id,p_case_id,p_actor_user_id,'TEAM_MEMBER_NOMINATED','case_team_member',v_member.id,jsonb_build_object('committee_role',v_member.committee_role,'member_category',v_member.member_category,'nomination_status',v_member.nomination_status,'authority_code','DEKOM'));
 return jsonb_build_object('ok',true,'memberId',v_member.id,'nominationStatus',v_member.nomination_status,'linkedUserId',v_member.linked_user_id);
end $function$;

revoke all on function public.dekom_add_case_team_member_atomic(uuid, uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.dekom_add_case_team_member_atomic(uuid, uuid, uuid, text, text, text, text, text, text) to service_role;

CREATE OR REPLACE FUNCTION public.dekom_add_remediation_action_atomic(p_case_id uuid, p_actor_user_id uuid, p_organization_id uuid, p_action_text text, p_owner_text text DEFAULT NULL::text, p_due_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_case public.cases%rowtype; v_id uuid; v_owner text;
begin
 if char_length(trim(coalesce(p_action_text,'')))<5 or char_length(trim(coalesce(p_action_text,'')))>5000 then raise exception 'ACTION_TEXT_REQUIRED'; end if;
 v_owner:=nullif(left(trim(coalesce(p_owner_text,'')),500),'');
 select * into v_case from public.cases where id=p_case_id for update;
 if not found or v_case.organization_id<>p_organization_id or v_case.authority_code<>'DEKOM' then raise exception 'CASE_NOT_FOUND'; end if;
 if v_case.status<>'REMEDIATION' then raise exception 'CASE_CHANGED'; end if;
 insert into public.case_remediation_actions(case_id,action_text,owner_text,due_date,status,created_by) values(p_case_id,trim(p_action_text),v_owner,p_due_date,'PENDING',p_actor_user_id) returning id into v_id;
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_case_id,p_actor_user_id,'REMEDIATION_ACTION_ADDED','case_remediation_action',v_id,jsonb_build_object('authority_code','DEKOM'));
 return jsonb_build_object('ok',true,'id',v_id,'remediationId',v_id);
end $function$;

revoke all on function public.dekom_add_remediation_action_atomic(uuid, uuid, uuid, text, text, date) from public, anon, authenticated;
grant execute on function public.dekom_add_remediation_action_atomic(uuid, uuid, uuid, text, text, date) to service_role;

CREATE OR REPLACE FUNCTION public.dekom_finish_remediation_action_atomic(p_case_id uuid, p_remediation_id uuid, p_actor_user_id uuid, p_organization_id uuid, p_final_status text, p_completion_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_case public.cases%rowtype; v_item public.case_remediation_actions%rowtype;
begin
 if p_final_status not in ('COMPLETED','WAIVED') then raise exception 'INVALID_FINAL_STATUS'; end if;
 if char_length(trim(coalesce(p_completion_note,'')))<5 or char_length(trim(coalesce(p_completion_note,'')))>5000 then raise exception 'COMPLETION_NOTE_REQUIRED'; end if;
 select * into v_case from public.cases where id=p_case_id for update;
 if not found or v_case.organization_id<>p_organization_id or v_case.authority_code<>'DEKOM' then raise exception 'CASE_NOT_FOUND'; end if;
 if v_case.status<>'REMEDIATION' then raise exception 'CASE_CHANGED'; end if;
 select * into v_item from public.case_remediation_actions where id=p_remediation_id and case_id=p_case_id for update;
 if not found then raise exception 'REMEDIATION_NOT_FOUND'; end if;
 if v_item.status in ('COMPLETED','WAIVED') then raise exception 'REMEDIATION_ALREADY_FINISHED'; end if;
 update public.case_remediation_actions set status=p_final_status,completion_note=trim(p_completion_note),completed_by=p_actor_user_id,completed_at=now(),updated_at=now() where id=p_remediation_id;
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
 values(p_organization_id,p_case_id,p_actor_user_id,case when p_final_status='COMPLETED' then 'REMEDIATION_ACTION_COMPLETED' else 'REMEDIATION_ACTION_WAIVED' end,'case_remediation_action',p_remediation_id,jsonb_build_object('authority_code','DEKOM'));
 return jsonb_build_object('ok',true,'status',p_final_status,'remediationId',p_remediation_id);
end $function$;

revoke all on function public.dekom_finish_remediation_action_atomic(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.dekom_finish_remediation_action_atomic(uuid, uuid, uuid, uuid, text, text) to service_role;

CREATE OR REPLACE FUNCTION public.dekom_review_findings_atomic(p_case_id uuid, p_actor_user_id uuid, p_organization_id uuid, p_decision text, p_review_notes text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_case public.cases%rowtype; v_review_id uuid; v_active_count integer; v_missing_count integer; v_next_status text;
begin
 if p_decision not in ('APPROVED','RETURNED_FOR_REVISION') then raise exception 'INVALID_DECISION'; end if;
 if char_length(trim(coalesce(p_review_notes,'')))<5 or char_length(trim(coalesce(p_review_notes,'')))>5000 then raise exception 'REVIEW_NOTES_REQUIRED'; end if;
 select * into v_case from public.cases where id=p_case_id for update;
 if not found or v_case.organization_id<>p_organization_id or v_case.authority_code<>'DEKOM' then raise exception 'CASE_NOT_FOUND'; end if;
 if v_case.status<>'AUTHORITY_REVIEW' then raise exception 'CASE_CHANGED'; end if;
 select count(*) into v_active_count from public.case_allegations where case_id=p_case_id and status='ACTIVE';
 if v_active_count=0 then raise exception 'INCOMPLETE_FINDINGS'; end if;
 select count(*) into v_missing_count from public.case_allegations a where a.case_id=p_case_id and a.status='ACTIVE' and not exists(select 1 from public.case_findings f where f.case_id=p_case_id and f.allegation_id=a.id);
 if v_missing_count>0 then raise exception 'INCOMPLETE_FINDINGS'; end if;
 insert into public.case_authority_reviews(case_id,reviewer_user_id,decision,review_notes) values(p_case_id,p_actor_user_id,p_decision,trim(p_review_notes)) returning id into v_review_id;
 v_next_status:=case when p_decision='APPROVED' then 'REMEDIATION' else 'INVESTIGATION' end;
 update public.cases set status=v_next_status,updated_at=now() where id=p_case_id;
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
 values(p_organization_id,p_case_id,p_actor_user_id,case when p_decision='APPROVED' then 'FINDINGS_APPROVED' else 'FINDINGS_RETURNED_FOR_REVISION' end,'case_authority_review',v_review_id,jsonb_build_object('next_status',v_next_status,'authority_code','DEKOM'));
 return jsonb_build_object('ok',true,'status',v_next_status,'reviewId',v_review_id);
end $function$;

revoke all on function public.dekom_review_findings_atomic(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.dekom_review_findings_atomic(uuid, uuid, uuid, text, text) to service_role;

CREATE OR REPLACE FUNCTION public.dekom_revoke_case_team_member_atomic(p_case_id uuid, p_member_id uuid, p_actor_user_id uuid, p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_case public.cases%rowtype; v_member public.case_team_members%rowtype; v_now timestamptz:=now(); v_assignment_count integer:=0;
begin
 select * into v_case from public.cases where id=p_case_id for update;
 if not found or v_case.organization_id<>p_organization_id then raise exception 'CASE_NOT_FOUND'; end if;
 if v_case.authority_code<>'DEKOM' or v_case.status<>'COMMITTEE_FORMATION' then raise exception 'TEAM_FORMATION_NOT_ACTIVE'; end if;
 select * into v_member from public.case_team_members where id=p_member_id and case_id=p_case_id for update;
 if not found then raise exception 'TEAM_MEMBER_NOT_FOUND'; end if;
 if v_member.nomination_status='REVOKED' then raise exception 'TEAM_MEMBER_ALREADY_REVOKED'; end if;
 update public.case_team_members set nomination_status='REVOKED',revoked_at=v_now,updated_at=v_now where id=v_member.id;
 if v_member.linked_user_id is not null then
   update public.case_assignments set access_status='REVOKED',revoked_at=v_now
   where case_id=p_case_id and user_id=v_member.linked_user_id and assignment_role=v_member.committee_role and access_status<>'REVOKED';
   get diagnostics v_assignment_count=row_count;
 end if;
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
 values(p_organization_id,p_case_id,p_actor_user_id,'TEAM_MEMBER_REVOKED','case_team_member',v_member.id,jsonb_build_object('committee_role',v_member.committee_role,'assignment_rows_revoked',v_assignment_count,'authority_code','DEKOM'));
 return jsonb_build_object('ok',true,'memberId',v_member.id,'assignmentRowsRevoked',v_assignment_count);
end $function$;

revoke all on function public.dekom_revoke_case_team_member_atomic(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.dekom_revoke_case_team_member_atomic(uuid, uuid, uuid, uuid) to service_role;

CREATE OR REPLACE FUNCTION public.investigation_add_note_atomic(p_case_id uuid, p_actor_user_id uuid, p_organization_id uuid, p_note_type text, p_title text, p_body text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_case public.cases%rowtype; v_role text; v_note public.case_investigation_notes%rowtype; v_body text:=trim(coalesce(p_body,'')); v_title text:=nullif(left(trim(coalesce(p_title,'')),240),'');
begin
 select * into v_case from public.cases where id=p_case_id for update;
 if not found or v_case.organization_id<>p_organization_id then raise exception 'CASE_NOT_FOUND'; end if;
 if v_case.status<>'INVESTIGATION' then raise exception 'CASE_CHANGED'; end if;
 select assignment_role into v_role from public.case_assignments where case_id=p_case_id and user_id=p_actor_user_id and access_status='ACTIVE' and assignment_role in ('CASE_LEAD','INVESTIGATOR','SUBJECT_MATTER_ADVISER') order by case assignment_role when 'CASE_LEAD' then 1 when 'INVESTIGATOR' then 2 else 3 end limit 1;
 if v_role is null then raise exception 'FORBIDDEN'; end if;
 if p_note_type not in ('GENERAL','INTERVIEW','EVIDENCE','ANALYSIS') then raise exception 'INVALID_NOTE_TYPE'; end if;
 if char_length(v_body)<3 or char_length(v_body)>10000 then raise exception 'INVALID_NOTE_BODY'; end if;
 insert into public.case_investigation_notes(case_id,author_user_id,note_type,title,body) values(p_case_id,p_actor_user_id,p_note_type,v_title,v_body) returning * into v_note;
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_case_id,p_actor_user_id,'INVESTIGATION_NOTE_ADDED','case_investigation_note',v_note.id,jsonb_build_object('note_type',p_note_type));
 return jsonb_build_object('ok',true,'note',jsonb_build_object('id',v_note.id,'note_type',v_note.note_type,'title',v_note.title,'body',v_note.body,'created_at',v_note.created_at));
end $function$;

revoke all on function public.investigation_add_note_atomic(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.investigation_add_note_atomic(uuid, uuid, uuid, text, text, text) to service_role;

CREATE OR REPLACE FUNCTION public.investigation_save_allegation_atomic(p_case_id uuid, p_actor_user_id uuid, p_organization_id uuid, p_statement text, p_allegation_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_case public.cases%rowtype; v_role text; v_row public.case_allegations%rowtype; v_next integer; v_statement text:=trim(coalesce(p_statement,''));
begin
 if char_length(v_statement)<5 or char_length(v_statement)>2000 then raise exception 'INVALID_STATEMENT'; end if;
 select * into v_case from public.cases where id=p_case_id for update;
 if not found or v_case.organization_id<>p_organization_id then raise exception 'CASE_NOT_FOUND'; end if;
 if v_case.status<>'INVESTIGATION' then raise exception 'CASE_CHANGED'; end if;
 select assignment_role into v_role from public.case_assignments where case_id=p_case_id and user_id=p_actor_user_id and access_status='ACTIVE' and assignment_role='CASE_LEAD' limit 1;
 if v_role is null then raise exception 'FORBIDDEN'; end if;
 if p_allegation_id is not null then
   select * into v_row from public.case_allegations where id=p_allegation_id and case_id=p_case_id for update;
   if not found then raise exception 'ALLEGATION_NOT_FOUND'; end if;
   update public.case_allegations set statement=v_statement,updated_at=now() where id=p_allegation_id returning * into v_row;
   insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_case_id,p_actor_user_id,'ALLEGATION_UPDATED','case_allegation',v_row.id,jsonb_build_object('sequence_no',v_row.sequence_no));
 else
   select coalesce(max(sequence_no),0)+1 into v_next from public.case_allegations where case_id=p_case_id;
   insert into public.case_allegations(case_id,sequence_no,statement,created_by) values(p_case_id,v_next,v_statement,p_actor_user_id) returning * into v_row;
   insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_case_id,p_actor_user_id,'ALLEGATION_ADDED','case_allegation',v_row.id,jsonb_build_object('sequence_no',v_row.sequence_no));
 end if;
 return jsonb_build_object('ok',true,'allegation',jsonb_build_object('id',v_row.id,'sequence_no',v_row.sequence_no,'statement',v_row.statement,'status',v_row.status));
end $function$;

revoke all on function public.investigation_save_allegation_atomic(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.investigation_save_allegation_atomic(uuid, uuid, uuid, text, uuid) to service_role;

CREATE OR REPLACE FUNCTION public.investigation_save_finding_atomic(p_case_id uuid, p_actor_user_id uuid, p_organization_id uuid, p_allegation_id uuid, p_finding_status text, p_analysis_text text, p_recommendation_text text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_case public.cases%rowtype; v_role text; v_row public.case_findings%rowtype; v_analysis text:=trim(coalesce(p_analysis_text,'')); v_recommendation text:=nullif(left(trim(coalesce(p_recommendation_text,'')),5000),'');
begin
 select * into v_case from public.cases where id=p_case_id for update;
 if not found or v_case.organization_id<>p_organization_id then raise exception 'CASE_NOT_FOUND'; end if;
 if v_case.status<>'INVESTIGATION' then raise exception 'CASE_CHANGED'; end if;
 select assignment_role into v_role from public.case_assignments where case_id=p_case_id and user_id=p_actor_user_id and access_status='ACTIVE' and assignment_role in ('CASE_LEAD','INVESTIGATOR') limit 1;
 if v_role is null then raise exception 'FORBIDDEN'; end if;
 if p_finding_status not in ('PROVEN','PARTIALLY_PROVEN','NOT_PROVEN','INCONCLUSIVE','NOT_EXAMINABLE','OUT_OF_SCOPE') then raise exception 'INVALID_FINDING_STATUS'; end if;
 if char_length(v_analysis)<20 or char_length(v_analysis)>10000 then raise exception 'INVALID_ANALYSIS'; end if;
 perform 1 from public.case_allegations where id=p_allegation_id and case_id=p_case_id and status='ACTIVE'; if not found then raise exception 'ALLEGATION_NOT_FOUND'; end if;
 insert into public.case_findings(case_id,allegation_id,finding_status,analysis_text,recommendation_text,updated_by,updated_at)
 values(p_case_id,p_allegation_id,p_finding_status,v_analysis,v_recommendation,p_actor_user_id,now())
 on conflict(case_id,allegation_id) do update set finding_status=excluded.finding_status,analysis_text=excluded.analysis_text,recommendation_text=excluded.recommendation_text,updated_by=excluded.updated_by,updated_at=excluded.updated_at
 returning * into v_row;
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_case_id,p_actor_user_id,'FINDING_SAVED','case_finding',v_row.id,jsonb_build_object('finding_status',p_finding_status));
 return jsonb_build_object('ok',true,'finding',jsonb_build_object('id',v_row.id,'allegation_id',v_row.allegation_id,'finding_status',v_row.finding_status,'analysis_text',v_row.analysis_text,'recommendation_text',v_row.recommendation_text,'updated_at',v_row.updated_at));
end $function$;

revoke all on function public.investigation_save_finding_atomic(uuid, uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.investigation_save_finding_atomic(uuid, uuid, uuid, uuid, text, text, text) to service_role;

CREATE OR REPLACE FUNCTION public.investigation_send_reporter_message_atomic(p_case_id uuid, p_actor_user_id uuid, p_organization_id uuid, p_message text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_case public.cases%rowtype; v_role text; v_id uuid; v_message text:=trim(coalesce(p_message,''));
begin
 select * into v_case from public.cases where id=p_case_id for update;
 if not found or v_case.organization_id<>p_organization_id then raise exception 'CASE_NOT_FOUND'; end if;
 if v_case.status<>'INVESTIGATION' then raise exception 'CASE_CHANGED'; end if;
 select assignment_role into v_role from public.case_assignments where case_id=p_case_id and user_id=p_actor_user_id and access_status='ACTIVE' and assignment_role in ('CASE_LEAD','INVESTIGATOR') limit 1;
 if v_role is null then raise exception 'FORBIDDEN'; end if;
 if char_length(v_message)<3 or char_length(v_message)>5000 then raise exception 'INVALID_MESSAGE'; end if;
 insert into public.case_messages(case_id,sender_type,sender_user_id,body,visible_to_reporter) values(p_case_id,'INTERNAL',p_actor_user_id,v_message,true) returning id into v_id;
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_case_id,p_actor_user_id,'INVESTIGATION_REPORTER_MESSAGE_SENT','case_message',v_id,'{}'::jsonb);
 return jsonb_build_object('ok',true,'messageId',v_id);
end $function$;

revoke all on function public.investigation_send_reporter_message_atomic(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.investigation_send_reporter_message_atomic(uuid, uuid, uuid, text) to service_role;

CREATE OR REPLACE FUNCTION public.investigation_submit_findings_atomic(p_case_id uuid, p_actor_user_id uuid, p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_case public.cases%rowtype; v_role text; v_count integer; v_missing integer;
begin
 select * into v_case from public.cases where id=p_case_id for update;
 if not found or v_case.organization_id<>p_organization_id then raise exception 'CASE_NOT_FOUND'; end if;
 if v_case.status<>'INVESTIGATION' then raise exception 'CASE_CHANGED'; end if;
 select assignment_role into v_role from public.case_assignments where case_id=p_case_id and user_id=p_actor_user_id and access_status='ACTIVE' and assignment_role='CASE_LEAD' limit 1;
 if v_role is null then raise exception 'FORBIDDEN'; end if;
 select count(*) into v_count from public.case_allegations where case_id=p_case_id and status='ACTIVE'; if v_count=0 then raise exception 'NO_ALLEGATIONS'; end if;
 select count(*) into v_missing from public.case_allegations a where a.case_id=p_case_id and a.status='ACTIVE' and not exists(select 1 from public.case_findings f where f.case_id=p_case_id and f.allegation_id=a.id); if v_missing>0 then raise exception 'INCOMPLETE_FINDINGS'; end if;
 update public.cases set status='AUTHORITY_REVIEW',updated_at=now() where id=p_case_id;
 insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_case_id,p_actor_user_id,'FINDINGS_SUBMITTED_TO_AUTHORITY','case',p_case_id,jsonb_build_object('allegation_count',v_count));
 return jsonb_build_object('ok',true,'nomorLaporan',v_case.public_case_id,'status','AUTHORITY_REVIEW');
end $function$;

revoke all on function public.investigation_submit_findings_atomic(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.investigation_submit_findings_atomic(uuid, uuid, uuid) to service_role;

