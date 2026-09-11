create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  event_type text not null,
  recipient_user_id uuid null,
  recipient_email text not null,
  recipient_type text not null,
  recipient_role text null,
  source_entity text not null,
  source_id uuid null,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'PENDING' check (status in ('PENDING','SENT','FAILED','SKIPPED')),
  attempt_count integer not null default 0,
  last_attempt_at timestamptz null,
  sent_at timestamptz null,
  error_message text null,
  provider_message_id text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists notification_events_dedupe_idx
  on public.notification_events (event_type, recipient_email, source_entity, coalesce(source_id, case_id));
create index if not exists notification_events_pending_idx
  on public.notification_events (status, created_at) where status in ('PENDING','FAILED');

alter table public.notification_events enable row level security;
revoke all on public.notification_events from anon, authenticated;

create or replace function public.notification_role_for_authority(p_authority text)
returns text language sql immutable as $$
  select case upper(coalesce(p_authority,''))
    when 'TRIAGE' then 'TRIAGE'
    when 'SECRETARIAT' then 'SECRETARIAT'
    when 'HSE' then 'HSE'
    when 'GRIEVANCE' then 'GRIEVANCE_COORDINATOR'
    when 'DEKOM' then 'DEKOM'
    else null end;
$$;

create or replace function public.enqueue_notification(
  p_case_id uuid, p_event_type text, p_recipient_user_id uuid, p_recipient_email text,
  p_recipient_type text, p_recipient_role text, p_source_entity text, p_source_id uuid,
  p_metadata jsonb default '{}'::jsonb
) returns void language plpgsql security definer set search_path=public as $$
begin
  if p_recipient_email is null or btrim(p_recipient_email)='' then return; end if;
  insert into public.notification_events(
    case_id,event_type,recipient_user_id,recipient_email,recipient_type,recipient_role,source_entity,source_id,metadata
  ) values (
    p_case_id,p_event_type,p_recipient_user_id,lower(btrim(p_recipient_email)),p_recipient_type,p_recipient_role,p_source_entity,p_source_id,coalesce(p_metadata,'{}'::jsonb)
  ) on conflict do nothing;
end;
$$;

create or replace function public.enqueue_notification_for_user(
  p_case_id uuid, p_event_type text, p_user_id uuid, p_recipient_type text,
  p_recipient_role text, p_source_entity text, p_source_id uuid, p_metadata jsonb default '{}'::jsonb
) returns void language plpgsql security definer set search_path=public as $$
declare v_email text;
begin
  select email into v_email from public.profiles where user_id=p_user_id and is_active=true limit 1;
  perform public.enqueue_notification(p_case_id,p_event_type,p_user_id,v_email,p_recipient_type,p_recipient_role,p_source_entity,p_source_id,p_metadata);
end;
$$;

create or replace function public.enqueue_notification_for_role(
  p_case_id uuid, p_event_type text, p_role_code text, p_source_entity text, p_source_id uuid,
  p_metadata jsonb default '{}'::jsonb, p_exclude_user_id uuid default null
) returns void language plpgsql security definer set search_path=public as $$
declare r record; v_org uuid;
begin
  if p_role_code is null then return; end if;
  select organization_id into v_org from public.cases where id=p_case_id;
  for r in
    select usr.user_id,p.email
    from public.user_system_roles usr
    join public.profiles p on p.user_id=usr.user_id and p.is_active=true
    where usr.organization_id=v_org and usr.role_code=p_role_code
      and usr.active_from<=now() and (usr.active_until is null or usr.active_until>now())
      and (p_exclude_user_id is null or usr.user_id<>p_exclude_user_id)
  loop
    perform public.enqueue_notification(p_case_id,p_event_type,r.user_id,r.email,'ROLE',p_role_code,p_source_entity,p_source_id,p_metadata);
  end loop;
end;
$$;

create or replace function public.enqueue_notification_for_reporter(
  p_case_id uuid, p_event_type text, p_source_entity text, p_source_id uuid, p_metadata jsonb default '{}'::jsonb
) returns void language plpgsql security definer set search_path=public as $$
declare r record;
begin
  if not exists(select 1 from public.cases where id=p_case_id and reporting_mode='IDENTIFIED') then return; end if;
  select cri.user_id,coalesce(pr.email,cri.reporter_email) email into r
  from public.case_reporter_identities cri
  left join public.profiles pr on pr.user_id=cri.user_id and pr.is_active=true
  where cri.case_id=p_case_id order by cri.created_at desc limit 1;
  if r.email is not null then
    perform public.enqueue_notification(p_case_id,p_event_type,r.user_id,r.email,'REPORTER',null,p_source_entity,p_source_id,p_metadata);
  end if;
end;
$$;

create or replace function public.notification_on_assignment()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.access_status='ACTIVE' and (tg_op='INSERT' or old.access_status is distinct from 'ACTIVE') then
    perform public.enqueue_notification_for_user(new.case_id,'ASSIGNMENT_ACTION_REQUIRED',new.user_id,'ASSIGNEE',new.assignment_role,'case_assignments',new.id,jsonb_build_object('assignment_role',new.assignment_role));
  end if;
  return new;
end;
$$;
drop trigger if exists trg_notification_assignment on public.case_assignments;
create trigger trg_notification_assignment after insert or update of access_status on public.case_assignments for each row execute function public.notification_on_assignment();

create or replace function public.notification_on_message()
returns trigger language plpgsql security definer set search_path=public as $$
declare r record; v_role text; v_has_assignee boolean;
begin
  if new.sender_type='REPORTER' then
    v_has_assignee:=false;
    for r in select ca.user_id,ca.assignment_role from public.case_assignments ca where ca.case_id=new.case_id and ca.access_status='ACTIVE' and (new.sender_user_id is null or ca.user_id<>new.sender_user_id)
    loop
      v_has_assignee:=true;
      perform public.enqueue_notification_for_user(new.case_id,'NEW_REPORTER_MESSAGE',r.user_id,'ASSIGNEE',r.assignment_role,'case_messages',new.id,'{}'::jsonb);
    end loop;
    if not v_has_assignee then
      select public.notification_role_for_authority(authority_code) into v_role from public.cases where id=new.case_id;
      perform public.enqueue_notification_for_role(new.case_id,'NEW_REPORTER_MESSAGE',v_role,'case_messages',new.id,'{}'::jsonb,new.sender_user_id);
    end if;
  else
    if new.visible_to_reporter then
      perform public.enqueue_notification_for_reporter(new.case_id,'NEW_REPORTER_UPDATE','case_messages',new.id,'{}'::jsonb);
    end if;
    if new.sender_type='INTERNAL' then
      for r in select ca.user_id,ca.assignment_role from public.case_assignments ca where ca.case_id=new.case_id and ca.access_status='ACTIVE' and (new.sender_user_id is null or ca.user_id<>new.sender_user_id)
      loop
        perform public.enqueue_notification_for_user(new.case_id,'NEW_INTERNAL_COMMENT',r.user_id,'ASSIGNEE',r.assignment_role,'case_messages',new.id,'{}'::jsonb);
      end loop;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_notification_message on public.case_messages;
create trigger trg_notification_message after insert on public.case_messages for each row execute function public.notification_on_message();

create or replace function public.notification_on_case_progress()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_role text;
begin
  if new.status is distinct from old.status then
    perform public.enqueue_notification_for_reporter(new.id,'CASE_PROGRESS_UPDATE','cases',new.id,jsonb_build_object('status',new.status));
  end if;
  if new.authority_code is distinct from old.authority_code or new.status is distinct from old.status then
    v_role:=public.notification_role_for_authority(new.authority_code);
    perform public.enqueue_notification_for_role(new.id,'WORKFLOW_ACTION_REQUIRED',v_role,'cases',new.id,jsonb_build_object('status',new.status,'authority_code',new.authority_code),new.created_by_user_id);
  end if;
  return new;
end;
$$;
drop trigger if exists trg_notification_case_progress on public.cases;
create trigger trg_notification_case_progress after update of status,authority_code on public.cases for each row execute function public.notification_on_case_progress();

create or replace function public.enqueue_due_followup_notifications()
returns integer language plpgsql security definer set search_path=public as $$
declare r record; v_count integer:=0; v_role text;
begin
  for r in select cf.id,cf.case_id,cf.day_offset,cf.owner_authority_code from public.case_followups cf where cf.due_at<=now() and cf.status not in ('COMPLETED','CLOSED')
  loop
    v_role:=public.notification_role_for_authority(r.owner_authority_code);
    perform public.enqueue_notification_for_role(r.case_id,'FOLLOWUP_DUE',v_role,'case_followups',r.id,jsonb_build_object('day_offset',r.day_offset));
    v_count:=v_count+1;
  end loop;
  return v_count;
end;
$$;

insert into public.app_settings(organization_id,setting_key,setting_value,updated_at)
select id,'notification_dispatch_token',to_jsonb(gen_random_uuid()::text),now() from public.organizations
on conflict (organization_id,setting_key) do nothing;

select cron.unschedule(jobid) from cron.job where jobname='laduni-followup-notification-scan';
select cron.schedule('laduni-followup-notification-scan','0 * * * *',$$select public.enqueue_due_followup_notifications();$$);
