-- Preparation only. Apply only to an explicitly authorized project.
-- Old offers retain their implicit web endpoint; no offer or route is rewritten.
begin;

lock table public.motorist_ring_attempts in access exclusive mode;
alter table public.motorist_ring_attempts
  add column application_device text;
alter table public.motorist_ring_attempts
  add constraint ring_attempts_application_device_check
  check (application_device is null or (member_kind = 'operator' and application_device in ('web', 'mobile')));

drop index public.ring_attempts_session_step_operator_idx;
create unique index ring_attempts_session_step_operator_idx
  on public.motorist_ring_attempts (session_id, step_index, profile_id, (coalesce(application_device, 'web')))
  where member_kind = 'operator' and profile_id is not null;

drop index public.ring_attempts_operator_open_offer_idx;
create unique index ring_attempts_operator_open_offer_idx
  on public.motorist_ring_attempts (profile_id, (coalesce(application_device, 'web')))
  where result = 'offered' and member_kind = 'operator' and profile_id is not null;

-- The existing profile/session GiST exclusion still prevents any combination
-- of web, mobile app and PSTN from offering the operator to two callers.
comment on column public.motorist_ring_attempts.application_device is
  'Application destination for one offer; NULL means legacy web. Personal PSTN remains external_number.';
commit;
