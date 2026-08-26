create table if not exists public.case_dekom_acknowledgements(
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  acknowledged_by uuid not null references auth.users(id),
  acknowledgement_note text not null check(char_length(acknowledgement_note) between 5 and 5000),
  acknowledged_at timestamptz not null default now(),
  unique(case_id)
);
alter table public.case_dekom_acknowledgements enable row level security;
revoke all on public.case_dekom_acknowledgements from anon, authenticated;
create index if not exists case_dekom_ack_by_idx on public.case_dekom_acknowledgements(acknowledged_by);

create or replace function public.acknowledge_dekom_takeover(
  p_case_id uuid,
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_note text
) returns jsonb
language plpgsql
security definer
set search_path='public','pg_temp'
as $$
declare
  v_case public.cases%rowtype;
  v_ack_id uuid;
  v_now timestamptz := now();
  v_source_followup public.case_followups%rowtype;
  v_source_case_id uuid;
begin
  select * into v_case from public.cases
   where id=p_case_id and organization_id=p_organization_id
   for update;
  if not found then raise exception 'CASE_NOT_FOUND'; end if;
  if v_case.authority_code <> 'DEKOM' then raise exception 'NOT_DEKOM_AUTHORITY'; end if;
  if v_case.status <> 'COMMITTEE_FORMATION' then raise exception 'INVALID_CASE_STATUS'; end if;
  if char_length(trim(coalesce(p_note,''))) < 5 or char_length(trim(coalesce(p_note,''))) > 5000 then raise exception 'ACK_NOTE_REQUIRED'; end if;

  insert into public.case_dekom_acknowledgements(case_id,acknowledged_by,acknowledgement_note,acknowledged_at)
  values(p_case_id,p_actor_user_id,trim(p_note),v_now)
  on conflict(case_id) do update set
    acknowledged_by=excluded.acknowledged_by,
    acknowledgement_note=excluded.acknowledgement_note,
    acknowledged_at=excluded.acknowledged_at
  returning id into v_ack_id;

  select f.* into v_source_followup
  from public.case_followups f
  where f.linked_case_id=p_case_id
  order by f.completed_at desc nulls last
  limit 1
  for update;

  if found then
    v_source_case_id := v_source_followup.case_id;
    if v_source_followup.escalation_status='OPEN' then
      update public.case_followups set
        escalation_status='RESOLVED',
        escalation_resolved_by=p_actor_user_id,
        escalation_resolved_at=v_now,
        escalation_resolution_note='Handoff formal ke Dekom telah diterima.',
        escalation_resolution_mode='LINKED_CASE',
        updated_at=v_now
      where id=v_source_followup.id;

      insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
      values(p_organization_id,v_source_case_id,p_actor_user_id,'FOLLOWUP_ESCALATION_RESOLVED_BY_DEKOM_ACK','case_followup',v_source_followup.id,
        jsonb_build_object('linked_case_id',p_case_id,'linked_public_case_id',v_case.public_case_id));
    end if;
  end if;

  insert into public.audit_logs(organization_id,case_id,actor_user_id,event_type,object_type,object_id,details)
  values(p_organization_id,p_case_id,p_actor_user_id,'DEKOM_TAKEOVER_ACKNOWLEDGED','case_dekom_acknowledgement',v_ack_id,
    jsonb_build_object('source_case_id',v_source_case_id));

  return jsonb_build_object('ok',true,'acknowledgementId',v_ack_id,'caseStatus',v_case.status,'sourceEscalationResolved',v_source_followup.id is not null);
end;
$$;
revoke all on function public.acknowledge_dekom_takeover(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.acknowledge_dekom_takeover(uuid,uuid,uuid,text) to service_role;
