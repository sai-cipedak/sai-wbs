select cron.unschedule(jobid) from cron.job where jobname='laduni-notification-dispatch';
select cron.schedule(
  'laduni-notification-dispatch',
  '*/5 * * * *',
  $$select net.http_post(
      url := 'https://jehsjpjbyjsmamtoignq.supabase.co/functions/v1/notification-dispatch',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'x-dispatch-token',(
          select setting_value #>> '{}'
          from public.app_settings
          where setting_key='notification_dispatch_token'
          limit 1
        )
      ),
      body := '{"limit":25}'::jsonb
    );$$
);
