-- SAI Cipedak WBS — normalize reporter allowlist uniqueness case-insensitively

create unique index if not exists uq_reporter_allowlist_org_lower_email
on public.reporter_allowlist (organization_id, lower(email));
