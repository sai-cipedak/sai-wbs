create or replace function public.link_existing_case_team_member_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organization_id uuid;
  v_user_id uuid;
begin
  if new.linked_user_id is not null then
    return new;
  end if;

  select c.organization_id
    into v_organization_id
  from public.cases c
  where c.id = new.case_id;

  if v_organization_id is null then
    return new;
  end if;

  select p.user_id
    into v_user_id
  from public.profiles p
  where p.organization_id = v_organization_id
    and p.is_active = true
    and lower(p.email) = lower(new.email)
  order by p.created_at asc
  limit 1;

  if v_user_id is not null then
    new.linked_user_id := v_user_id;
    if new.nomination_status = 'PENDING_ACCOUNT' then
      new.nomination_status := 'PENDING_DECLARATION';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_link_existing_case_team_member_account on public.case_team_members;
create trigger trg_link_existing_case_team_member_account
before insert on public.case_team_members
for each row
execute function public.link_existing_case_team_member_account();

create or replace function public.audit_integrity_team_activation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_user_id uuid;
  v_investigator_count integer := 0;
  v_actor_count integer := 0;
begin
  if old.status is distinct from new.status
     and old.status = 'COMMITTEE_FORMATION'
     and new.status = 'INVESTIGATION'
     and new.classification = 'INTEGRITY' then

    select count(distinct ca.user_id)::integer,
           count(distinct ca.assigned_by)::integer
      into v_investigator_count, v_actor_count
    from public.case_assignments ca
    where ca.case_id = new.id
      and ca.access_status = 'ACTIVE'
      and ca.revoked_at is null
      and ca.assignment_role in ('CASE_LEAD','INVESTIGATOR');

    if v_actor_count = 1 then
      select ca.assigned_by
        into v_actor_user_id
      from public.case_assignments ca
      where ca.case_id = new.id
        and ca.access_status = 'ACTIVE'
        and ca.revoked_at is null
        and ca.assignment_role in ('CASE_LEAD','INVESTIGATOR')
        and ca.assigned_by is not null
      limit 1;
    end if;

    insert into public.audit_logs (
      organization_id,
      case_id,
      actor_user_id,
      event_type,
      object_type,
      object_id,
      details
    ) values (
      new.organization_id,
      new.id,
      v_actor_user_id,
      'TEAM_ACTIVATED',
      'case',
      new.id,
      jsonb_build_object(
        'previous_status', old.status,
        'next_status', new.status,
        'investigator_count', v_investigator_count,
        'authority_code', new.authority_code
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_audit_integrity_team_activation on public.cases;
create trigger trg_audit_integrity_team_activation
after update of status on public.cases
for each row
execute function public.audit_integrity_team_activation();