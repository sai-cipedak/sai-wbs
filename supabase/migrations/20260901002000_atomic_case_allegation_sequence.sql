create or replace function public.add_case_allegation_atomic(
  p_case_id uuid,
  p_actor_user_id uuid,
  p_statement text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_next integer;
  v_row public.case_allegations%rowtype;
begin
  if char_length(trim(coalesce(p_statement, ''))) < 5
     or char_length(trim(coalesce(p_statement, ''))) > 2000 then
    raise exception 'INVALID_STATEMENT';
  end if;

  perform 1
  from public.cases
  where id = p_case_id
  for update;

  if not found then
    raise exception 'CASE_NOT_FOUND';
  end if;

  select coalesce(max(sequence_no), 0) + 1
  into v_next
  from public.case_allegations
  where case_id = p_case_id;

  insert into public.case_allegations(case_id, sequence_no, statement, created_by)
  values (p_case_id, v_next, trim(p_statement), p_actor_user_id)
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'sequence_no', v_row.sequence_no,
    'statement', v_row.statement,
    'status', v_row.status
  );
end;
$$;

revoke all on function public.add_case_allegation_atomic(uuid, uuid, text) from public;
revoke all on function public.add_case_allegation_atomic(uuid, uuid, text) from anon;
revoke all on function public.add_case_allegation_atomic(uuid, uuid, text) from authenticated;
grant execute on function public.add_case_allegation_atomic(uuid, uuid, text) to service_role;
