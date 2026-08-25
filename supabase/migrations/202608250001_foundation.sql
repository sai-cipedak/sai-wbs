-- SAI Cipedak WBS — Batch 1 Foundation & Security
-- PostgreSQL / Supabase migration

begin;

create extension if not exists pgcrypto;
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Core organization and identity model
-- -----------------------------------------------------------------------------

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  is_active boolean not null default true,
  active_policy_version_id bigint null,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id),
  display_name text,
  email text,
  member_type text not null check (member_type in ('OTS','STAFF','INTERNAL')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.system_roles (
  code text primary key,
  name_id text not null,
  description_id text,
  is_privileged boolean not null default false
);

create table if not exists public.user_system_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id),
  role_code text not null references public.system_roles(code),
  active_from timestamptz not null default now(),
  active_until timestamptz,
  granted_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique(user_id, organization_id, role_code)
);

-- -----------------------------------------------------------------------------
-- Policy versioning and editable routing configuration
-- -----------------------------------------------------------------------------

create table if not exists public.policy_versions (
  id bigserial primary key,
  organization_id uuid not null references public.organizations(id),
  version text not null,
  status text not null check (status in ('DRAFT','ACTIVE','RETIRED')) default 'DRAFT',
  effective_from date,
  effective_to date,
  settings jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  activated_by uuid references auth.users(id),
  activated_at timestamptz,
  unique(organization_id, version)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'organizations_active_policy_fk'
  ) then
    alter table public.organizations
      add constraint organizations_active_policy_fk
      foreign key (active_policy_version_id)
      references public.policy_versions(id)
      deferrable initially deferred;
  end if;
end $$;

create table if not exists public.routing_rules (
  id uuid primary key default gen_random_uuid(),
  policy_version_id bigint not null references public.policy_versions(id) on delete cascade,
  rule_code text not null,
  priority integer not null default 100,
  description_id text not null,
  condition jsonb not null default '{}'::jsonb,
  action jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(policy_version_id, rule_code)
);

create table if not exists public.app_settings (
  organization_id uuid not null references public.organizations(id),
  setting_key text not null,
  setting_value jsonb not null,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (organization_id, setting_key)
);

-- -----------------------------------------------------------------------------
-- Case core. Sensitive reporter narrative is intentionally separated from
-- metadata; reporter identity is separated again into its own restricted table.
-- -----------------------------------------------------------------------------

create table if not exists public.cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  public_case_id text not null unique,
  reporting_mode text not null check (reporting_mode in ('ANONYMOUS','IDENTIFIED')),
  status text not null default 'SUBMITTED' check (status in (
    'SUBMITTED',
    'UNDER_REVIEW',
    'MORE_INFO_REQUIRED',
    'REFERRED_GRIEVANCE',
    'REFERRED_SAFEGUARDING',
    'COMMITTEE_FORMATION',
    'INVESTIGATION',
    'AUTHORITY_REVIEW',
    'REMEDIATION',
    'CLOSED',
    'OUT_OF_SCOPE'
  )),
  classification text check (classification in ('INTEGRITY','SAFEGUARDING','GRIEVANCE','OUT_OF_SCOPE')),
  priority text check (priority in ('CRITICAL','HIGH','MEDIUM','LOW')),
  authority_code text not null default 'SECRETARIAT' check (authority_code in ('TRIAGE','SECRETARIAT','HSE','GRIEVANCE','DEKOM')),
  policy_version_id bigint not null references public.policy_versions(id),
  created_by_user_id uuid references auth.users(id),
  submitted_at timestamptz not null default now(),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.case_reports (
  case_id uuid primary key references public.cases(id) on delete cascade,
  title text not null,
  narrative text not null,
  incident_date date,
  incident_time_text text,
  location_text text,
  child_safety_risk boolean not null default false,
  ongoing_risk boolean not null default false,
  people_involved_text text,
  submitted_at timestamptz not null default now()
);

create table if not exists public.case_reporter_identities (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null unique references public.cases(id) on delete cascade,
  user_id uuid references auth.users(id),
  reporter_name text,
  reporter_email text,
  reporter_phone text,
  visibility_status text not null default 'HIDDEN' check (visibility_status in ('HIDDEN','REVEALED')),
  created_at timestamptz not null default now()
);

create table if not exists public.case_anonymous_access (
  case_id uuid primary key references public.cases(id) on delete cascade,
  secret_hash text not null,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Case scoped authorization and conflict declarations
-- -----------------------------------------------------------------------------

create table if not exists public.case_assignments (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  assignment_role text not null check (assignment_role in (
    'TRIAGE',
    'AUTHORITY',
    'CASE_LEAD',
    'INVESTIGATOR',
    'SUBJECT_MATTER_ADVISER',
    'HSE_HANDLER',
    'GRIEVANCE_HANDLER',
    'AUDITOR'
  )),
  access_status text not null default 'PENDING' check (access_status in ('PENDING','ACTIVE','REVOKED')),
  assigned_by uuid references auth.users(id),
  assigned_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique(case_id, user_id, assignment_role)
);

create table if not exists public.case_conflict_declarations (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  declaration text not null check (declaration in ('NO_CONFLICT','POSSIBLE_CONFLICT')),
  notes text,
  declared_at timestamptz not null default now(),
  unique(case_id, user_id)
);

-- -----------------------------------------------------------------------------
-- Google Drive evidence metadata only. No evidence bytes are stored here.
-- -----------------------------------------------------------------------------

create table if not exists public.case_evidence (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  drive_file_id text not null unique,
  drive_folder_id text,
  original_filename text not null,
  mime_type text,
  file_size_bytes bigint check (file_size_bytes is null or file_size_bytes >= 0),
  sha256_hash text,
  evidence_type text,
  description text,
  uploader_context text not null check (uploader_context in ('ANONYMOUS_REPORTER','IDENTIFIED_REPORTER','INTERNAL')),
  uploaded_by_user_id uuid references auth.users(id),
  status text not null default 'ACTIVE' check (status in ('ACTIVE','SUPERSEDED','QUARANTINED')),
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Append-only audit ledger. Do not copy PII/evidence content into details.
-- -----------------------------------------------------------------------------

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  case_id uuid references public.cases(id) on delete set null,
  actor_user_id uuid references auth.users(id),
  event_type text not null,
  object_type text,
  object_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_cases_org_status on public.cases(organization_id, status);
create index if not exists idx_cases_authority on public.cases(authority_code, status);
create index if not exists idx_case_assignments_user on public.case_assignments(user_id, access_status);
create index if not exists idx_case_assignments_case on public.case_assignments(case_id, access_status);
create index if not exists idx_case_evidence_case on public.case_evidence(case_id);
create index if not exists idx_audit_case_time on public.audit_logs(case_id, created_at desc);
create index if not exists idx_audit_org_time on public.audit_logs(organization_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Helper functions
-- -----------------------------------------------------------------------------

create or replace function private.generate_public_case_id(p_org_code text default 'SAI-CIP')
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  loop
    v_code := upper(p_org_code || '-' || to_char(now(), 'YY') || '-' || encode(gen_random_bytes(5), 'hex'));
    exit when not exists (select 1 from public.cases where public_case_id = v_code);
  end loop;
  return v_code;
end;
$$;

create or replace function private.has_system_role(p_role_code text, p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_system_roles usr
    where usr.user_id = auth.uid()
      and usr.organization_id = p_organization_id
      and usr.role_code = p_role_code
      and usr.active_from <= now()
      and (usr.active_until is null or usr.active_until > now())
  );
$$;

create or replace function private.has_any_system_role(p_role_codes text[], p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_system_roles usr
    where usr.user_id = auth.uid()
      and usr.organization_id = p_organization_id
      and usr.role_code = any(p_role_codes)
      and usr.active_from <= now()
      and (usr.active_until is null or usr.active_until > now())
  );
$$;

create or replace function private.is_active_case_assignee(p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.case_assignments ca
    where ca.case_id = p_case_id
      and ca.user_id = auth.uid()
      and ca.access_status = 'ACTIVE'
  );
$$;

create or replace function private.can_access_internal_case(p_case_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_case public.cases%rowtype;
begin
  select * into v_case from public.cases where id = p_case_id;
  if not found then return false; end if;

  if private.is_active_case_assignee(p_case_id) then
    return true;
  end if;

  if v_case.authority_code = 'DEKOM' then
    return private.has_system_role('DEKOM', v_case.organization_id);
  end if;

  if v_case.authority_code = 'SECRETARIAT' then
    return private.has_system_role('SECRETARIAT', v_case.organization_id);
  end if;

  if v_case.authority_code = 'TRIAGE' then
    return private.has_any_system_role(array['TRIAGE','SECRETARIAT'], v_case.organization_id);
  end if;

  return false;
end;
$$;

create or replace function private.record_audit_event(
  p_organization_id uuid,
  p_case_id uuid,
  p_actor_user_id uuid,
  p_event_type text,
  p_object_type text default null,
  p_object_id text default null,
  p_details jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.audit_logs(
    organization_id, case_id, actor_user_id, event_type, object_type, object_id, details
  ) values (
    p_organization_id, p_case_id, p_actor_user_id, p_event_type, p_object_type, p_object_id,
    coalesce(p_details, '{}'::jsonb)
  ) returning id into v_id;
  return v_id;
end;
$$;

-- Do not expose security-definer audit write or case ID generator to client roles.
revoke all on function private.record_audit_event(uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function private.generate_public_case_id(text) from public, anon, authenticated;
grant execute on function private.record_audit_event(uuid, uuid, uuid, text, text, text, jsonb) to service_role;
grant execute on function private.generate_public_case_id(text) to service_role;

revoke all on function private.has_system_role(text, uuid) from public, anon;
revoke all on function private.has_any_system_role(text[], uuid) from public, anon;
revoke all on function private.is_active_case_assignee(uuid) from public, anon;
revoke all on function private.can_access_internal_case(uuid) from public, anon;
grant execute on function private.has_system_role(text, uuid) to authenticated, service_role;
grant execute on function private.has_any_system_role(text[], uuid) to authenticated, service_role;
grant execute on function private.is_active_case_assignee(uuid) to authenticated, service_role;
grant execute on function private.can_access_internal_case(uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.system_roles enable row level security;
alter table public.user_system_roles enable row level security;
alter table public.policy_versions enable row level security;
alter table public.routing_rules enable row level security;
alter table public.app_settings enable row level security;
alter table public.cases enable row level security;
alter table public.case_reports enable row level security;
alter table public.case_reporter_identities enable row level security;
alter table public.case_anonymous_access enable row level security;
alter table public.case_assignments enable row level security;
alter table public.case_conflict_declarations enable row level security;
alter table public.case_evidence enable row level security;
alter table public.audit_logs enable row level security;

-- Explicitly remove broad anonymous access.
revoke all on all tables in schema public from anon;

-- Internal authenticated users only get the minimum direct table grants needed.
grant select on public.organizations, public.system_roles to authenticated;
grant select on public.profiles, public.user_system_roles to authenticated;
grant select on public.cases, public.case_reports, public.case_assignments,
  public.case_conflict_declarations, public.case_evidence to authenticated;
grant select on public.policy_versions, public.routing_rules, public.app_settings to authenticated;
grant select on public.audit_logs to authenticated;

-- Identity and anonymous credential tables are service-side only.
revoke all on public.case_reporter_identities from authenticated;
revoke all on public.case_anonymous_access from authenticated;

-- Client roles are read-only on foundation/reference data unless a later batch
-- intentionally exposes a narrowly scoped write path.
revoke insert, update, delete on public.organizations, public.profiles, public.system_roles,
  public.user_system_roles, public.policy_versions, public.routing_rules, public.app_settings
  from authenticated;

-- Evidence metadata mutations and case workflow mutations are server-side in V1.
revoke insert, update, delete on public.cases, public.case_reports, public.case_assignments,
  public.case_conflict_declarations, public.case_evidence from authenticated;

-- Audit ledger cannot be mutated by client roles.
revoke insert, update, delete on public.audit_logs from authenticated;

-- Organizations: authenticated users can read their own organization; governance roles can too.
create policy organizations_select on public.organizations
for select to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.organization_id = organizations.id and p.is_active
  )
);

-- Profile: own profile, or governance/admin users in same organization.
create policy profiles_select on public.profiles
for select to authenticated
using (
  user_id = auth.uid()
  or private.has_any_system_role(array['SECRETARIAT','DEKOM','POLICY_ADMIN','SYSTEM_ADMIN'], organization_id)
);

create policy system_roles_select on public.system_roles
for select to authenticated
using (true);

create policy user_system_roles_select on public.user_system_roles
for select to authenticated
using (
  user_id = auth.uid()
  or private.has_any_system_role(array['POLICY_ADMIN','SYSTEM_ADMIN','DEKOM'], organization_id)
);

-- Policy/routing/settings visible only to governance/config roles.
create policy policy_versions_select on public.policy_versions
for select to authenticated
using (private.has_any_system_role(array['SECRETARIAT','DEKOM','POLICY_ADMIN','AUDITOR'], organization_id));

create policy routing_rules_select on public.routing_rules
for select to authenticated
using (
  exists (
    select 1 from public.policy_versions pv
    where pv.id = routing_rules.policy_version_id
      and private.has_any_system_role(array['SECRETARIAT','DEKOM','POLICY_ADMIN','AUDITOR'], pv.organization_id)
  )
);

create policy app_settings_select on public.app_settings
for select to authenticated
using (private.has_any_system_role(array['SECRETARIAT','DEKOM','POLICY_ADMIN','SYSTEM_ADMIN'], organization_id));

-- Internal case tables: no reporter direct read. Reporter-facing views/endpoints come later.
create policy cases_internal_select on public.cases
for select to authenticated
using (private.can_access_internal_case(id));

create policy case_reports_internal_select on public.case_reports
for select to authenticated
using (private.can_access_internal_case(case_id));

create policy case_assignments_select on public.case_assignments
for select to authenticated
using (
  user_id = auth.uid()
  or private.can_access_internal_case(case_id)
);

create policy conflict_declarations_select on public.case_conflict_declarations
for select to authenticated
using (
  user_id = auth.uid()
  or private.can_access_internal_case(case_id)
);

create policy evidence_metadata_select on public.case_evidence
for select to authenticated
using (private.can_access_internal_case(case_id));

create policy audit_logs_select on public.audit_logs
for select to authenticated
using (
  private.has_system_role('AUDITOR', organization_id)
  or private.has_system_role('DEKOM', organization_id)
  or (case_id is not null and private.can_access_internal_case(case_id))
);

-- -----------------------------------------------------------------------------
-- Seed baseline roles, organization, policy, routing rules, and app settings.
-- -----------------------------------------------------------------------------

insert into public.system_roles(code, name_id, description_id, is_privileged) values
  ('TRIAGE', 'Penelaah Awal', 'Cluster Lead Komunitas yang melakukan penelaahan awal.', true),
  ('SECRETARIAT', 'Sekretariat DS', 'Ketua Umum, Ketua Harian, Sekretaris, dan Bendahara DS.', true),
  ('HSE', 'Otoritas Perlindungan', 'Cluster Lead HSE untuk keselamatan dan perlindungan anak.', true),
  ('GRIEVANCE_COORDINATOR', 'Koordinator Pengaduan', 'Cluster Lead Sarpras sebagai koordinator default pengaduan layanan.', true),
  ('DEKOM', 'Dewan Komunitas', 'Otoritas tertinggi dan pengambilalihan kasus tertentu.', true),
  ('POLICY_ADMIN', 'Administrator Kebijakan', 'Mengelola konfigurasi kebijakan dan routing.', true),
  ('SYSTEM_ADMIN', 'Administrator Sistem', 'Mengelola aspek teknis tanpa otomatis mengakses isi kasus.', true),
  ('AUDITOR', 'Auditor', 'Akses audit sesuai mandat.', true)
on conflict (code) do update set
  name_id = excluded.name_id,
  description_id = excluded.description_id,
  is_privileged = excluded.is_privileged;

insert into public.organizations(code, name)
values ('SAI-CIPEDAK', 'Sekolah Alam Indonesia Cipedak')
on conflict (code) do update set name = excluded.name;

with org as (
  select id from public.organizations where code = 'SAI-CIPEDAK'
)
insert into public.policy_versions(
  organization_id, version, status, effective_from, settings, activated_at
)
select
  org.id,
  '1.0',
  'ACTIVE',
  current_date,
  jsonb_build_object(
    'triage_business_days', 3,
    'critical_safeguarding_same_day', true,
    'committee_formation_business_days', 5,
    'normal_resolution_calendar_days', 30,
    'complex_extension_calendar_days', 30,
    'sla_warning_days', 3,
    'committee_min_members', 2,
    'follow_up_days', jsonb_build_array(30,60,90),
    'retention_years', 5,
    'anonymous_reporting_enabled', true,
    'reporter_identity_default_hidden', true,
    'conflict_declaration_required', true,
    'two_person_review_required', true,
    'appeal_enabled', true,
    'appeal_window_days', 14
  ),
  now()
from org
on conflict (organization_id, version) do nothing;

update public.organizations o
set active_policy_version_id = pv.id
from public.policy_versions pv
where pv.organization_id = o.id
  and o.code = 'SAI-CIPEDAK'
  and pv.version = '1.0';

insert into public.routing_rules(policy_version_id, rule_code, priority, description_id, condition, action)
select pv.id, x.rule_code, x.priority, x.description_id, x.condition, x.action
from public.policy_versions pv
join public.organizations o on o.id = pv.organization_id and o.code = 'SAI-CIPEDAK'
cross join lateral (
  values
    ('DEKOM_SECRETARIAT_SUBJECT', 10, 'Jika pihak yang dilaporkan adalah anggota Sekretariat DS, kasus diambil alih Dekom.',
      '{"subject_role":"SECRETARIAT"}'::jsonb, '{"authority":"DEKOM","takeover":true}'::jsonb),
    ('DEKOM_CHAIR_SUBJECT', 11, 'Jika pihak yang dilaporkan adalah Ketua Umum DS, kasus diambil alih Dekom.',
      '{"subject_role":"DS_CHAIR"}'::jsonb, '{"authority":"DEKOM","takeover":true}'::jsonb),
    ('DEKOM_DS_INSTITUTION', 12, 'Jika DS sebagai institusi menjadi pihak yang dilaporkan, kasus diambil alih Dekom.',
      '{"subject_role":"DS_INSTITUTION"}'::jsonb, '{"authority":"DEKOM","takeover":true}'::jsonb),
    ('DEKOM_MANAGEMENT_LEAD', 13, 'Jika pimpinan Management menjadi pihak yang dilaporkan, kasus diambil alih Dekom.',
      '{"subject_role":"MANAGEMENT_LEAD"}'::jsonb, '{"authority":"DEKOM","takeover":true}'::jsonb),
    ('DEKOM_HEAD_OFFICE', 14, 'Jika Head Office atau SAI Holding menjadi pihak yang dilaporkan, kasus diambil alih Dekom.',
      '{"subject_role":"HEAD_OFFICE"}'::jsonb, '{"authority":"DEKOM","takeover":true}'::jsonb),
    ('SAFEGUARDING_HSE', 20, 'Laporan keselamatan dan perlindungan anak diarahkan ke Cluster Lead HSE.',
      '{"classification":"SAFEGUARDING"}'::jsonb, '{"authority":"HSE"}'::jsonb),
    ('GRIEVANCE_COORDINATOR', 30, 'Pengaduan layanan diarahkan ke koordinator pengaduan default.',
      '{"classification":"GRIEVANCE"}'::jsonb, '{"authority":"GRIEVANCE"}'::jsonb),
    ('NORMAL_INTEGRITY', 100, 'Kasus integritas normal menggunakan Sekretariat DS sebagai otoritas governance.',
      '{"classification":"INTEGRITY"}'::jsonb, '{"authority":"SECRETARIAT"}'::jsonb)
) as x(rule_code, priority, description_id, condition, action)
where pv.version = '1.0'
on conflict (policy_version_id, rule_code) do nothing;

insert into public.app_settings(organization_id, setting_key, setting_value)
select id, 'portal_branding', '{"portal_name":"Portal Pelaporan SAI Cipedak","language":"id"}'::jsonb
from public.organizations where code = 'SAI-CIPEDAK'
on conflict (organization_id, setting_key) do nothing;

insert into public.app_settings(organization_id, setting_key, setting_value)
select id, 'evidence_repository', '{"provider":"GOOGLE_DRIVE","public_links_allowed":false}'::jsonb
from public.organizations where code = 'SAI-CIPEDAK'
on conflict (organization_id, setting_key) do nothing;

commit;
