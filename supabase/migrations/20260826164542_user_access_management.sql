create table if not exists public.system_role_conflicts (
  role_code_a text not null references public.system_roles(code) on update cascade on delete cascade,
  role_code_b text not null references public.system_roles(code) on update cascade on delete cascade,
  reason_id text,
  created_at timestamptz not null default now(),
  primary key (role_code_a, role_code_b),
  constraint system_role_conflicts_order check (role_code_a < role_code_b)
);

insert into public.system_role_conflicts(role_code_a,role_code_b,reason_id)
values
  ('DEKOM','SECRETARIAT','Dekom harus independen dari Sekretariat DS.'),
  ('DEKOM','TRIAGE','Dekom harus independen dari Penelaah Awal.')
on conflict (role_code_a,role_code_b) do update set reason_id=excluded.reason_id;

create table if not exists public.pending_system_role_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role_code text not null references public.system_roles(code) on update cascade,
  status text not null default 'PENDING' check (status in ('PENDING','CLAIMED','REVOKED','EXPIRED')),
  active_from timestamptz not null default now(),
  active_until timestamptz,
  granted_by uuid references auth.users(id),
  claimed_by uuid references auth.users(id),
  claimed_at timestamptz,
  revoked_by uuid references auth.users(id),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pending_role_grant_email_normalized check (email = lower(trim(email))),
  constraint pending_role_grant_window check (active_until is null or active_until > active_from)
);

create unique index if not exists pending_system_role_grants_active_uq
  on public.pending_system_role_grants(organization_id,email,role_code)
  where status='PENDING';
create index if not exists pending_system_role_grants_email_idx
  on public.pending_system_role_grants(email,status,active_from,active_until);

alter table public.pending_system_role_grants enable row level security;
revoke all on public.pending_system_role_grants from anon, authenticated;
grant all on public.pending_system_role_grants to service_role;

create or replace function private.enforce_system_role_conflict()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conflict text;
begin
  if new.active_until is not null and new.active_until <= now() then
    return new;
  end if;

  select r.role_code into v_conflict
  from public.user_system_roles r
  where r.user_id = new.user_id
    and r.organization_id = new.organization_id
    and r.id is distinct from new.id
    and (r.active_until is null or r.active_until > now())
    and exists (
      select 1
      from public.system_role_conflicts c
      where c.role_code_a = least(new.role_code,r.role_code)
        and c.role_code_b = greatest(new.role_code,r.role_code)
    )
  limit 1;

  if v_conflict is not null then
    raise exception 'ROLE_CONFLICT:%:%', new.role_code, v_conflict;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_system_role_conflict on public.user_system_roles;
create trigger trg_enforce_system_role_conflict
before insert or update of role_code,user_id,organization_id,active_until
on public.user_system_roles
for each row execute function private.enforce_system_role_conflict();
