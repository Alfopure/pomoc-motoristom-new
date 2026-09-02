-- Aggregate-only migration baseline. This intentionally returns no row values,
-- object names, user identifiers, tokens, Vault values, or job command bodies.
select 'server_version_num=' || pg_catalog.current_setting('server_version_num');

select 'public_table_rows=' || coalesce(
  pg_catalog.jsonb_object_agg(table_counts.table_name, table_counts.row_count order by table_counts.table_name),
  '{}'::jsonb
)::text
from (
  select
    tables.table_name,
    ((pg_catalog.xpath(
      '/row/count/text()',
      pg_catalog.query_to_xml(
        pg_catalog.format('select count(*) as count from public.%I', tables.table_name),
        false,
        true,
        ''
      )
    ))[1]::text)::bigint as row_count
  from information_schema.tables
  where table_schema = 'public'
    and table_type = 'BASE TABLE'
) as table_counts;

select 'public_tables_without_rls=' || count(*)::text
from pg_catalog.pg_class as relations
join pg_catalog.pg_namespace as namespaces
  on namespaces.oid = relations.relnamespace
where namespaces.nspname = 'public'
  and relations.relkind in ('r', 'p')
  and not relations.relrowsecurity;

select 'auth_counts=' || pg_catalog.jsonb_build_object(
  'users', (select count(*) from auth.users),
  'identities', (select count(*) from auth.identities),
  'sessions', (select count(*) from auth.sessions),
  'refresh_tokens', (select count(*) from auth.refresh_tokens),
  'mfa_factors', (select count(*) from auth.mfa_factors)
)::text;

select 'storage_buckets=' || coalesce(
  pg_catalog.jsonb_object_agg(
    bucket_counts.bucket_id,
    pg_catalog.jsonb_build_object(
      'objects', bucket_counts.object_count,
      'bytes', bucket_counts.object_bytes,
      'public', bucket_counts.public
    )
    order by bucket_counts.bucket_id
  ),
  '{}'::jsonb
)::text
from (
  select
    buckets.id as bucket_id,
    buckets.public,
    count(objects.id) as object_count,
    -- Invalid non-numeric size metadata must fail the snapshot. Treating it as
    -- zero would hide corruption and weaken the Storage validation gate.
    coalesce(sum((objects.metadata ->> 'size')::bigint), 0) as object_bytes
  from storage.buckets as buckets
  left join storage.objects as objects
    on objects.bucket_id = buckets.id
  group by buckets.id, buckets.public
) as bucket_counts;

select 'storage_policy_count=' || count(*)::text
from pg_catalog.pg_policy as policies
join pg_catalog.pg_class as relations on relations.oid = policies.polrelid
join pg_catalog.pg_namespace as namespaces on namespaces.oid = relations.relnamespace
where namespaces.nspname = 'storage'
  and relations.relname = 'objects';

select 'auth_user_trigger_count=' || count(*)::text
from pg_catalog.pg_trigger as triggers
join pg_catalog.pg_class as relations on relations.oid = triggers.tgrelid
join pg_catalog.pg_namespace as namespaces on namespaces.oid = relations.relnamespace
where namespaces.nspname = 'auth'
  and relations.relname = 'users'
  and not triggers.tgisinternal;

select 'migration_history_count=' || case
  when pg_catalog.to_regclass('supabase_migrations.schema_migrations') is null then '0'
  else (pg_catalog.xpath(
    '/row/count/text()',
    pg_catalog.query_to_xml(
      'select count(*) as count from supabase_migrations.schema_migrations',
      false,
      true,
      ''
    )
  ))[1]::text
end;

select 'migration_versions=' || case
  when pg_catalog.to_regclass('supabase_migrations.schema_migrations') is null then ''
  else coalesce(
    (pg_catalog.xpath(
      '/row/value/text()',
      pg_catalog.query_to_xml(
        'select coalesce(string_agg(version, '','' order by version), '''') as value from supabase_migrations.schema_migrations',
        false,
        true,
        ''
      )
    ))[1]::text,
    ''
  )
end;

select 'installed_extensions=' || coalesce(
  pg_catalog.string_agg(extensions.extname, ',' order by extensions.extname),
  ''
)
from pg_catalog.pg_extension as extensions;

select 'realtime_publication_tables=' || coalesce(
  pg_catalog.string_agg(tables.schemaname || '.' || tables.tablename, ',' order by tables.schemaname, tables.tablename),
  ''
)
from pg_catalog.pg_publication_tables as tables
where tables.pubname = 'supabase_realtime';

select 'cron_job_counts=' || case
  when pg_catalog.to_regclass('cron.job') is null then '{"total":0,"active":0}'
  else (pg_catalog.xpath(
    '/row/value/text()',
    pg_catalog.query_to_xml(
      'select jsonb_build_object(''total'', count(*), ''active'', count(*) filter (where active)) as value from cron.job',
      false,
      true,
      ''
    )
  ))[1]::text
end;

select 'net_queue_count=' || case
  when pg_catalog.to_regclass('net.http_request_queue') is null then '0'
  else (pg_catalog.xpath(
    '/row/count/text()',
    pg_catalog.query_to_xml('select count(*) as count from net.http_request_queue', false, true, '')
  ))[1]::text
end;

select 'vault_secret_count=' || case
  when pg_catalog.to_regclass('vault.secrets') is null then '0'
  else (pg_catalog.xpath(
    '/row/count/text()',
    pg_catalog.query_to_xml('select count(*) as count from vault.secrets', false, true, '')
  ))[1]::text
end;

select 'enabled_worker_jobs=' || case
  when pg_catalog.to_regclass('public.motorist_job_controls') is null then '0'
  else (pg_catalog.xpath(
    '/row/count/text()',
    pg_catalog.query_to_xml(
      'select count(*) as count from public.motorist_job_controls where enabled',
      false,
      true,
      ''
    )
  ))[1]::text
end;
