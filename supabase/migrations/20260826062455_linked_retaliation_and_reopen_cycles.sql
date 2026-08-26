alter table public.case_closures add column if not exists closure_no integer;
update public.case_closures set closure_no=1 where closure_no is null;
alter table public.case_closures alter column closure_no set not null;
alter table public.case_closures drop constraint if exists case_closures_case_id_key;
alter table public.case_closures add constraint case_closures_case_closure_no_key unique(case_id,closure_no);

alter table public.case_followups add column if not exists closure_id uuid references public.case_closures(id) on delete cascade;
update public.case_followups f set closure_id=c.id from public.case_closures c where c.case_id=f.case_id and c.closure_no=1 and f.closure_id is null;
alter table public.case_followups alter column closure_id set not null;
alter table public.case_followups drop constraint if exists case_followups_case_id_day_offset_key;
alter table public.case_followups add constraint case_followups_closure_day_key unique(closure_id,day_offset);
alter table public.case_followups add column if not exists linked_case_id uuid references public.cases(id) on delete set null;
alter table public.case_followups add column if not exists escalation_resolution_mode text;
alter table public.case_followups add constraint case_followups_escalation_resolution_mode_check check (escalation_resolution_mode is null or escalation_resolution_mode in ('LINKED_CASE','REMEDIATION_REOPENED','MANUAL_RESOLUTION'));

create table if not exists public.case_links(
  id uuid primary key default gen_random_uuid(),
  source_case_id uuid not null references public.cases(id) on delete cascade,
  linked_case_id uuid not null references public.cases(id) on delete cascade,
  source_followup_id uuid references public.case_followups(id) on delete set null,
  relation_type text not null check(relation_type in ('RETALIATION_FOLLOWUP','RELATED')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique(source_case_id,linked_case_id,relation_type)
);
alter table public.case_links enable row level security;
revoke all on public.case_links from anon, authenticated;
create index if not exists case_links_source_idx on public.case_links(source_case_id,created_at desc);
create index if not exists case_links_linked_idx on public.case_links(linked_case_id);
create index if not exists case_followups_linked_case_idx on public.case_followups(linked_case_id) where linked_case_id is not null;

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
      'Case ini dibuat otomatis dari follow-up '||v_followup.day_offset||' hari atas '||v_case.public_case_id||'.\n\nTemuan follow-up: '||trim(p_notes)||'\n\nCatatan eskalasi: '||trim(p_escalation_note),
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

create or replace function public.resolve_case_followup_escalation(
  p_followup_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_resolution_note text
) returns jsonb
language plpgsql
security definer
set search_path='public','pg_temp'
as $$
declare
  v_followup public.case_followups%rowtype;
  v_case public.cases%rowtype;
  v_now timestamptz := now();
begin
  select * into v_followup from public.case_followups where id=p_followup_id for update;
  if not found then raise exception 'FOLLOWUP_NOT_FOUND'; end if;
  select * into v_case from public.cases where id=v_followup.case_id and organization_id=p_organization_id;
  if not found then raise exception 'CASE_NOT_FOUND'; end if;
  if v_followup.escalation_status <> 'OPEN' then raise exception 'ESCALATION_NOT_OPEN'; end if;
  if char_length(trim(coalesce(p_resolution_note,''))) < 5 or char_length(trim(coalesce(p_resolution_note,''))) > 5000 then raise exception 'RESOLUTION_REQUIRED'; end if;
  if v_followup.outcome='RETALIATION_CONCERN' and v_followup.linked_case_id is null then raise exception 'LINKED_CASE_REQUIRED'; end if;
  if v_followup.outcome='REMEDIATION_FAILURE' then raise exception 'REMEDIATION_ESCALATION_AUTO_RESOLVED'; end if;

  update public.case_followups set
    escalation_status='RESOLVED', escalation_resolved_by=p_actor_user_id, escalation_resolved_at=v_now,
    escalation_resolution_note=trim(p_resolution_note),
    escalation_resolution_mode=case when v_followup.outcome='RETALIATION_CONCERN' then 'LINKED_CASE' else 'MANUAL_RESOLUTION' end,
    updated_at=v_now
  where id=p_followup_id;

  insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
  values(p_organization_id,v_case.id,p_actor_user_id,'FOLLOWUP_ESCALATION_RESOLVED','case_followup',p_followup_id,
    jsonb_build_object('day_offset',v_followup.day_offset,'linked_case_id',v_followup.linked_case_id));

  return jsonb_build_object('ok',true,'linkedCaseId',v_followup.linked_case_id);
end;
$$;
revoke all on function public.resolve_case_followup_escalation(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.resolve_case_followup_escalation(uuid,uuid,uuid,text) to service_role;

create or replace function public.close_case_remediation(p_case_id uuid,p_actor_user_id uuid,p_organization_id uuid,p_internal_summary text,p_reporter_summary text)
returns jsonb
language plpgsql
security definer
set search_path='public','pg_temp'
as $$
declare
  v_case public.cases%rowtype;
  v_outcomes jsonb;
  v_active_allegations integer;
  v_findings integer;
  v_pending integer;
  v_now timestamptz := now();
  v_closure_id uuid;
  v_closure_no integer;
  v_day integer;
begin
  select * into v_case from public.cases where id=p_case_id and organization_id=p_organization_id for update;
  if not found then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.status <> 'REMEDIATION' then raise exception 'NOT_IN_REMEDIATION'; end if;
  if char_length(trim(p_internal_summary)) < 5 or char_length(trim(p_reporter_summary)) < 5 then raise exception 'SUMMARY_REQUIRED'; end if;

  select count(*) into v_pending from public.case_remediation_actions where case_id=p_case_id and status not in ('COMPLETED','WAIVED');
  if v_pending > 0 then raise exception 'PENDING_REMEDIATION'; end if;

  select count(*) into v_active_allegations from public.case_allegations where case_id=p_case_id and status='ACTIVE';
  select count(*) into v_findings from public.case_findings f join public.case_allegations a on a.id=f.allegation_id where f.case_id=p_case_id and a.case_id=p_case_id and a.status='ACTIVE';
  if v_active_allegations=0 or v_findings<>v_active_allegations then raise exception 'INCOMPLETE_FINDINGS'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('sequenceNo',a.sequence_no,'outcome',f.finding_status) order by a.sequence_no),'[]'::jsonb)
  into v_outcomes from public.case_allegations a join public.case_findings f on f.allegation_id=a.id and f.case_id=a.case_id where a.case_id=p_case_id and a.status='ACTIVE';

  select coalesce(max(closure_no),0)+1 into v_closure_no from public.case_closures where case_id=p_case_id;
  insert into public.case_closures(case_id,closure_no,closed_by,internal_summary,reporter_summary,reporter_outcomes,created_at)
  values(p_case_id,v_closure_no,p_actor_user_id,trim(p_internal_summary),trim(p_reporter_summary),v_outcomes,v_now)
  returning id into v_closure_id;

  update public.cases set status='CLOSED',closed_at=v_now,updated_at=v_now where id=p_case_id;
  insert into public.case_messages(case_id,sender_type,sender_user_id,body,visible_to_reporter,created_at)
  values(p_case_id,'SYSTEM',null,'Penanganan laporan telah selesai. '||trim(p_reporter_summary),true,v_now);

  foreach v_day in array array[30,60,90] loop
    insert into public.case_followups(case_id,closure_id,day_offset,due_at,status,created_at,updated_at)
    values(p_case_id,v_closure_id,v_day,v_now+make_interval(days=>v_day),'SCHEDULED',v_now,v_now);
  end loop;

  update public.case_assignments set access_status='REVOKED',revoked_at=v_now where case_id=p_case_id and access_status='ACTIVE';
  insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
  values(p_organization_id,p_case_id,p_actor_user_id,'CASE_CLOSED','case_closure',v_closure_id,jsonb_build_object('closure_no',v_closure_no,'followups',jsonb_build_array(30,60,90)));

  return jsonb_build_object('ok',true,'status','CLOSED','closureId',v_closure_id,'closureNo',v_closure_no,'reporterOutcomes',v_outcomes,'closedAt',v_now);
end;
$$;