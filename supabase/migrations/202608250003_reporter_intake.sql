-- SAI Cipedak WBS — Batch 2 reporter intake foundation

begin;

create table if not exists public.reporter_allowlist (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  member_type text not null check (member_type in ('OTS','STAFF')),
  is_active boolean not null default true,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, email)
);

create table if not exists public.community_access_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  label text not null,
  salt_b64 text not null,
  iterations integer not null check (iterations >= 100000),
  hash_b64 text not null,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.case_messages (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  sender_type text not null check (sender_type in ('REPORTER','INTERNAL','SYSTEM')),
  sender_user_id uuid references auth.users(id),
  body text not null check (char_length(body) between 1 and 10000),
  visible_to_reporter boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_reporter_allowlist_email on public.reporter_allowlist(lower(email)) where is_active;
create index if not exists idx_community_access_codes_active on public.community_access_codes(organization_id, is_active, valid_from);
create index if not exists idx_case_messages_case_time on public.case_messages(case_id, created_at);

alter table public.reporter_allowlist enable row level security;
alter table public.community_access_codes enable row level security;
alter table public.case_messages enable row level security;

revoke all on public.reporter_allowlist, public.community_access_codes from anon, authenticated;
revoke all on public.case_messages from anon;
grant select on public.case_messages to authenticated;
revoke insert, update, delete on public.case_messages from authenticated;

create policy case_messages_internal_select on public.case_messages
for select to authenticated
using (private.can_access_internal_case(case_id));

-- The initial community access code is seeded hashed only. Plaintext is never committed.
insert into public.community_access_codes(
  organization_id, label, salt_b64, iterations, hash_b64, valid_from, is_active
)
select id, 'MVP Pilot 2026', 'rNVLM8gOrk+odJUJI5b4vg==', 210000, 'kr6UQU1c8jPriQ/QiwcX6IHfewZE2pPkfRp3rUBbvPo=', now(), true
from public.organizations
where code = 'SAI-CIPEDAK'
  and not exists (
    select 1 from public.community_access_codes cac
    where cac.organization_id = public.organizations.id and cac.label = 'MVP Pilot 2026'
  );

commit;
