alter table public.cases add column if not exists is_test_data boolean not null default false;
alter table public.cases add column if not exists test_label text;
create index if not exists cases_is_test_data_idx on public.cases(is_test_data);
comment on column public.cases.is_test_data is 'Marks UAT/test cases so production workspaces can exclude them by default.';
comment on column public.cases.test_label is 'Optional label describing the UAT/test dataset.';
