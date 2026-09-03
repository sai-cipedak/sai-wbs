-- Trigger functions are internal implementation details, not browser-callable RPCs.
-- Revoking EXECUTE does not disable their existing triggers; PostgreSQL checks the
-- privilege when a trigger is created, while runtime execution follows the trigger.

revoke all on function public.audit_integrity_team_activation()
  from public, anon, authenticated;

revoke all on function public.link_existing_case_team_member_account()
  from public, anon, authenticated;

grant execute on function public.audit_integrity_team_activation()
  to service_role;

grant execute on function public.link_existing_case_team_member_account()
  to service_role;
