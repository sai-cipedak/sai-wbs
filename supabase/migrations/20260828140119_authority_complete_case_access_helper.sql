create or replace function private.can_access_internal_case(p_case_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_case public.cases%rowtype;
begin
  select * into v_case from public.cases where id = p_case_id;
  if not found then return false; end if;

  if private.is_active_case_assignee(p_case_id) then return true; end if;

  case v_case.authority_code
    when 'DEKOM' then
      return private.has_system_role('DEKOM', v_case.organization_id);
    when 'SECRETARIAT' then
      return private.has_system_role('SECRETARIAT', v_case.organization_id);
    when 'TRIAGE' then
      return private.has_any_system_role(array['TRIAGE','SECRETARIAT'], v_case.organization_id);
    when 'HSE' then
      return private.has_system_role('HSE', v_case.organization_id);
    when 'GRIEVANCE' then
      return private.has_system_role('GRIEVANCE_COORDINATOR', v_case.organization_id);
    else
      return false;
  end case;
end;
$function$;

revoke all on function private.can_access_internal_case(uuid) from public;
grant execute on function private.can_access_internal_case(uuid) to authenticated, service_role;
