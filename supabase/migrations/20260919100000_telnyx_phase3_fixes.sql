-- Phase 3 fixes round 1: routing configuration is writable only through the
-- validated service-role routes, and the transactional replace gains
-- optimistic concurrency plus the guards its callers already assume.
--
-- Why this migration exists
-- ------------------------
-- 1. `20260903100000_telnyx_telephony_foundation.sql` created a
--    `*_manager_write` policy (`for all`, manager/admin) on every routing
--    configuration table, and `20260520192000_foundation_schema.sql` had
--    already given `motorist_telephony_lines` a `for all` policy to any org
--    member. PostgREST is reachable from the browser with the user's own JWT,
--    so a manager (a dispatcher, for the lines) could write raw rows straight
--    into the routing tables: no `validateRoutingReplace`, no transactional
--    replace, no `motorist_audit_log` row — and for
--    `motorist_telephony_settings` no admin gate on the kill switches at all.
--    Every write now has to go through the service-role routes, which validate
--    and audit; RLS keeps only the member `select`.
-- 2. `motorist_replace_ring_plan` validated the document in TypeScript before
--    the transaction, so two managers editing at once could commit a state the
--    validators forbid, and a stale editor silently deleted the rows the other
--    one had just added. The RPC now takes the document version the editor read,
--    serialises per organisation with an advisory lock, re-asserts the cheap
--    structural invariants after the inserts and bumps the version.
-- 3. A pause reason an operator is currently paused under could be deleted; the
--    FK is `on delete set null`, so the live presence row silently lost its
--    reason. It is now `pause_reason_in_use`, like the other sections.
-- 4. `motorist_operator_devices` was unique on `(profile_id, environment)`
--    globally, so an upsert with a profile id from another organisation would
--    have rewritten that organisation's device row. The key is now per
--    organisation.

-- ---------------------------------------------------------------------------
-- 1. Routing configuration is service-role only
-- ---------------------------------------------------------------------------

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'motorist_business_hours',
    'motorist_business_hours_intervals',
    'motorist_business_hours_exceptions',
    'motorist_ring_groups',
    'motorist_ring_group_members',
    'motorist_ring_plans',
    'motorist_ring_plan_steps',
    'motorist_ivr_menus',
    'motorist_ivr_options',
    'motorist_pause_reasons',
    'motorist_operator_telephony_settings',
    'motorist_telephony_settings',
    'motorist_telephony_lines'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);

    -- The write policies go away entirely; nothing but the service role writes.
    execute format('drop policy if exists %I on public.%I', table_name || '_manager_write', table_name);
    execute format('drop policy if exists %I on public.%I', table_name || '_organization_access', table_name);

    -- Members keep reading (the settings screens render from PostgREST-free
    -- server reads, but the dispatch console still reads lines directly).
    execute format('drop policy if exists %I on public.%I', table_name || '_member_select', table_name);
    execute format(
      'create policy %I on public.%I for select using (app_private.motorist_is_org_member(organization_id))',
      table_name || '_member_select',
      table_name
    );

    execute format('revoke insert, update, delete on table public.%I from anon, authenticated', table_name);
    execute format('grant select, insert, update, delete on table public.%I to service_role', table_name);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Per-organisation device identity
-- ---------------------------------------------------------------------------

alter table public.motorist_operator_devices
  drop constraint if exists motorist_operator_devices_profile_id_environment_key;

create unique index if not exists operator_devices_org_profile_env_idx
  on public.motorist_operator_devices (organization_id, profile_id, environment);

-- ---------------------------------------------------------------------------
-- 3. Routing document version (optimistic concurrency for the whole-document PUTs)
-- ---------------------------------------------------------------------------

alter table public.motorist_telephony_settings
  add column if not exists routing_version integer not null default 0;

-- ---------------------------------------------------------------------------
-- 4. Transactional replace, v2
-- ---------------------------------------------------------------------------

drop function if exists public.motorist_replace_ring_plan(uuid, jsonb);

create or replace function public.motorist_replace_ring_plan(
  p_organization_id uuid,
  p_document jsonb,
  p_expected_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_groups jsonb := nullif(p_document -> 'groups', 'null'::jsonb);
  v_plans jsonb := nullif(p_document -> 'plans', 'null'::jsonb);
  v_hours jsonb := nullif(p_document -> 'business_hours', 'null'::jsonb);
  v_reasons jsonb := nullif(p_document -> 'pause_reasons', 'null'::jsonb);
  v_stamps jsonb := '{}'::jsonb;
  v_group_ids uuid[];
  v_plan_ids uuid[];
  v_hours_ids uuid[];
  v_reason_ids uuid[];
  v_conflict text;
  v_version integer;
  v_result jsonb := '{}'::jsonb;
begin
  if p_organization_id is null then
    raise exception 'organization_required' using errcode = 'P0001';
  end if;

  -- One writer per organisation for the whole transaction: the structural
  -- invariants below are only true if no second replace interleaves between the
  -- inserts and the assertions.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_organization_id::text));

  insert into public.motorist_telephony_settings (organization_id)
  values (p_organization_id)
  on conflict (organization_id) do nothing;

  select s.routing_version into v_version
    from public.motorist_telephony_settings s
   where s.organization_id = p_organization_id
     for update;

  -- Optimistic concurrency: the editor sends the version it read. A different
  -- version means somebody else saved in the meantime and the draft would
  -- delete their rows (every section replace is a whole-list swap).
  if p_expected_version is not null and p_expected_version <> v_version then
    raise exception 'stale_document: expected %, current %', p_expected_version, v_version using errcode = 'P0001';
  end if;

  -- ── ring groups ─────────────────────────────────────────────────────────
  if v_groups is not null then
    select array_agg((g ->> 'id')::uuid) into v_group_ids from pg_catalog.jsonb_array_elements(v_groups) g;
    v_group_ids := coalesce(v_group_ids, array[]::uuid[]);
    if array_position(v_group_ids, null) is not null then
      raise exception 'group_id_required' using errcode = 'P0001';
    end if;

    select string_agg(x.id::text, ', ') into v_conflict
    from public.motorist_ring_groups x
    where x.id = any (v_group_ids) and x.organization_id <> p_organization_id;
    if v_conflict is not null then
      raise exception 'cross_organization: ring group %', v_conflict using errcode = 'P0001';
    end if;

    -- Liveness stamps survive the delete/insert cycle (used by the ordered strategy).
    select coalesce(
             pg_catalog.jsonb_object_agg(
               m.id::text,
               pg_catalog.jsonb_build_object('last_offered_at', m.last_offered_at, 'last_answered_at', m.last_answered_at)
             ),
             '{}'::jsonb
           )
      into v_stamps
      from public.motorist_ring_group_members m
     where m.organization_id = p_organization_id;

    insert into public.motorist_ring_groups (id, organization_id, name, description, active)
    select
      (g ->> 'id')::uuid,
      p_organization_id,
      g ->> 'name',
      g ->> 'description',
      coalesce((g ->> 'active')::boolean, true)
    from pg_catalog.jsonb_array_elements(v_groups) g
    on conflict (id) do update
      set name = excluded.name,
          description = excluded.description,
          active = excluded.active
      where motorist_ring_groups.organization_id = p_organization_id;

    delete from public.motorist_ring_group_members m
     where m.organization_id = p_organization_id
       and m.ring_group_id = any (v_group_ids);

    insert into public.motorist_ring_group_members (
      id, organization_id, ring_group_id, member_kind, profile_id, external_number, position, ring_secs, last_offered_at, last_answered_at
    )
    select
      coalesce((mm ->> 'id')::uuid, pg_catalog.gen_random_uuid()),
      p_organization_id,
      (g ->> 'id')::uuid,
      mm ->> 'member_kind',
      (mm ->> 'profile_id')::uuid,
      mm ->> 'external_number',
      (mm ->> 'position')::integer,
      (mm ->> 'ring_secs')::integer,
      (v_stamps -> (mm ->> 'id') ->> 'last_offered_at')::timestamptz,
      (v_stamps -> (mm ->> 'id') ->> 'last_answered_at')::timestamptz
    from pg_catalog.jsonb_array_elements(v_groups) g,
         pg_catalog.jsonb_array_elements(coalesce(g -> 'members', '[]'::jsonb)) mm;

    v_result := v_result || pg_catalog.jsonb_build_object('groups', pg_catalog.jsonb_array_length(v_groups));
  end if;

  -- ── ring plans and steps ────────────────────────────────────────────────
  if v_plans is not null then
    select array_agg((p ->> 'id')::uuid) into v_plan_ids from pg_catalog.jsonb_array_elements(v_plans) p;
    v_plan_ids := coalesce(v_plan_ids, array[]::uuid[]);
    if array_position(v_plan_ids, null) is not null then
      raise exception 'plan_id_required' using errcode = 'P0001';
    end if;

    select string_agg(x.id::text, ', ') into v_conflict
    from public.motorist_ring_plans x
    where x.id = any (v_plan_ids) and x.organization_id <> p_organization_id;
    if v_conflict is not null then
      raise exception 'cross_organization: ring plan %', v_conflict using errcode = 'P0001';
    end if;

    select string_agg(distinct l.phone_number, ', ') into v_conflict
    from public.motorist_telephony_lines l
    where l.organization_id = p_organization_id
      and l.ring_plan_id is not null
      and not (l.ring_plan_id = any (v_plan_ids));
    if v_conflict is not null then
      raise exception 'ring_plan_in_use: %', v_conflict using errcode = 'P0001';
    end if;

    select string_agg(distinct o.label, ', ') into v_conflict
    from public.motorist_ivr_options o
    where o.organization_id = p_organization_id
      and o.target_ring_plan_id is not null
      and not (o.target_ring_plan_id = any (v_plan_ids));
    if v_conflict is not null then
      raise exception 'ring_plan_in_use: %', v_conflict using errcode = 'P0001';
    end if;

    insert into public.motorist_ring_plans (id, organization_id, name, fallback_kind, fallback_number, active)
    select
      (p ->> 'id')::uuid,
      p_organization_id,
      p ->> 'name',
      coalesce(p ->> 'fallback_kind', 'callback_prompt'),
      p ->> 'fallback_number',
      coalesce((p ->> 'active')::boolean, true)
    from pg_catalog.jsonb_array_elements(v_plans) p
    on conflict (id) do update
      set name = excluded.name,
          fallback_kind = excluded.fallback_kind,
          fallback_number = excluded.fallback_number,
          active = excluded.active
      where motorist_ring_plans.organization_id = p_organization_id;

    delete from public.motorist_ring_plan_steps s
     where s.organization_id = p_organization_id
       and s.ring_plan_id = any (v_plan_ids);

    insert into public.motorist_ring_plan_steps (id, organization_id, ring_plan_id, step_index, ring_group_id, timeout_secs, strategy)
    select
      coalesce((st ->> 'id')::uuid, pg_catalog.gen_random_uuid()),
      p_organization_id,
      (p ->> 'id')::uuid,
      (st ->> 'step_index')::integer,
      (st ->> 'ring_group_id')::uuid,
      (st ->> 'timeout_secs')::integer,
      coalesce(st ->> 'strategy', 'all')
    from pg_catalog.jsonb_array_elements(v_plans) p,
         pg_catalog.jsonb_array_elements(coalesce(p -> 'steps', '[]'::jsonb)) st;

    delete from public.motorist_ring_plans x
     where x.organization_id = p_organization_id
       and not (x.id = any (v_plan_ids));

    v_result := v_result || pg_catalog.jsonb_build_object('plans', pg_catalog.jsonb_array_length(v_plans));
  end if;

  -- Groups are removed last: the steps above may have been rewritten to stop
  -- using them. A step that still points at a removed group aborts the swap
  -- (the FK would cascade the step away and silently shorten the plan).
  if v_groups is not null then
    select string_agg(distinct x.name, ', ') into v_conflict
    from public.motorist_ring_plan_steps s
    join public.motorist_ring_groups x on x.id = s.ring_group_id
    where s.organization_id = p_organization_id
      and not (s.ring_group_id = any (v_group_ids));
    if v_conflict is not null then
      raise exception 'ring_group_in_use: %', v_conflict using errcode = 'P0001';
    end if;

    delete from public.motorist_ring_groups x
     where x.organization_id = p_organization_id
       and not (x.id = any (v_group_ids));
  end if;

  -- ── business hours ──────────────────────────────────────────────────────
  if v_hours is not null then
    select array_agg((h ->> 'id')::uuid) into v_hours_ids from pg_catalog.jsonb_array_elements(v_hours) h;
    v_hours_ids := coalesce(v_hours_ids, array[]::uuid[]);
    if array_position(v_hours_ids, null) is not null then
      raise exception 'business_hours_id_required' using errcode = 'P0001';
    end if;

    select string_agg(x.id::text, ', ') into v_conflict
    from public.motorist_business_hours x
    where x.id = any (v_hours_ids) and x.organization_id <> p_organization_id;
    if v_conflict is not null then
      raise exception 'cross_organization: business hours %', v_conflict using errcode = 'P0001';
    end if;

    select string_agg(distinct l.phone_number, ', ') into v_conflict
    from public.motorist_telephony_lines l
    where l.organization_id = p_organization_id
      and l.business_hours_id is not null
      and not (l.business_hours_id = any (v_hours_ids));
    if v_conflict is not null then
      raise exception 'business_hours_in_use: %', v_conflict using errcode = 'P0001';
    end if;

    insert into public.motorist_business_hours (id, organization_id, name, timezone, active)
    select
      (h ->> 'id')::uuid,
      p_organization_id,
      h ->> 'name',
      coalesce(h ->> 'timezone', 'Europe/Bratislava'),
      coalesce((h ->> 'active')::boolean, true)
    from pg_catalog.jsonb_array_elements(v_hours) h
    on conflict (id) do update
      set name = excluded.name,
          timezone = excluded.timezone,
          active = excluded.active
      where motorist_business_hours.organization_id = p_organization_id;

    delete from public.motorist_business_hours_intervals i
     where i.organization_id = p_organization_id
       and i.business_hours_id = any (v_hours_ids);

    insert into public.motorist_business_hours_intervals (organization_id, business_hours_id, weekday, opens, closes)
    select
      p_organization_id,
      (h ->> 'id')::uuid,
      (iv ->> 'weekday')::smallint,
      (iv ->> 'opens')::time,
      (iv ->> 'closes')::time
    from pg_catalog.jsonb_array_elements(v_hours) h,
         pg_catalog.jsonb_array_elements(coalesce(h -> 'intervals', '[]'::jsonb)) iv;

    delete from public.motorist_business_hours_exceptions e
     where e.organization_id = p_organization_id
       and e.business_hours_id = any (v_hours_ids);

    insert into public.motorist_business_hours_exceptions (organization_id, business_hours_id, date, closed, intervals, label)
    select
      p_organization_id,
      (h ->> 'id')::uuid,
      (ex ->> 'date')::date,
      coalesce((ex ->> 'closed')::boolean, true),
      coalesce(ex -> 'intervals', '[]'::jsonb),
      ex ->> 'label'
    from pg_catalog.jsonb_array_elements(v_hours) h,
         pg_catalog.jsonb_array_elements(coalesce(h -> 'exceptions', '[]'::jsonb)) ex;

    delete from public.motorist_business_hours x
     where x.organization_id = p_organization_id
       and not (x.id = any (v_hours_ids));

    v_result := v_result || pg_catalog.jsonb_build_object('business_hours', pg_catalog.jsonb_array_length(v_hours));
  end if;

  -- ── pause reasons ───────────────────────────────────────────────────────
  if v_reasons is not null then
    select array_agg((r ->> 'id')::uuid) into v_reason_ids from pg_catalog.jsonb_array_elements(v_reasons) r;
    v_reason_ids := coalesce(v_reason_ids, array[]::uuid[]);
    if array_position(v_reason_ids, null) is not null then
      raise exception 'pause_reason_id_required' using errcode = 'P0001';
    end if;

    select string_agg(x.id::text, ', ') into v_conflict
    from public.motorist_pause_reasons x
    where x.id = any (v_reason_ids) and x.organization_id <> p_organization_id;
    if v_conflict is not null then
      raise exception 'cross_organization: pause reason %', v_conflict using errcode = 'P0001';
    end if;

    -- `motorist_operator_presence.pause_reason_id` is `on delete set null`, so
    -- deleting the reason an operator is paused under would silently strip it
    -- from the live presence row.
    select string_agg(distinct r.label, ', ') into v_conflict
    from public.motorist_operator_presence pr
    join public.motorist_pause_reasons r on r.id = pr.pause_reason_id
    where pr.organization_id = p_organization_id
      and pr.pause_reason_id is not null
      and not (pr.pause_reason_id = any (v_reason_ids));
    if v_conflict is not null then
      raise exception 'pause_reason_in_use: %', v_conflict using errcode = 'P0001';
    end if;

    insert into public.motorist_pause_reasons (id, organization_id, code, label, max_minutes, sort_order, active)
    select
      (r ->> 'id')::uuid,
      p_organization_id,
      r ->> 'code',
      r ->> 'label',
      (r ->> 'max_minutes')::integer,
      coalesce((r ->> 'sort_order')::integer, 0),
      coalesce((r ->> 'active')::boolean, true)
    from pg_catalog.jsonb_array_elements(v_reasons) r
    on conflict (id) do update
      set code = excluded.code,
          label = excluded.label,
          max_minutes = excluded.max_minutes,
          sort_order = excluded.sort_order,
          active = excluded.active
      where motorist_pause_reasons.organization_id = p_organization_id;

    delete from public.motorist_pause_reasons x
     where x.organization_id = p_organization_id
       and not (x.id = any (v_reason_ids));

    v_result := v_result || pg_catalog.jsonb_build_object('pause_reasons', pg_catalog.jsonb_array_length(v_reasons));
  end if;

  -- ── structural invariants, asserted inside the transaction ──────────────
  -- `validateRoutingReplace` checks the same rules in TypeScript before the
  -- call, but it validates the world as it was read; two concurrent editors
  -- could each pass and still commit a step whose group has no member. These
  -- three assertions hold on the committed state.
  if v_groups is not null or v_plans is not null then
    select string_agg(distinct x.name, ', ') into v_conflict
    from public.motorist_ring_plan_steps s
    join public.motorist_ring_groups x on x.id = s.ring_group_id
    where s.organization_id = p_organization_id
      and not exists (
        select 1 from public.motorist_ring_group_members m where m.ring_group_id = s.ring_group_id
      );
    if v_conflict is not null then
      raise exception 'ring_group_empty: %', v_conflict using errcode = 'P0001';
    end if;
  end if;

  if v_groups is not null then
    select string_agg(t.name, ', ') into v_conflict
    from (
      select x.name
      from public.motorist_ring_groups x
      join public.motorist_ring_group_members m on m.ring_group_id = x.id
      where x.organization_id = p_organization_id
      group by x.id, x.name
      having count(*) <> max(m.position) + 1
          or min(m.position) <> 0
          or count(distinct m.position) <> count(*)
    ) t;
    if v_conflict is not null then
      raise exception 'position_gap: ring group %', v_conflict using errcode = 'P0001';
    end if;
  end if;

  if v_plans is not null then
    select string_agg(t.name, ', ') into v_conflict
    from (
      select x.name
      from public.motorist_ring_plans x
      join public.motorist_ring_plan_steps s on s.ring_plan_id = x.id
      where x.organization_id = p_organization_id
      group by x.id, x.name
      having count(*) <> max(s.step_index) + 1
          or min(s.step_index) <> 0
          or count(distinct s.step_index) <> count(*)
    ) t;
    if v_conflict is not null then
      raise exception 'position_gap: ring plan %', v_conflict using errcode = 'P0001';
    end if;
  end if;

  update public.motorist_telephony_settings
     set routing_version = routing_version + 1
   where organization_id = p_organization_id
  returning routing_version into v_version;

  return v_result || pg_catalog.jsonb_build_object('routing_version', v_version);
end;
$$;

revoke all on function public.motorist_replace_ring_plan(uuid, jsonb, integer)
  from public, anon, authenticated;

grant execute on function public.motorist_replace_ring_plan(uuid, jsonb, integer)
  to service_role;
