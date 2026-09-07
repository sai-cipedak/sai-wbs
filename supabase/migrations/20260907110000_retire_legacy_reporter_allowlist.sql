-- Retire the three UAT-only allowlist entries now that identified reporters use
-- self-registration with a community access code. Auth remains the sole source
-- of account identity; this migration never fabricates an auth user.

begin;

do $migration$
begin
  if exists (
    select 1
    from public.profiles
    where lower(email) in (
      'aditrin36@gmail.com',
      'knip.sukenip@gmail.com',
      'nisa.kahakim@gmail.com'
    )
    group by organization_id, lower(email)
    having count(distinct user_id) > 1
  ) then
    raise exception 'DUPLICATE_TARGET_PROFILE';
  end if;
end
$migration$;

with retired as (
  update public.reporter_allowlist
  set is_active = false,
      updated_at = now()
  where lower(email) in (
    'aditrin36@gmail.com',
    'knip.sukenip@gmail.com',
    'nisa.kahakim@gmail.com'
  )
    and is_active
  returning organization_id, id
)
insert into public.audit_logs(
  organization_id,
  actor_user_id,
  event_type,
  object_type,
  object_id,
  details
)
select
  organization_id,
  null,
  'LEGACY_REPORTER_ALLOWLIST_RETIRED',
  'reporter_allowlist',
  id::text,
  jsonb_build_object('reason', 'community_code_self_registration')
from retired;

-- A stale INTERNAL label must not survive once the account has no active
-- internal role. Accounts that still hold a live role (including the current
-- system administrator) remain INTERNAL and keep their access unchanged.
update public.profiles p
set member_type = 'OTS',
    updated_at = now()
where lower(p.email) in (
    'aditrin36@gmail.com',
    'knip.sukenip@gmail.com',
    'nisa.kahakim@gmail.com'
  )
  and p.member_type = 'INTERNAL'
  and not exists (
    select 1
    from public.user_system_roles r
    where r.user_id = p.user_id
      and r.organization_id = p.organization_id
      and r.active_from <= now()
      and (r.active_until is null or r.active_until > now())
  );

commit;
