create table if not exists public.case_authority_reviews (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  reviewer_user_id uuid not null references auth.users(id),
  decision text not null check (decision in ('APPROVED','RETURNED_FOR_REVISION')),
  review_notes text not null,
  created_at timestamptz not null default now()
);

create index if not exists case_authority_reviews_case_idx
  on public.case_authority_reviews(case_id, created_at desc);

alter table public.case_authority_reviews enable row level security;
revoke all on public.case_authority_reviews from anon, authenticated;
