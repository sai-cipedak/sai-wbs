create or replace function private.create_revision_note_from_authority_review()
returns trigger
language plpgsql
security definer
set search_path='public'
as $$
declare
  v_authority text;
  v_title text;
begin
  if new.decision = 'RETURNED_FOR_REVISION' then
    select authority_code into v_authority from public.cases where id=new.case_id;
    v_title := case when v_authority='DEKOM' then 'Catatan Revisi Dekom' else 'Catatan Revisi Sekretariat' end;
    insert into public.case_investigation_notes (
      case_id, author_user_id, note_type, title, body
    ) values (
      new.case_id, new.reviewer_user_id, 'ANALYSIS', v_title, new.review_notes
    );
  end if;
  return new;
end;
$$;
