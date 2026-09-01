create or replace function public.verify_anonymous_access_atomic(p_case_id uuid,p_supplied_hash text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $function$
declare v_access public.case_anonymous_access%rowtype;v_failed integer;v_lock timestamptz;
begin
 select * into v_access from public.case_anonymous_access where case_id=p_case_id for update;
 if not found then return jsonb_build_object('ok',false,'code','INVALID_ACCESS');end if;
 if v_access.locked_until is not null and v_access.locked_until>now() then return jsonb_build_object('ok',false,'code','LOCKED');end if;
 if v_access.secret_hash<>coalesce(p_supplied_hash,'') then
  v_failed:=coalesce(v_access.failed_attempts,0)+1;v_lock:=case when v_failed>=5 then now()+interval '15 minutes' end;
  update public.case_anonymous_access set failed_attempts=case when v_failed>=5 then 0 else v_failed end,locked_until=v_lock where case_id=p_case_id;
  return jsonb_build_object('ok',false,'code','INVALID_ACCESS','locked',v_lock is not null);
 end if;
 update public.case_anonymous_access set failed_attempts=0,locked_until=null,last_used_at=now() where case_id=p_case_id;
 return jsonb_build_object('ok',true);
end $function$;
revoke all on function public.verify_anonymous_access_atomic(uuid,text) from public,anon,authenticated;
grant execute on function public.verify_anonymous_access_atomic(uuid,text) to service_role;
