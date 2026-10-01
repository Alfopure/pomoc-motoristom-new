-- PREPARATION ONLY: application code supporting endpoint-specific attempts
-- must be deployed before this migration is explicitly authorized/applied.
-- No provider identifiers or existing attempt rows are rewritten.
begin;

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;
set local search_path = public, extensions;

-- The constraint swap is atomic and serialized against attempt writers.
lock table public.motorist_ring_attempts in access exclusive mode;

-- One SIP attempt and one attempt per external number in each ring step.
-- The existing external-number index remains unchanged.
drop index public.ring_attempts_session_step_profile_idx;
create unique index ring_attempts_session_step_operator_idx
  on public.motorist_ring_attempts (session_id, step_index, profile_id)
  where member_kind = 'operator' and profile_id is not null;

-- Keep one open attempt for a specific endpoint even across ring steps.
create unique index ring_attempts_operator_open_offer_idx
  on public.motorist_ring_attempts (profile_id)
  where result = 'offered' and member_kind = 'operator' and profile_id is not null;
create unique index ring_attempts_owned_external_open_offer_idx
  on public.motorist_ring_attempts (profile_id, external_number)
  where result = 'offered' and member_kind = 'external_number' and profile_id is not null;

-- Multiple devices may ring for the same caller, but never for two callers.
-- btree_gist supports uuid equality/inequality; exclusion is checked against
-- concurrent uncommitted inserts too, unlike a read-before-insert guard.
-- A conflict raises 23P01; application admission treats it as another offer.
alter table public.motorist_ring_attempts
  add constraint ring_attempts_profile_session_open_offer_excl
  exclude using gist (profile_id with =, session_id with <>)
  where (result = 'offered' and profile_id is not null);

drop index public.ring_attempts_profile_open_offer_idx;

commit;
