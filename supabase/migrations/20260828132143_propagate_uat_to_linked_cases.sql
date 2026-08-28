create or replace function public.propagate_test_flag_to_linked_case()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_test boolean;
  v_test_label text;
begin
  if new.relation_type <> 'RETALIATION_FOLLOWUP' then
    return new;
  end if;

  select is_test_data, test_label
    into v_is_test, v_test_label
  from public.cases
  where id = new.source_case_id;

  if coalesce(v_is_test, false) then
    update public.cases
      set is_test_data = true,
          test_label = coalesce(test_label, v_test_label, 'Inherited UAT linked case'),
          updated_at = now()
    where id = new.linked_case_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_propagate_test_flag_to_linked_case on public.case_links;
create trigger trg_propagate_test_flag_to_linked_case
after insert on public.case_links
for each row execute function public.propagate_test_flag_to_linked_case();
