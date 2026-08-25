create or replace function private.create_revision_note_from_authority_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.decision = 'RETURNED_FOR_REVISION' then
    insert into public.case_investigation_notes (
      case_id,
      author_user_id,
      note_type,
      title,
      body
    ) values (
      new.case_id,
      new.reviewer_user_id,
      'ANALYSIS',
      'Catatan Revisi Sekretariat',
      new.review_notes
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_authority_review_revision_note on public.case_authority_reviews;
create trigger trg_authority_review_revision_note
after insert on public.case_authority_reviews
for each row execute function private.create_revision_note_from_authority_review();

drop function if exists public.create_revision_note_from_authority_review();
