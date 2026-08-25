create table if not exists public.case_remediation_actions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  action_text text not null check (char_length(action_text) between 5 and 5000),
  owner_text text,
  due_date date,
  status text not null default 'PENDING' check (status in ('PENDING','IN_PROGRESS','COMPLETED','WAIVED')),
  completion_note text,
  created_by uuid references auth.users(id),
  completed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists case_remediation_actions_case_idx on public.case_remediation_actions(case_id, status);
alter table public.case_remediation_actions enable row level security;
revoke all on public.case_remediation_actions from anon, authenticated;

create table if not exists public.case_closures (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null unique references public.cases(id) on delete cascade,
  closed_by uuid not null references auth.users(id),
  internal_summary text not null check (char_length(internal_summary) between 5 and 10000),
  reporter_summary text not null check (char_length(reporter_summary) between 5 and 5000),
  reporter_outcomes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.case_closures enable row level security;
revoke all on public.case_closures from anon, authenticated;

create table if not exists public.case_followups (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  day_offset integer not null check (day_offset in (30,60,90)),
  due_at timestamptz not null,
  status text not null default 'SCHEDULED' check (status in ('SCHEDULED','COMPLETED','CANCELLED')),
  notes text,
  completed_by uuid references auth.users(id),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(case_id, day_offset)
);
create index if not exists case_followups_due_idx on public.case_followups(status, due_at);
alter table public.case_followups enable row level security;
revoke all on public.case_followups from anon, authenticated;
