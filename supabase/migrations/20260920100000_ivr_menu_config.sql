-- Phase 4 stage 1: IVR menus become editable configuration.
--
-- `motorist_replace_ring_plan` gains an `ivr_menus` section so
-- `/api/telephony/config/ivr-menus` can swap a whole menu with its digit
-- options in the same transaction the other routing sections use (advisory
-- lock per organisation, `routing_version` check, one audit row). The function
-- is recreated in full because plpgsql has no way to patch a body.
--
-- Guards the section adds:
--   * a menu id from another organisation aborts with `cross_organization`
--   * a menu a line still points at cannot be deleted (`ivr_menu_in_use`);
--     `motorist_telephony_lines.ivr_menu_id` is `on delete set null`, so the
--     number would silently lose its menu
--   * options are deleted and re-inserted, because `(ivr_menu_id, digit)` is
--     unique and moving an action between digits would trip the constraint
--
-- The option → ring plan reference is protected from the other side already:
-- the `plans` section refuses to delete a plan an IVR option targets
-- (`ring_plan_in_use`, migration 20260918100000).
--
-- The signature is unchanged, so `create or replace` swaps the body in place;
-- nothing drops the function the config service calls, not even for an instant.

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
  v_ivr jsonb := nullif(p_document -> 'ivr_menus', 'null'::jsonb);
  v_stamps jsonb := '{}'::jsonb;
  v_group_ids uuid[];
  v_plan_ids uuid[];
  v_hours_ids uuid[];
  v_reason_ids uuid[];
  v_ivr_ids uuid[];
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

  -- ── IVR menus and their digit options ───────────────────────────────────
  -- Placed after the plans so a menu option can point at a plan created in the
  -- same document; the editors always send one section at a time, and the
  -- TypeScript validator (`validateIvrMenus`) refuses an option whose target
  -- plan is not in the organisation.
  if v_ivr is not null then
    select array_agg((m ->> 'id')::uuid) into v_ivr_ids from pg_catalog.jsonb_array_elements(v_ivr) m;
    v_ivr_ids := coalesce(v_ivr_ids, array[]::uuid[]);
    if array_position(v_ivr_ids, null) is not null then
      raise exception 'ivr_menu_id_required' using errcode = 'P0001';
    end if;

    select string_agg(x.id::text, ', ') into v_conflict
    from public.motorist_ivr_menus x
    where x.id = any (v_ivr_ids) and x.organization_id <> p_organization_id;
    if v_conflict is not null then
      raise exception 'cross_organization: ivr menu %', v_conflict using errcode = 'P0001';
    end if;

    -- `motorist_telephony_lines.ivr_menu_id` is `on delete set null`: dropping a
    -- menu a line still uses would silently take the menu off that number.
    select string_agg(distinct l.phone_number, ', ') into v_conflict
    from public.motorist_telephony_lines l
    where l.organization_id = p_organization_id
      and l.ivr_menu_id is not null
      and not (l.ivr_menu_id = any (v_ivr_ids));
    if v_conflict is not null then
      raise exception 'ivr_menu_in_use: %', v_conflict using errcode = 'P0001';
    end if;

    insert into public.motorist_ivr_menus (
      id, organization_id, name, prompt_media_url, tts_text, invalid_media_url, timeout_secs, max_tries, active
    )
    select
      (m ->> 'id')::uuid,
      p_organization_id,
      m ->> 'name',
      m ->> 'prompt_media_url',
      m ->> 'tts_text',
      m ->> 'invalid_media_url',
      coalesce((m ->> 'timeout_secs')::integer, 5),
      coalesce((m ->> 'max_tries')::integer, 2),
      coalesce((m ->> 'active')::boolean, true)
    from pg_catalog.jsonb_array_elements(v_ivr) m
    on conflict (id) do update
      set name = excluded.name,
          prompt_media_url = excluded.prompt_media_url,
          tts_text = excluded.tts_text,
          invalid_media_url = excluded.invalid_media_url,
          timeout_secs = excluded.timeout_secs,
          max_tries = excluded.max_tries,
          active = excluded.active
      where motorist_ivr_menus.organization_id = p_organization_id;

    -- Options are swapped wholesale: `(ivr_menu_id, digit)` is unique, so moving
    -- an action from one digit to another would trip the constraint on update.
    delete from public.motorist_ivr_options o
     where o.organization_id = p_organization_id
       and o.ivr_menu_id = any (v_ivr_ids);

    insert into public.motorist_ivr_options (
      id, organization_id, ivr_menu_id, digit, action, target_ring_plan_id, target_number, label, prompt_media_url, tts_text
    )
    select
      coalesce((op ->> 'id')::uuid, pg_catalog.gen_random_uuid()),
      p_organization_id,
      (m ->> 'id')::uuid,
      op ->> 'digit',
      op ->> 'action',
      (op ->> 'target_ring_plan_id')::uuid,
      op ->> 'target_number',
      op ->> 'label',
      op ->> 'prompt_media_url',
      op ->> 'tts_text'
    from pg_catalog.jsonb_array_elements(v_ivr) m,
         pg_catalog.jsonb_array_elements(coalesce(m -> 'options', '[]'::jsonb)) op;

    delete from public.motorist_ivr_menus x
     where x.organization_id = p_organization_id
       and not (x.id = any (v_ivr_ids));

    v_result := v_result || pg_catalog.jsonb_build_object('ivr_menus', pg_catalog.jsonb_array_length(v_ivr));
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
