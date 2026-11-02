-- Telephony Realtime: a content-free doorbell instead of full row images.
--
-- 20260915100000 broadcast every session, leg and presence write with
-- `realtime.broadcast_changes(..., new, old)`, so every member of the
-- organisation subscribed to `org:<id>:telephony` received complete rows:
-- session metadata (the start request's `initial_operation`, phone numbers,
-- SIP addresses), `pending_effects` (staged provider commands) and leg
-- `client_state`. No consumer reads any of it. The browser
-- (src/lib/telephony/realtime-client.ts, its only subscriber) treats every
-- message as "something changed" and refetches `GET /api/telephony/calls/active`.
--
-- Same function, same triggers and WHEN filters (20260917100000,
-- 20261008100000), same private topic and its membership policy; only the
-- payload goes: `{}` with event `invalidate`, the convention of the other
-- doorbell topics (`tasks:`, `cases:`, `notebook:`). Private, as before.
-- A database without the Realtime extension (a bare local Postgres) skips the
-- send instead of failing the write.
--
-- Messages already stored in `realtime.messages` keep their old payloads until
-- Realtime's own retention removes them (3 days); this migration does not touch
-- the locked `realtime` schema.

create or replace function app_private.motorist_broadcast_telephony_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
begin
  -- OLD/NEW are unassigned records outside their operation, so each branch
  -- touches only the one that exists.
  if tg_op = 'DELETE' then
    v_organization_id := old.organization_id;
  else
    v_organization_id := new.organization_id;
  end if;

  if v_organization_id is null then
    return null;
  end if;

  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    perform realtime.send('{}'::jsonb, 'invalidate', 'org:' || v_organization_id::text || ':telephony', true);
  end if;

  return null;
end;
$$;

revoke all on function app_private.motorist_broadcast_telephony_change()
  from public, anon;
grant execute on function app_private.motorist_broadcast_telephony_change()
  to authenticated, service_role;
