create index if not exists case_followups_linked_case_completed_idx on public.case_followups(linked_case_id,completed_at desc) where linked_case_id is not null;
