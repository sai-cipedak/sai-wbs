create unique index if not exists cases_anonymous_submission_token_ux
  on public.cases(submission_token)
  where submission_token is not null and reporting_mode = 'ANONYMOUS';

comment on index public.cases_anonymous_submission_token_ux is
  'Prevents duplicate anonymous cases when the same client submission token is retried.';
