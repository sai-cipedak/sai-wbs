create or replace function public.close_case_remediation(
  p_case_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_internal_summary text,
  p_reporter_summary text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case public.cases%rowtype;
  v_outcomes jsonb;
  v_active_allegations integer;
  v_findings integer;
  v_pending integer;
  v_now timestamptz := now();
  v_closure_id uuid;
  v_day integer;
begin
  select * into v_case from public.cases where id=p_case_id and organization_id=p_organization_id for update;
  if not found then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.status <> 'REMEDIATION' then raise exception 'NOT_IN_REMEDIATION'; end if;
  if char_length(trim(p_internal_summary)) < 5 or char_length(trim(p_reporter_summary)) < 5 then raise exception 'SUMMARY_REQUIRED'; end if;

  select count(*) into v_pending from public.case_remediation_actions
   where case_id=p_case_id and status not in ('COMPLETED','WAIVED');
  if v_pending > 0 then raise exception 'PENDING_REMEDIATION'; end if;

  select count(*) into v_active_allegations from public.case_allegations where case_id=p_case_id and status='ACTIVE';
  select count(*) into v_findings from public.case_findings f
   join public.case_allegations a on a.id=f.allegation_id
   where f.case_id=p_case_id and a.case_id=p_case_id and a.status='ACTIVE';
  if v_active_allegations = 0 or v_findings <> v_active_allegations then raise exception 'INCOMPLETE_FINDINGS'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('sequenceNo',a.sequence_no,'outcome',f.finding_status) order by a.sequence_no),'[]'::jsonb)
    into v_outcomes
  from public.case_allegations a join public.case_findings f on f.allegation_id=a.id and f.case_id=a.case_id
  where a.case_id=p_case_id and a.status='ACTIVE';

  insert into public.case_closures(case_id,closed_by,internal_summary,reporter_summary,reporter_outcomes,created_at)
  values(p_case_id,p_actor_user_id,trim(p_internal_summary),trim(p_reporter_summary),v_outcomes,v_now)
  returning id into v_closure_id;

  update public.cases set status='CLOSED',closed_at=v_now,updated_at=v_now where id=p_case_id;

  insert into public.case_messages(case_id,sender_type,sender_user_id,body,visible_to_reporter,created_at)
  values(p_case_id,'SYSTEM',null,'Penanganan laporan telah selesai. '||trim(p_reporter_summary),true,v_now);

  foreach v_day in array array[30,60,90] loop
    insert into public.case_followups(case_id,day_offset,due_at,status,created_at)
    values(p_case_id,v_day,v_now + make_interval(days=>v_day),'SCHEDULED',v_now)
    on conflict(case_id,day_offset) do nothing;
  end loop;

  update public.case_assignments set access_status='REVOKED',revoked_at=v_now
   where case_id=p_case_id and access_status='ACTIVE';

  insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
  values(p_organization_id,p_case_id,p_actor_user_id,'CASE_CLOSED','case_closure',v_closure_id,jsonb_build_object('followups',jsonb_build_array(30,60,90)));

  return jsonb_build_object('ok',true,'status','CLOSED','closureId',v_closure_id,'reporterOutcomes',v_outcomes,'closedAt',v_now);
end;
$$;
revoke all on function public.close_case_remediation(uuid,uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.close_case_remediation(uuid,uuid,uuid,text,text) to service_role;
