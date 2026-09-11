revoke execute on function public.enqueue_notification(uuid,text,uuid,text,text,text,text,uuid,jsonb) from public;
revoke execute on function public.enqueue_notification_for_user(uuid,text,uuid,text,text,text,uuid,jsonb) from public;
revoke execute on function public.enqueue_notification_for_role(uuid,text,text,text,uuid,jsonb,uuid) from public;
revoke execute on function public.enqueue_notification_for_reporter(uuid,text,text,uuid,jsonb) from public;
revoke execute on function public.notification_on_assignment() from public;
revoke execute on function public.notification_on_message() from public;
revoke execute on function public.notification_on_case_progress() from public;
revoke execute on function public.enqueue_due_followup_notifications() from public;
