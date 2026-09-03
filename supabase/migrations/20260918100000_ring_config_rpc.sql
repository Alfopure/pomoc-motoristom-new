-- Transactional routing-configuration replace (Phase 3, stage 1).
--
-- `motorist_replace_ring_plan(p_organization_id, p_document)` swaps whole
-- sections of the routing document in one transaction: ring groups with their
-- members, ring plans with their steps, business hours with their intervals
-- and exceptions, and pause reasons. Sections absent from the document (or
-- explicitly `null`) are left untouched, so the ring-groups editor never has to
-- resend the plans and vice versa.
--
-- Why one function rather than four: the sections reference each other
-- (a step points at a group, a line points at a plan and at business hours), so
-- a partial apply could leave a plan step without a group — exactly the state
-- that breaks an inbound call. The name follows §3.1 of the design document,
-- where the RPC is listed as `motorist_replace_ring_plan(jsonb)`.
--
-- Semantics:
--   * everything is scoped by `p_organization_id`; a row id that belongs to a
--     different organisation aborts with `cross_organization`
--   * members and steps are deleted and re-inserted (positions are unique per
--     group/plan, so an in-place update would trip the constraint on a swap);
--     `last_offered_at`/`last_answered_at` are carried over by member id
--   * a group that is still referenced by a surviving step, a plan that is
--     still referenced by a line or an IVR option, and business hours that are
--     still referenced by a line cannot be deleted (`*_in_use`) — the
--     FK `on delete set null`/`cascade` would silently unroute a line
--   * a call in progress is unaffected: `materialiseRingPlan` freezes the plan
--     into `motorist_call_sessions.metadata` at call start.
--
-- Validation of the document (timeouts, ring seconds, contiguous positions,
-- E.164 members, allowlist) lives in `src/server/telephony/config-service.ts`;
-- the constraints repeated here are the ones that protect referential
-- integrity and cannot be checked outside the transaction.

create or replace function public.motorist_replace_ring_plan(
  p_organization_id uuid,
  p_document jsonb
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
  v_result jsonb := '{}'::jsonb;
begin
  if p_organization_id is null then
    raise exception 'organization_required' using errcode = 'P0001';
  end if;

  -- ── ring groups ─────────────────────────────────────────────────────────
  if v_groups is not null then
    select array_agg((g ->> 'id')::uuid) into v_group_ids from pg_catalog.jsonb_array_elements(v_groups) g;
    v_group_ids := coalesce(v_group_ids, array[]::uuid[]);

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

    select string_agg(x.id::text, ', ') into v_conflict
    from public.motorist_pause_reasons x
    where x.id = any (v_reason_ids) and x.organization_id <> p_organization_id;
    if v_conflict is not null then
      raise exception 'cross_organization: pause reason %', v_conflict using errcode = 'P0001';
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

  return v_result;
end;
$$;

revoke all on function public.motorist_replace_ring_plan(uuid, jsonb)
  from public, anon, authenticated;

grant execute on function public.motorist_replace_ring_plan(uuid, jsonb)
  to service_role;
