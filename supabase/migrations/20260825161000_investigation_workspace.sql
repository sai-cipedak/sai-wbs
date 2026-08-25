create table if not exists public.case_allegations (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  sequence_no integer not null check (sequence_no > 0),
  statement text not null check (char_length(trim(statement)) between 5 and 2000),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','WITHDRAWN')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(case_id, sequence_no)
);

create table if not exists public.case_investigation_notes (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  author_user_id uuid not null references auth.users(id),
  note_type text not null default 'GENERAL' check (note_type in ('GENERAL','INTERVIEW','EVIDENCE','ANALYSIS')),
  title text null check (title is null or char_length(title) <= 240),
  body text not null check (char_length(trim(body)) between 3 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.case_findings (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  allegation_id uuid not null references public.case_allegations(id) on delete cascade,
  finding_status text not null check (finding_status in ('PROVEN','PARTIALLY_PROVEN','NOT_PROVEN','INCONCLUSIVE','NOT_EXAMINABLE','OUT_OF_SCOPE')),
  analysis_text text not null check (char_length(trim(analysis_text)) between 20 and 10000),
  recommendation_text text null check (recommendation_text is null or char_length(recommendation_text) <= 5000),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(case_id, allegation_id)
);

create index if not exists case_allegations_case_idx on public.case_allegations(case_id, sequence_no);
create index if not exists case_investigation_notes_case_idx on public.case_investigation_notes(case_id, created_at);
create index if not exists case_findings_case_idx on public.case_findings(case_id);

alter table public.case_allegations enable row level security;
alter table public.case_investigation_notes enable row level security;
alter table public.case_findings enable row level security;

revoke all on public.case_allegations from anon, authenticated;
revoke all on public.case_investigation_notes from anon, authenticated;
revoke all on public.case_findings from anon, authenticated;