-- Read-only postflight for the exact two-table B2 migration.
-- Run only on the explicitly selected project. Never writes business rows.
begin read only;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

do $verify$
declare
  target_table text;
  db_role text;
  privilege_name text;
  actor record;
  member_orgs uuid[];
  expected_count bigint;
  actual_count bigint;
  foreign_count bigint;
  checked_privileges text[] := array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
  checks jsonb := '[]'::jsonb;
begin
  if current_setting('server_version_num')::integer>=170000 then
    checked_privileges:=array_append(checked_privileges,'MAINTAIN');
  end if;
  foreach target_table in array array['motorist_case_events','motorist_call_events'] loop
    if not (select relrowsecurity from pg_class where oid=format('public.%I',target_table)::regclass) then
      raise exception 'RLS disabled on %', target_table;
    end if;
    if (select count(*) from pg_policies where schemaname='public' and tablename=target_table) <> 1
       or not exists(select 1 from pg_policies where schemaname='public' and tablename=target_table
         and policyname=target_table||'_organization_access' and cmd='SELECT'
         and roles=array['authenticated']::name[] and with_check is null
         and qual='app_private.motorist_is_org_member(organization_id)') then
      raise exception 'Unexpected history policy on %', target_table;
    end if;
    if exists(select 1 from pg_attribute where attrelid=format('public.%I',target_table)::regclass
      and attnum>0 and not attisdropped and attacl is not null) then
      raise exception 'Review explicit column privileges on %', target_table;
    end if;
    foreach db_role in array array['anon','authenticated','service_role'] loop
      foreach privilege_name in array checked_privileges loop
        if has_table_privilege(db_role,format('public.%I',target_table),privilege_name)
          is distinct from (privilege_name='SELECT' or db_role='service_role') then
          raise exception 'Unexpected % privilege for % on %', privilege_name, db_role, target_table;
        end if;
      end loop;
      checks:=checks||jsonb_build_object('check','grants','table',target_table,'role',db_role,'passed',true);
    end loop;
  end loop;

  -- Compare actual authenticated visibility with active organization membership.
  -- Return only aggregate counts, never profile IDs or event/customer contents.
  for actor in select distinct on (role) role,user_id from public.motorist_profiles
    where active and user_id is not null order by role,user_id loop
    select array_agg(distinct organization_id) into member_orgs
      from public.motorist_profiles where user_id=actor.user_id and active;
    perform set_config('request.jwt.claim.sub',actor.user_id::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor.user_id,'role','authenticated')::text,true);
    foreach target_table in array array['motorist_case_events','motorist_call_events'] loop
      execute format('select count(*) from public.%I where organization_id=any($1)',target_table)
        into expected_count using member_orgs;
      execute 'set local role authenticated';
      execute format('select count(*),count(*) filter(where not(organization_id=any($1))) from public.%I',target_table)
        into actual_count,foreign_count using member_orgs;
      execute 'reset role';
      if actual_count<>expected_count or foreign_count<>0 then raise exception 'Read mismatch for role % on %',actor.role,target_table; end if;
      checks:=checks||jsonb_build_object('check','member_read','table',target_table,'role',actor.role,'visible_rows',actual_count,'foreign_rows',foreign_count);
    end loop;
  end loop;

  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  perform set_config('request.jwt.claims','{}',true);
  foreach db_role in array array['anon','authenticated'] loop
    execute format('set local role %I',db_role);
    foreach target_table in array array['motorist_case_events','motorist_call_events'] loop
      execute format('select count(*) from public.%I',target_table) into actual_count;
      if actual_count<>0 then raise exception 'Unknown user can read %',target_table; end if;
      checks:=checks||jsonb_build_object('check','unknown_read','table',target_table,'role',db_role,'visible_rows',actual_count);
    end loop;
    execute 'reset role';
  end loop;
  perform set_config('motorist.history_verification',checks::text,true);
end;
$verify$;

select current_setting('motorist.history_verification')::jsonb as verification;
rollback;
