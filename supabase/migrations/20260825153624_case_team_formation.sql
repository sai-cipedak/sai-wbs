create table public.case_team_members (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  email text not null,
  display_name text,
  member_category text not null check (member_category in ('DS','MANAGEMENT','STAFF','OTS','EXTERNAL')),
  committee_role text not null check (committee_role in ('CASE_LEAD','INVESTIGATOR','SUBJECT_MATTER_ADVISER')),
  rationale text not null,
  conflict_context text,
  linked_user_id uuid references auth.users(id) on delete set null,
  nomination_status text not null default 'PENDING_ACCOUNT' check (nomination_status in ('PENDING_ACCOUNT','PENDING_DECLARATION','CLEARED','CONFLICT','REVOKED')),
  nominated_by uuid not null references auth.users(id),
  nominated_at timestamptz not null default now(),
  declaration_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index case_team_members_case_email_active_ux
  on public.case_team_members(case_id, lower(email))
  where nomination_status <> 'REVOKED';
create index case_team_members_case_idx on public.case_team_members(case_id, nomination_status);
create index case_team_members_user_idx on public.case_team_members(linked_user_id, nomination_status);

alter table public.case_team_members enable row level security;
revoke all on public.case_team_members from anon, authenticated;
grant select on public.case_team_members to service_role;

comment on table public.case_team_members is 'Case-scoped Tim Pemeriksa nominations. Client access is server-mediated only.';
comment on column public.case_team_members.conflict_context is 'Minimal context shown to a nominated member before case access solely to support conflict declaration.';
