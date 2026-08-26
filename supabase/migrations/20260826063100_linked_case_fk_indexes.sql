create index if not exists case_links_source_followup_idx on public.case_links(source_followup_id) where source_followup_id is not null;
create index if not exists case_links_created_by_idx on public.case_links(created_by) where created_by is not null;
