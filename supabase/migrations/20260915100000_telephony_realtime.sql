-- Telephony realtime broadcast (Phase 2, stage 7 / design "2b").
--
-- The dispatch console polls `GET /api/telephony/calls/active`. Polling stays
-- the source of truth -- it is what keeps the console correct when a browser
-- has no websocket -- but at one request per second per open tab it is also
-- the dominant read load of the whole application.
--
-- This migration adds the push half: every write the telephony state machine
-- makes to a call session, a call leg or an operator presence row is broadcast
-- (Supabase Realtime Broadcast, not `postgres_changes`, which would evaluate
-- RLS per subscriber) to the private topic `org:<organization_id>:telephony`.
-- The browser subscribes once, refetches `calls/active` on any message and
-- relaxes its poll cadence while the channel is connected.
--
-- The payload is deliberately not trusted by the client: it is a "something
-- changed" doorbell, and the authoritative snapshot is still the API response.
-- That keeps the RLS surface here tiny -- membership in the organisation whose
-- id is embedded in the topic.

-- ---------------------------------------------------------------------------
-- 1. Trigger function
-- ---------------------------------------------------------------------------

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

  perform realtime.broadcast_changes(
    'org:' || v_organization_id::text || ':telephony',
    tg_op,
    tg_op,
    tg_table_name,
    tg_table_schema,
    new,
    old
  );

  return null;
end;
$$;

revoke all on function app_private.motorist_broadcast_telephony_change()
  from public, anon;
grant execute on function app_private.motorist_broadcast_telephony_change()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Triggers on the three runtime tables the console renders
-- ---------------------------------------------------------------------------

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'motorist_call_sessions',
    'motorist_call_legs',
    'motorist_operator_presence'
  ]
  loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_broadcast', table_name);
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function app_private.motorist_broadcast_telephony_change()',
      table_name || '_broadcast',
      table_name
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Authorisation for the private topic
-- ---------------------------------------------------------------------------
--
-- `realtime.messages` is owned by the Realtime roles, so the policy is created
-- defensively: a plain Postgres without the Realtime schema (a bare local
-- database) skips it instead of failing the whole migration.
--
-- The topic is `org:<uuid>:telephony`. The uuid is validated by regex *before*
-- it is cast, inside a CASE so the cast can never be evaluated for a foreign
-- topic (AND does not guarantee left-to-right evaluation).

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'realtime' and c.relname = 'messages'
  ) then
    raise notice 'realtime.messages is missing; skipping the telephony broadcast policy';
    return;
  end if;

  execute 'drop policy if exists motorist_telephony_broadcast_read on realtime.messages';
  execute $policy$
    create policy motorist_telephony_broadcast_read
      on realtime.messages
      for select
      to authenticated
      using (
        extension = 'broadcast'
        and case
          when realtime.topic() ~ '^org:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:telephony$'
            then app_private.motorist_is_org_member(split_part(realtime.topic(), ':', 2)::uuid)
          else false
        end
      )
  $policy$;
end $$;
