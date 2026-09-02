-- This guard runs again inside the restore transaction. The target is kept
-- quarantined from application traffic. The advisory lock coordinates all
-- migration scripts, while ACCESS EXCLUSIVE locks prevent concurrent platform
-- row writes until commit. PostgreSQL has no universal lock for unrelated DDL,
-- so target quarantine and the post-restore inventory remain required gates.
do $restore_lock$
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtext('motorist-dispatch-target-restore')
  ) then
    raise exception 'TARGET_RESTORE_ALREADY_RUNNING';
  end if;
end;
$restore_lock$;

lock table auth.users, storage.buckets, storage.objects in access exclusive mode;

do $migration_guard$
declare
  public_tables bigint;
  auth_users bigint;
  storage_buckets bigint;
  migration_rows bigint;
  vault_secrets bigint;
begin
  if pg_catalog.to_regclass('vault.secrets') is not null then
    execute 'lock table vault.secrets in access exclusive mode';
  end if;
  if pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null then
    execute 'lock table supabase_migrations.schema_migrations in access exclusive mode';
  end if;

  select count(*)
  into public_tables
  from pg_catalog.pg_class as relations
  join pg_catalog.pg_namespace as namespaces
    on namespaces.oid = relations.relnamespace
  where namespaces.nspname = 'public'
    and relations.relkind in ('r', 'p');

  select count(*) into auth_users from auth.users;
  select count(*) into storage_buckets from storage.buckets;
  if pg_catalog.to_regclass('supabase_migrations.schema_migrations') is null then
    migration_rows := 0;
  else
    execute 'select count(*) from supabase_migrations.schema_migrations'
      into migration_rows;
  end if;

  if pg_catalog.to_regclass('vault.secrets') is null then
    vault_secrets := 0;
  else
    execute 'select count(*) from vault.secrets' into vault_secrets;
  end if;

  if public_tables <> 0
    or auth_users <> 0
    or storage_buckets <> 0
    or migration_rows <> 0
    or vault_secrets <> 0 then
    raise exception 'TARGET_NOT_EMPTY'
      using detail = pg_catalog.format(
        'public_tables=%s auth_users=%s storage_buckets=%s migration_rows=%s vault_secrets=%s',
        public_tables,
        auth_users,
        storage_buckets,
        migration_rows,
        vault_secrets
      );
  end if;
end;
$migration_guard$;
