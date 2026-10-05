-- Manual verification as a database administrator after the permissions migration.
-- Uses existing profiles only for read-permission checks. No rows are modified:
-- every DML probe has WHERE FALSE, and the transaction is rolled back.
begin isolation level repeatable read;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $audit$
declare
  target_table text;
  db_role text;
  operation text;
  actor record;
  member_orgs uuid[];
  expected_count bigint;
  actual_count bigint;
  foreign_count bigint;
  affected bigint;
  denied boolean;
  checks jsonb := '[]'::jsonb;
begin
  -- Prevent even a zero-row probe from invoking a future statement trigger.
  if exists (
    select 1 from pg_trigger
    where tgrelid in ('public.motorist_fleet_assets'::regclass,
                     'public.motorist_partner_directory'::regclass)
      and not tgisinternal and tgenabled <> 'D' and (tgtype & 1) = 0
  ) then
    raise exception 'Review statement triggers before zero-row DML verification';
  end if;

  for actor in
    select distinct on (role) role, user_id
    from public.motorist_profiles
    where active and user_id is not null
    order by role, user_id
  loop
    select array_agg(distinct organization_id) into member_orgs
      from public.motorist_profiles where user_id = actor.user_id and active;
    perform set_config('request.jwt.claim.sub', actor.user_id::text, true);
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', actor.user_id, 'role', 'authenticated')::text, true);
    foreach target_table in array array['motorist_fleet_assets','motorist_partner_directory']
    loop
      execute format('select count(*) from public.%I where organization_id = any($1)', target_table)
        into expected_count using member_orgs;
      execute 'set local role authenticated';
      execute format('select count(*), count(*) filter (where not (organization_id = any($1))) from public.%I', target_table)
        into actual_count, foreign_count using member_orgs;
      execute 'reset role';
      if actual_count <> expected_count or foreign_count <> 0 then
        raise exception 'RLS read mismatch for role % on %', actor.role, target_table;
      end if;
      checks := checks || jsonb_build_object('check','member_read','role',actor.role,
        'table',target_table,'visible_rows',actual_count,'foreign_rows',foreign_count);
    end loop;
  end loop;

  -- Anonymous and an unrecognized user must see no rows.
  foreach db_role in array array['anon','authenticated']
  loop
    perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
    perform set_config('request.jwt.claims', '{}', true);
    execute format('set local role %I', db_role);
    foreach target_table in array array['motorist_fleet_assets','motorist_partner_directory']
    loop
      execute format('select count(*) from public.%I', target_table) into actual_count;
      if actual_count <> 0 then
        raise exception 'Unrecognized % can read % rows from %', db_role, actual_count, target_table;
      end if;
      foreach operation in array array[
        format('insert into public.%I (id) select null::uuid where false', target_table),
        format('update public.%I set id = id where false', target_table),
        format('delete from public.%I where false', target_table)
      ] loop
        denied := false;
        begin
          execute operation;
        exception when insufficient_privilege then
          denied := true;
        end;
        if not denied then
          raise exception 'Direct DML unexpectedly granted to % on %', db_role, target_table;
        end if;
      end loop;
      checks := checks || jsonb_build_object('check','client_read_and_dml','role',db_role,
        'table',target_table,'unknown_user_rows',actual_count,'insert_update_delete_denied',true);
    end loop;
    execute 'reset role';
  end loop;

  foreach target_table in array array['motorist_fleet_assets','motorist_partner_directory']
  loop
    execute format('select count(*) from public.%I', target_table) into expected_count;
    execute 'set local role service_role';
    execute format('select count(*) from public.%I', target_table) into actual_count;
    if actual_count <> expected_count then
      raise exception 'Service read mismatch on %', target_table;
    end if;
    foreach operation in array array[
      format('insert into public.%I (id) select null::uuid where false', target_table),
      format('update public.%I set id = id where false', target_table),
      format('delete from public.%I where false', target_table)
    ] loop
      execute operation;
      get diagnostics affected = row_count;
      if affected <> 0 then raise exception 'DML probe unexpectedly affected rows'; end if;
    end loop;
    execute 'reset role';
    checks := checks || jsonb_build_object('check','server_read_and_dml','table',target_table,
      'visible_rows',actual_count,'zero_row_insert_update_delete_permitted',true);
  end loop;

  perform set_config('motorist.b1_verification', checks::text, true);
end;
$audit$;

select current_setting('motorist.b1_verification')::jsonb as verification;
rollback;
