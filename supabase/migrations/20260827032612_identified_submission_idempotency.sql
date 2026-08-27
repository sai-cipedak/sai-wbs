alter table public.cases add column if not exists submission_token uuid;

create unique index if not exists cases_identified_submission_token_ux
  on public.cases(created_by_user_id, submission_token)
  where submission_token is not null;

comment on column public.cases.submission_token is 'Client-generated idempotency token for authenticated identified-report submission retries. Server returns the existing case for the same user and token.';
