create table if not exists public.case_grievance_reviews (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  coordinator_user_id uuid not null,
  assessment_summary text not null,
  resolution_scope text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(case_id)
);

alter table public.case_grievance_reviews enable row level security;
revoke all on public.case_grievance_reviews from anon, authenticated;
grant all on public.case_grievance_reviews to service_role;

create or replace function public.close_grievance_case(
  p_case_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_resolution_outcome text,
  p_internal_summary text,
  p_reporter_summary text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case public.cases%rowtype;
  v_now timestamptz := now();
  v_pending integer;
  v_total integer;
  v_closure_id uuid;
  v_closure_no integer;
  v_day integer;
  v_outcomes jsonb;
begin
  select * into v_case from public.cases where id=p_case_id and organization_id=p_organization_id for update;
  if not found then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.status <> 'REMEDIATION' or v_case.classification <> 'GRIEVANCE' or v_case.authority_code <> 'GRIEVANCE' then raise exception 'NOT_IN_GRIEVANCE_REMEDIATION'; end if;
  if p_resolution_outcome not in ('RESOLVED','PARTIALLY_RESOLVED','NO_ACTION_REQUIRED') then raise exception 'INVALID_RESOLUTION_OUTCOME'; end if;
  if char_length(trim(coalesce(p_internal_summary,''))) < 5 or char_length(trim(coalesce(p_reporter_summary,''))) < 5 then raise exception 'SUMMARY_REQUIRED'; end if;
  if not exists(
    select 1 from public.user_system_roles r
    join public.profiles p on p.user_id=r.user_id and p.organization_id=r.organization_id
    where r.user_id=p_actor_user_id and r.organization_id=p_organization_id and r.role_code='GRIEVANCE_COORDINATOR'
      and r.active_from<=v_now and (r.active_until is null or r.active_until>v_now) and p.is_active=true
  ) then raise exception 'GRIEVANCE_FORBIDDEN'; end if;

  select count(*) into v_total from public.case_remediation_actions where case_id=p_case_id;
  select count(*) into v_pending from public.case_remediation_actions where case_id=p_case_id and status not in ('COMPLETED','WAIVED');
  if v_total=0 and p_resolution_outcome <> 'NO_ACTION_REQUIRED' then raise exception 'RESOLUTION_ACTION_REQUIRED'; end if;
  if v_pending>0 then raise exception 'PENDING_REMEDIATION'; end if;

  v_outcomes := jsonb_build_array(jsonb_build_object('outcome',p_resolution_outcome));
  select coalesce(max(closure_no),0)+1 into v_closure_no from public.case_closures where case_id=p_case_id;
  insert into public.case_closures(case_id,closure_no,closed_by,internal_summary,reporter_summary,reporter_outcomes,created_at)
  values(p_case_id,v_closure_no,p_actor_user_id,trim(p_internal_summary),trim(p_reporter_summary),v_outcomes,v_now)
  returning id into v_closure_id;

  update public.cases set status='CLOSED',closed_at=v_now,updated_at=v_now where id=p_case_id;
  insert into public.case_messages(case_id,sender_type,sender_user_id,body,visible_to_reporter,created_at)
  values(p_case_id,'SYSTEM',null,'Penanganan pengaduan telah selesai. '||trim(p_reporter_summary),true,v_now);

  foreach v_day in array array[30,60,90] loop
    insert into public.case_followups(case_id,closure_id,day_offset,due_at,status,owner_authority_code,created_at,updated_at)
    values(p_case_id,v_closure_id,v_day,v_now+make_interval(days=>v_day),'SCHEDULED','GRIEVANCE',v_now,v_now);
  end loop;

  update public.case_assignments set access_status='REVOKED',revoked_at=v_now where case_id=p_case_id and access_status='ACTIVE';
  insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
  values(p_organization_id,p_case_id,p_actor_user_id,'GRIEVANCE_CASE_CLOSED','case_closure',v_closure_id,
    jsonb_build_object('closure_no',v_closure_no,'resolution_outcome',p_resolution_outcome,'followups',jsonb_build_array(30,60,90),'followup_owner','GRIEVANCE'));

  return jsonb_build_object('ok',true,'status','CLOSED','closureId',v_closure_id,'closureNo',v_closure_no,'resolutionOutcome',p_resolution_outcome,'closedAt',v_now,'followupOwner','GRIEVANCE');
end;
$$;

revoke execute on function public.close_grievance_case(uuid,uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.close_grievance_case(uuid,uuid,uuid,text,text,text) to service_role;
