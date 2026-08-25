create table if not exists public.case_triage_decisions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  reviewer_user_id uuid not null references auth.users(id),
  action text not null check (action in ('START_REVIEW','REQUEST_INFO','ROUTE_INTEGRITY','ROUTE_SAFEGUARDING','ROUTE_GRIEVANCE','ROUTE_DEKOM','CLOSE_OUT_OF_SCOPE')),
  classification text check (classification in ('INTEGRITY','SAFEGUARDING','GRIEVANCE','OUT_OF_SCOPE')),
  target_authority text check (target_authority in ('TRIAGE','SECRETARIAT','HSE','GRIEVANCE','DEKOM')),
  internal_reason text,
  reporter_explanation text,
  created_at timestamptz not null default now()
);

create index if not exists idx_case_triage_decisions_case on public.case_triage_decisions(case_id, created_at desc);
create index if not exists idx_case_triage_decisions_reviewer on public.case_triage_decisions(reviewer_user_id, created_at desc);

alter table public.case_triage_decisions enable row level security;
revoke all on table public.case_triage_decisions from anon;
revoke insert, update, delete on table public.case_triage_decisions from authenticated;
grant select on table public.case_triage_decisions to authenticated;

create policy case_triage_decisions_select on public.case_triage_decisions
for select to authenticated
using ((reviewer_user_id = (select auth.uid())) or private.can_access_internal_case(case_id));
