alter table public.case_evidence drop constraint if exists case_evidence_status_check;
alter table public.case_evidence add constraint case_evidence_status_check check (status in ('ACTIVE','SUPERSEDED','QUARANTINED','REMOVED'));
alter table public.case_evidence add constraint case_evidence_removed_scope_check check (status <> 'REMOVED' or access_scope='AUTHORITY_ONLY');
