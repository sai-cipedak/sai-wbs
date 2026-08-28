create table if not exists public.case_evidence_folders (
  case_id uuid primary key references public.cases(id) on delete cascade,
  drive_folder_id text not null unique,
  folder_token uuid not null default gen_random_uuid() unique,
  created_by_user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.case_evidence_folders enable row level security;
revoke all on table public.case_evidence_folders from anon, authenticated;
grant all on table public.case_evidence_folders to service_role;

create table if not exists public.case_evidence_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  drive_file_id text not null unique,
  drive_folder_id text not null,
  storage_filename text not null,
  original_filename text not null,
  mime_type text not null,
  file_size_bytes bigint not null check (file_size_bytes > 0),
  sha256_hash text,
  uploader_context text not null check (uploader_context in ('ANONYMOUS_REPORTER','IDENTIFIED_REPORTER','INTERNAL')),
  uploaded_by_user_id uuid references auth.users(id),
  access_scope text not null default 'AUTHORITY_ONLY' check (access_scope in ('AUTHORITY_ONLY','INVESTIGATION_TEAM')),
  review_state text not null default 'PENDING_REVIEW' check (review_state in ('PENDING_REVIEW','CLEARED','RESTRICTED')),
  status text not null default 'INITIATED' check (status in ('INITIATED','UPLOADED','FINALIZED','FAILED','EXPIRED')),
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint case_evidence_upload_sessions_sha256_check check (sha256_hash is null or sha256_hash ~ '^[0-9a-fA-F]{64}$'),
  constraint case_evidence_upload_sessions_user_context_check check (
    (uploader_context='ANONYMOUS_REPORTER' and uploaded_by_user_id is null)
    or (uploader_context in ('IDENTIFIED_REPORTER','INTERNAL') and uploaded_by_user_id is not null)
  ),
  constraint case_evidence_upload_sessions_scope_review_check check (access_scope <> 'INVESTIGATION_TEAM' or review_state='CLEARED')
);

create index if not exists idx_case_evidence_upload_sessions_case on public.case_evidence_upload_sessions(case_id, created_at desc);
create index if not exists idx_case_evidence_upload_sessions_expiry on public.case_evidence_upload_sessions(status, expires_at);
alter table public.case_evidence_upload_sessions enable row level security;
revoke all on table public.case_evidence_upload_sessions from anon, authenticated;
grant all on table public.case_evidence_upload_sessions to service_role;

alter table public.case_evidence
  add column if not exists storage_filename text,
  add column if not exists access_scope text not null default 'AUTHORITY_ONLY',
  add column if not exists review_state text not null default 'PENDING_REVIEW',
  add column if not exists reviewed_by_user_id uuid references auth.users(id),
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text,
  add column if not exists last_verified_at timestamptz;

alter table public.case_evidence alter column drive_folder_id set not null;
alter table public.case_evidence alter column mime_type set not null;
alter table public.case_evidence alter column file_size_bytes set not null;
alter table public.case_evidence alter column evidence_type set not null;
alter table public.case_evidence alter column storage_filename set not null;

alter table public.case_evidence
  add constraint case_evidence_storage_filename_length_check check (char_length(storage_filename) between 1 and 255),
  add constraint case_evidence_original_filename_length_check check (char_length(original_filename) between 1 and 255),
  add constraint case_evidence_mime_type_length_check check (char_length(mime_type) between 1 and 255),
  add constraint case_evidence_sha256_format_check check (sha256_hash is null or sha256_hash ~ '^[0-9a-fA-F]{64}$'),
  add constraint case_evidence_type_check check (evidence_type in ('DOCUMENT','IMAGE','AUDIO','VIDEO','OTHER')),
  add constraint case_evidence_access_scope_check check (access_scope in ('AUTHORITY_ONLY','INVESTIGATION_TEAM')),
  add constraint case_evidence_review_state_check check (review_state in ('PENDING_REVIEW','CLEARED','RESTRICTED')),
  add constraint case_evidence_user_context_check check (
    (uploader_context='ANONYMOUS_REPORTER' and uploaded_by_user_id is null)
    or (uploader_context in ('IDENTIFIED_REPORTER','INTERNAL') and uploaded_by_user_id is not null)
  ),
  add constraint case_evidence_scope_review_check check (access_scope <> 'INVESTIGATION_TEAM' or review_state='CLEARED'),
  add constraint case_evidence_restricted_scope_check check (review_state <> 'RESTRICTED' or access_scope='AUTHORITY_ONLY'),
  add constraint case_evidence_quarantine_scope_check check (status <> 'QUARANTINED' or access_scope='AUTHORITY_ONLY');

create index if not exists idx_case_evidence_case_scope on public.case_evidence(case_id, access_scope, review_state, status);

revoke all on table public.case_evidence from anon, authenticated;
grant all on table public.case_evidence to service_role;

insert into public.app_settings(organization_id,setting_key,setting_value,updated_at)
select o.id,'evidence_policy',jsonb_build_object(
  'provider','GOOGLE_DRIVE',
  'direct_resumable_upload',true,
  'public_links_allowed',false,
  'max_file_size_bytes',104857600,
  'sha256_client_max_bytes',26214400,
  'max_active_files_per_case',30,
  'allowed_mime_types',jsonb_build_array(
    'application/pdf','text/plain',
    'image/jpeg','image/png','image/webp','image/heic','image/heif',
    'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'audio/mpeg','audio/mp4','audio/x-m4a','audio/wav','audio/webm',
    'video/mp4','video/quicktime','video/webm'
  ),
  'reporter_default_access_scope','AUTHORITY_ONLY',
  'reporter_default_review_state','PENDING_REVIEW'
),now()
from public.organizations o
where o.code='SAI-CIPEDAK'
on conflict (organization_id,setting_key) do update set setting_value=excluded.setting_value,updated_at=now();
