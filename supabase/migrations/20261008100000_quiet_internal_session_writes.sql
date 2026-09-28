-- Quiet the Realtime doorbell for internal call-session writes.
--
-- 20260917100000 stopped lease-only writes from ringing the doorbell: every
-- ring makes every open console refetch `calls/active`. Two later writers
-- slipped past that filter without changing anything a console shows:
--
--   * `motorist_session_lease_acquire_v2` (20260929200000) bumps
--     `ownership_generation` on every acquire, so each webhook, action and
--     sweep that takes the lease rang again;
--   * effect checkpoints (state/continuation.ts) rewrite `pending_effects`
--     and its retry cursors several times per webhook.
--
-- On 25 Sep one inbound call rung to three operators produced 50-80 session,
-- leg and presence writes, and with four consoles open that meant 1,000-2,400
-- Supabase requests per call from refetches alone. None of the columns below is
-- read by the console snapshot (src/server/telephony/active-calls.ts) or the
-- browser; a state, leg, offer or presence change still rings at once.
--
-- Only the UPDATE trigger changes. INSERT/DELETE keep their WHEN-less trigger.

drop trigger if exists motorist_call_sessions_broadcast_update on public.motorist_call_sessions;

create trigger motorist_call_sessions_broadcast_update
  after update on public.motorist_call_sessions
  for each row
  when (
    (to_jsonb(old) - 'lease_token' - 'lease_until' - 'updated_at' - 'version' - 'ownership_generation'
      - 'pending_effects' - 'effects_next_attempt_at' - 'cancellations_next_attempt_at' - 'termination_next_attempt_at')
    is distinct from
    (to_jsonb(new) - 'lease_token' - 'lease_until' - 'updated_at' - 'version' - 'ownership_generation'
      - 'pending_effects' - 'effects_next_attempt_at' - 'cancellations_next_attempt_at' - 'termination_next_attempt_at')
  )
  execute function app_private.motorist_broadcast_telephony_change();
