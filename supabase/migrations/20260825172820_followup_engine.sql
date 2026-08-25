alter table public.case_followups
  add column if not exists check_method text,
  add column if not exists outcome text,
  add column if not exists risk_level text,
  add column if not exists escalation_required boolean not null default false,
  add column if not exists escalation_note text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.case_followups
  drop constraint if exists case_followups_check_method_check,
  add constraint case_followups_check_method_check
    check (check_method is null or check_method in ('INTERNAL_REVIEW','REPORTER_CHECK_IN','OTHER')),
  drop constraint if exists case_followups_outcome_check,
  add constraint case_followups_outcome_check
    check (outcome is null or outcome in ('NO_CONCERN','CONTINUE_MONITORING','RETALIATION_CONCERN','REMEDIATION_FAILURE','OTHER')),
  drop constraint if exists case_followups_risk_level_check,
  add constraint case_followups_risk_level_check
    check (risk_level is null or risk_level in ('LOW','MEDIUM','HIGH','CRITICAL'));

create index if not exists idx_case_followups_due_status
  on public.case_followups(status, due_at);

create index if not exists idx_case_followups_case_due
  on public.case_followups(case_id, due_at);

revoke all on public.case_followups from anon, authenticated;
