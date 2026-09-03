-- Telephony incident job names (Phase 2, stage 3).
--
-- Telephony failures are recorded in motorist_job_incidents, which references
-- motorist_job_controls(job_name). The rows below exist only as incident
-- anchors; they are disabled and never scheduled (no worker runs them).

insert into public.motorist_job_controls (job_name, enabled)
values
  ('telephony.telnyx.webhook', false),
  ('telephony.telnyx.commands', false),
  ('telephony.telnyx.actions', false)
on conflict (job_name) do nothing;
