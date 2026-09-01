create or replace function public.send_identified_reporter_message_atomic(
  p_case_id uuid,
  p_actor_user_id uuid,
  p_message text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_case public.cases%rowtype;
  v_message public.case_messages%rowtype;
  v_body text := trim(coalesce(p_message, ''));
begin
  if char_length(v_body) < 5 or char_length(v_body) > 5000 then raise exception 'INVALID_MESSAGE'; end if;

  select * into v_case from public.cases where id = p_case_id for update;
  if not found or v_case.reporting_mode <> 'IDENTIFIED' or v_case.created_by_user_id <> p_actor_user_id then
    raise exception 'CASE_NOT_FOUND';
  end if;
  if v_case.status in ('CLOSED', 'OUT_OF_SCOPE') then raise exception 'CASE_CLOSED'; end if;

  insert into public.case_messages(case_id, sender_type, sender_user_id, body, visible_to_reporter)
  values(p_case_id, 'REPORTER', p_actor_user_id, v_body, true)
  returning * into v_message;

  insert into public.audit_logs(organization_id, case_id, actor_user_id, event_type, object_type, object_id, details)
  values(v_case.organization_id, p_case_id, p_actor_user_id, 'IDENTIFIED_REPORTER_MESSAGE_SENT', 'case_message', v_message.id, '{}'::jsonb);

  return jsonb_build_object('ok', true, 'messageId', v_message.id, 'createdAt', v_message.created_at, 'nomorLaporan', v_case.public_case_id);
end
$function$;

revoke all on function public.send_identified_reporter_message_atomic(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.send_identified_reporter_message_atomic(uuid, uuid, text) to service_role;

create or replace function public.send_anonymous_reporter_message_atomic(
  p_public_case_id text,
  p_supplied_hash text,
  p_message text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_case public.cases%rowtype;
  v_access public.case_anonymous_access%rowtype;
  v_message public.case_messages%rowtype;
  v_body text := trim(coalesce(p_message, ''));
  v_failed integer;
  v_locked_until timestamptz;
begin
  if char_length(v_body) < 1 or char_length(v_body) > 5000 then raise exception 'INVALID_MESSAGE'; end if;

  select * into v_case
  from public.cases
  where public_case_id = upper(trim(coalesce(p_public_case_id, '')))
    and reporting_mode = 'ANONYMOUS'
  for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'INVALID_ACCESS'); end if;

  select * into v_access from public.case_anonymous_access where case_id = v_case.id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'INVALID_ACCESS'); end if;
  if v_access.locked_until is not null and v_access.locked_until > now() then
    return jsonb_build_object('ok', false, 'code', 'LOCKED');
  end if;

  if v_access.secret_hash <> coalesce(p_supplied_hash, '') then
    v_failed := coalesce(v_access.failed_attempts, 0) + 1;
    v_locked_until := case when v_failed >= 5 then now() + interval '15 minutes' else null end;
    update public.case_anonymous_access
    set failed_attempts = case when v_failed >= 5 then 0 else v_failed end,
        locked_until = v_locked_until
    where case_id = v_case.id;
    return jsonb_build_object('ok', false, 'code', 'INVALID_ACCESS', 'locked', v_locked_until is not null);
  end if;

  if v_case.status in ('CLOSED', 'OUT_OF_SCOPE') then
    return jsonb_build_object('ok', false, 'code', 'CASE_CLOSED');
  end if;

  update public.case_anonymous_access
  set failed_attempts = 0, locked_until = null, last_used_at = now()
  where case_id = v_case.id;

  insert into public.case_messages(case_id, sender_type, body, visible_to_reporter)
  values(v_case.id, 'REPORTER', v_body, true)
  returning * into v_message;

  insert into public.audit_logs(organization_id, case_id, event_type, object_type, object_id, details)
  values(v_case.organization_id, v_case.id, 'REPORTER_MESSAGE_SENT', 'case_message', v_message.id, '{}'::jsonb);

  return jsonb_build_object('ok', true, 'id', v_message.id, 'waktu', v_message.created_at);
end
$function$;

revoke all on function public.send_anonymous_reporter_message_atomic(text, text, text) from public, anon, authenticated;
grant execute on function public.send_anonymous_reporter_message_atomic(text, text, text) to service_role;
