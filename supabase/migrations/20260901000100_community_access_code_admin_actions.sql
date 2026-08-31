create or replace function public.admin_create_community_access_code(
  p_organization_id uuid,
  p_label text,
  p_salt_b64 text,
  p_iterations integer,
  p_hash_b64 text,
  p_valid_from timestamptz,
  p_valid_until timestamptz,
  p_created_by uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.community_access_codes%rowtype;
begin
  if p_organization_id is null or p_created_by is null then raise exception 'INVALID_CONTEXT'; end if;
  if char_length(trim(coalesce(p_label,''))) < 3 or char_length(trim(coalesce(p_label,''))) > 160 then raise exception 'INVALID_LABEL'; end if;
  if p_iterations < 100000 then raise exception 'INVALID_ITERATIONS'; end if;
  if coalesce(p_salt_b64,'') = '' or coalesce(p_hash_b64,'') = '' then raise exception 'INVALID_HASH'; end if;
  if p_valid_from is null or p_valid_until is null or p_valid_until <= p_valid_from then raise exception 'INVALID_VALIDITY'; end if;

  insert into public.community_access_codes(
    organization_id,label,salt_b64,iterations,hash_b64,valid_from,valid_until,is_active,created_by
  ) values (
    p_organization_id,trim(p_label),p_salt_b64,p_iterations,p_hash_b64,p_valid_from,p_valid_until,true,p_created_by
  ) returning * into v_row;

  insert into public.audit_logs(
    organization_id,actor_user_id,event_type,object_type,object_id,details
  ) values (
    p_organization_id,p_created_by,'COMMUNITY_ACCESS_CODE_CREATED','community_access_code',v_row.id,
    jsonb_build_object('label',v_row.label,'valid_from',v_row.valid_from,'valid_until',v_row.valid_until,'iterations',v_row.iterations)
  );

  return jsonb_build_object(
    'id',v_row.id,'label',v_row.label,'validFrom',v_row.valid_from,'validUntil',v_row.valid_until,'createdAt',v_row.created_at
  );
end;
$$;

create or replace function public.admin_revoke_community_access_code(
  p_organization_id uuid,
  p_code_id uuid,
  p_actor_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.community_access_codes%rowtype;
begin
  update public.community_access_codes
  set is_active=false
  where id=p_code_id and organization_id=p_organization_id and is_active=true
  returning * into v_row;

  if v_row.id is null then raise exception 'CODE_NOT_ACTIVE'; end if;

  insert into public.audit_logs(
    organization_id,actor_user_id,event_type,object_type,object_id,details
  ) values (
    p_organization_id,p_actor_user_id,'COMMUNITY_ACCESS_CODE_REVOKED','community_access_code',v_row.id,
    jsonb_build_object('label',v_row.label,'valid_from',v_row.valid_from,'valid_until',v_row.valid_until)
  );

  return jsonb_build_object('ok',true,'id',v_row.id,'label',v_row.label);
end;
$$;

revoke all on function public.admin_create_community_access_code(uuid,text,text,integer,text,timestamptz,timestamptz,uuid) from public, anon, authenticated;
revoke all on function public.admin_revoke_community_access_code(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.admin_create_community_access_code(uuid,text,text,integer,text,timestamptz,timestamptz,uuid) to service_role;
grant execute on function public.admin_revoke_community_access_code(uuid,uuid,uuid) to service_role;
