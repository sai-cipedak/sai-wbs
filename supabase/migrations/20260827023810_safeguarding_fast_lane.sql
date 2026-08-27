create table if not exists public.case_safeguarding_assessments (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  assessed_by uuid not null references auth.users(id),
  immediate_danger boolean not null,
  risk_summary text not null,
  assessed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists idx_case_safeguarding_assessments_case on public.case_safeguarding_assessments(case_id, assessed_at desc);

create table if not exists public.case_protective_actions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  assessment_id uuid references public.case_safeguarding_assessments(id) on delete set null,
  action_text text not null,
  owner_text text,
  initiated_by uuid not null references auth.users(id),
  initiated_at timestamptz not null default now(),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','COMPLETED','CANCELLED')),
  completion_note text,
  completed_by uuid references auth.users(id),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_case_protective_actions_case on public.case_protective_actions(case_id, initiated_at desc);
create index if not exists idx_case_protective_actions_assessment on public.case_protective_actions(assessment_id);

alter table public.case_safeguarding_assessments enable row level security;
alter table public.case_protective_actions enable row level security;
revoke all on public.case_safeguarding_assessments from anon, authenticated;
revoke all on public.case_protective_actions from anon, authenticated;
grant select, insert, update, delete on public.case_safeguarding_assessments to service_role;
grant select, insert, update, delete on public.case_protective_actions to service_role;

comment on table public.case_safeguarding_assessments is 'Server-mediated safeguarding fast-lane risk assessments. Reporter identity is not stored here.';
comment on table public.case_protective_actions is 'Immediate protective measures recorded by HSE before normal safeguarding investigation proceeds when danger is active.';
