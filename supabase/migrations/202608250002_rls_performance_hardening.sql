-- SAI Cipedak WBS — RLS performance hardening
-- Avoid per-row auth.uid() re-evaluation in RLS predicates.

begin;

drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations
for select to authenticated
using (
  exists (
    select 1 from public.profiles p
    where p.user_id = (select auth.uid())
      and p.organization_id = organizations.id
      and p.is_active
  )
);

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
for select to authenticated
using (
  user_id = (select auth.uid())
  or private.has_any_system_role(array['SECRETARIAT','DEKOM','POLICY_ADMIN','SYSTEM_ADMIN'], organization_id)
);

drop policy if exists user_system_roles_select on public.user_system_roles;
create policy user_system_roles_select on public.user_system_roles
for select to authenticated
using (
  user_id = (select auth.uid())
  or private.has_any_system_role(array['POLICY_ADMIN','SYSTEM_ADMIN','DEKOM'], organization_id)
);

drop policy if exists case_assignments_select on public.case_assignments;
create policy case_assignments_select on public.case_assignments
for select to authenticated
using (
  user_id = (select auth.uid())
  or private.can_access_internal_case(case_id)
);

drop policy if exists conflict_declarations_select on public.case_conflict_declarations;
create policy conflict_declarations_select on public.case_conflict_declarations
for select to authenticated
using (
  user_id = (select auth.uid())
  or private.can_access_internal_case(case_id)
);

commit;
