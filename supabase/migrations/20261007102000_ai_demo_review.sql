-- The written evaluation of a demo call.
--
-- Kept beside the transcript rather than derived on every read: it costs a
-- model call to produce, it is what somebody will quote in a meeting, and a
-- review of a call should not change because the rubric was edited afterwards.

begin;

alter table public.motorist_ai_demo_attempts
  add column if not exists review jsonb,
  add column if not exists reviewed_at timestamptz;

comment on column public.motorist_ai_demo_attempts.review is
  'Summary, what went well, problems with a time reference, prompt suggestions and rubric scores for this call.';

commit;
