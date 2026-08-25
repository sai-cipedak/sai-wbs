alter table public.case_followups
  add column if not exists escalation_status text not null default 'NONE',
  add column if not exists escalation_resolved_by uuid references auth.users(id),
  add column if not exists escalation_resolved_at timestamptz,
  add column if not exists escalation_resolution_note text;

alter table public.case_followups
  drop constraint if exists case_followups_escalation_status_check,
  add constraint case_followups_escalation_status_check
    check (escalation_status in ('NONE','OPEN','RESOLVED'));

create index if not exists idx_case_followups_escalation_status
  on public.case_followups(escalation_status)
  where escalation_status = 'OPEN';
