create or replace function public.admin_access_mutation_atomic(
 p_action text,p_actor_user_id uuid,p_organization_id uuid,p_user_id uuid default null,p_role_code text default null,
 p_is_active boolean default null,p_email text default null,p_member_type text default null,p_notes text default null,
 p_active_until timestamptz default null,p_object_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $function$
declare v_now timestamptz:=now();v_id uuid;v_row record;v_count integer;v_email text:=lower(trim(coalesce(p_email,'')));v_claim_until timestamptz;
begin
 perform 1 from public.organizations where id=p_organization_id for update;if not found then raise exception 'ORG_NOT_FOUND';end if;
 if not exists(select 1 from public.profiles p join public.user_system_roles r on r.user_id=p_actor_user_id and r.organization_id=p.organization_id where p.user_id=p_actor_user_id and p.organization_id=p_organization_id and p.is_active and r.role_code='SYSTEM_ADMIN' and r.active_from<=v_now and (r.active_until is null or r.active_until>v_now)) then raise exception 'FORBIDDEN';end if;
 if p_action='GRANT_ROLE' then
  if not exists(select 1 from public.system_roles where code=p_role_code) then raise exception 'INVALID_ROLE';end if;
  if not exists(select 1 from public.profiles where user_id=p_user_id and organization_id=p_organization_id) then raise exception 'PROFILE_NOT_FOUND';end if;
  if not exists(select 1 from public.profiles where user_id=p_user_id and organization_id=p_organization_id and is_active) then raise exception 'PROFILE_INACTIVE';end if;
  insert into public.user_system_roles(user_id,organization_id,role_code,active_from,active_until,granted_by) values(p_user_id,p_organization_id,p_role_code,v_now,null,p_actor_user_id)
  on conflict(user_id,organization_id,role_code) do update set active_from=v_now,active_until=null,granted_by=p_actor_user_id returning id into v_id;
  insert into public.audit_logs(organization_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_actor_user_id,'SYSTEM_ROLE_GRANTED','user_system_role',v_id,jsonb_build_object('target_user_id',p_user_id,'role_code',p_role_code));
 elsif p_action='REVOKE_ROLE' then
  select id into v_id from public.user_system_roles where user_id=p_user_id and organization_id=p_organization_id and role_code=p_role_code and active_from<=v_now and (active_until is null or active_until>v_now) for update;if not found then raise exception 'ROLE_NOT_FOUND';end if;
  if p_role_code='SYSTEM_ADMIN' then select count(*) into v_count from public.user_system_roles where organization_id=p_organization_id and role_code='SYSTEM_ADMIN' and active_from<=v_now and (active_until is null or active_until>v_now);if v_count<=1 then raise exception 'LAST_ADMIN';end if;end if;
  update public.user_system_roles set active_until=v_now where id=v_id;
  insert into public.audit_logs(organization_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_actor_user_id,'SYSTEM_ROLE_REVOKED','user_system_role',v_id,jsonb_build_object('target_user_id',p_user_id,'role_code',p_role_code));
 elsif p_action='SET_PROFILE_ACTIVE' then
  perform 1 from public.profiles where user_id=p_user_id and organization_id=p_organization_id for update;if not found then raise exception 'PROFILE_NOT_FOUND';end if;
  if not coalesce(p_is_active,false) and exists(select 1 from public.user_system_roles where user_id=p_user_id and organization_id=p_organization_id and role_code='SYSTEM_ADMIN' and active_from<=v_now and (active_until is null or active_until>v_now)) then select count(*) into v_count from public.user_system_roles where organization_id=p_organization_id and role_code='SYSTEM_ADMIN' and active_from<=v_now and (active_until is null or active_until>v_now);if v_count<=1 then raise exception 'LAST_ADMIN';end if;end if;
  update public.profiles set is_active=coalesce(p_is_active,false),updated_at=v_now where user_id=p_user_id and organization_id=p_organization_id;
  if not coalesce(p_is_active,false) then update public.user_system_roles set active_until=v_now where user_id=p_user_id and organization_id=p_organization_id and active_from<=v_now and (active_until is null or active_until>v_now);end if;
  insert into public.audit_logs(organization_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_actor_user_id,case when p_is_active then 'USER_PROFILE_ACTIVATED' else 'USER_PROFILE_DEACTIVATED' end,'profile',p_user_id,jsonb_build_object('target_user_id',p_user_id));
 elsif p_action='CREATE_PENDING_GRANT' then
  if v_email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or not exists(select 1 from public.system_roles where code=p_role_code) then raise exception 'INVALID_INVITATION';end if;
  perform public.expire_pending_system_role_grants(p_organization_id,v_email);
  if exists(select 1 from public.profiles where organization_id=p_organization_id and email=v_email) then raise exception 'PROFILE_EXISTS';end if;
  if exists(select 1 from public.pending_system_role_grants g join public.system_role_conflicts c on c.role_code_a=least(g.role_code,p_role_code) and c.role_code_b=greatest(g.role_code,p_role_code) where g.organization_id=p_organization_id and g.email=v_email and g.status='PENDING' and g.role_code<>p_role_code) then raise exception 'PENDING_ROLE_CONFLICT';end if;
  insert into public.pending_system_role_grants(organization_id,email,role_code,status,active_from,active_until,granted_by) values(p_organization_id,v_email,p_role_code,'PENDING',v_now,p_active_until,p_actor_user_id) returning id,claim_until into v_id,v_claim_until;
  insert into public.audit_logs(organization_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_actor_user_id,'PENDING_SYSTEM_ROLE_GRANT_CREATED','pending_system_role_grant',v_id,jsonb_build_object('email',v_email,'role_code',p_role_code,'claim_until',v_claim_until));
  return jsonb_build_object('ok',true,'grantId',v_id,'claimUntil',v_claim_until);
 elsif p_action='REVOKE_PENDING_GRANT' then
  update public.pending_system_role_grants set status='REVOKED',revoked_by=p_actor_user_id,revoked_at=v_now,updated_at=v_now where id=p_object_id and organization_id=p_organization_id and status='PENDING' returning id,email,role_code into v_id,v_email,p_role_code;if not found then raise exception 'PENDING_GRANT_NOT_FOUND';end if;
  insert into public.audit_logs(organization_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_actor_user_id,'PENDING_SYSTEM_ROLE_GRANT_REVOKED','pending_system_role_grant',v_id,jsonb_build_object('email',v_email,'role_code',p_role_code));
 elsif p_action='UPSERT_REPORTER_ALLOWLIST' then
  if v_email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or p_member_type not in ('OTS','STAFF') or char_length(coalesce(p_notes,''))>2000 then raise exception 'INVALID_ALLOWLIST';end if;
  insert into public.reporter_allowlist(organization_id,email,member_type,is_active,notes,created_by,updated_at) values(p_organization_id,v_email,p_member_type,true,nullif(trim(p_notes),''),p_actor_user_id,v_now)
  on conflict(organization_id,email) do update set member_type=excluded.member_type,is_active=true,notes=excluded.notes,updated_at=v_now returning id into v_id;
  insert into public.audit_logs(organization_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_actor_user_id,'REPORTER_ALLOWLIST_GRANTED','reporter_allowlist',v_id,jsonb_build_object('email',v_email,'member_type',p_member_type));
 elsif p_action='REVOKE_REPORTER_ALLOWLIST' then
  update public.reporter_allowlist set is_active=false,updated_at=v_now where id=p_object_id and organization_id=p_organization_id and is_active returning id,email,member_type into v_id,v_email,p_member_type;if not found then raise exception 'ALLOWLIST_NOT_FOUND';end if;
  insert into public.audit_logs(organization_id,actor_user_id,event_type,object_type,object_id,details) values(p_organization_id,p_actor_user_id,'REPORTER_ALLOWLIST_REVOKED','reporter_allowlist',v_id,jsonb_build_object('email',v_email,'member_type',p_member_type));
 else raise exception 'INVALID_ACTION';end if;
 return jsonb_build_object('ok',true);
end $function$;
revoke all on function public.admin_access_mutation_atomic(text,uuid,uuid,uuid,text,boolean,text,text,text,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.admin_access_mutation_atomic(text,uuid,uuid,uuid,text,boolean,text,text,text,timestamptz,uuid) to service_role;
