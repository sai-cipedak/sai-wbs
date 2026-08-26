alter table public.system_role_conflicts enable row level security;
revoke all on public.system_role_conflicts from anon, authenticated;
grant all on public.system_role_conflicts to service_role;
