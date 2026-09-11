create or replace function public.notification_role_for_authority(p_authority text)
returns text language sql immutable set search_path=public as $$
  select case upper(coalesce(p_authority,''))
    when 'TRIAGE' then 'TRIAGE'
    when 'SECRETARIAT' then 'SECRETARIAT'
    when 'HSE' then 'HSE'
    when 'GRIEVANCE' then 'GRIEVANCE_COORDINATOR'
    when 'DEKOM' then 'DEKOM'
    else null end;
$$;

revoke execute on function public.enqueue_notification(uuid,text,uuid,text,text,text,text,uuid,jsonb) from anon, authenticated;
revoke execute on function public.enqueue_notification_for_user(uuid,text,uuid,text,text,text,uuid,jsonb) from anon, authenticated;
revoke execute on function public.enqueue_notification_for_role(uuid,text,text,text,uuid,jsonb,uuid) from anon, authenticated;
revoke execute on function public.enqueue_notification_for_reporter(uuid,text,text,uuid,jsonb) from anon, authenticated;
revoke execute on function public.notification_on_assignment() from anon, authenticated;
revoke execute on function public.notification_on_message() from anon, authenticated;
revoke execute on function public.notification_on_case_progress() from anon, authenticated;
revoke execute on function public.enqueue_due_followup_notifications() from anon, authenticated;
