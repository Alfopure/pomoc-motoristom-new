create schema if not exists extensions;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'citext')
    and (select nspname from pg_namespace where oid = (select extnamespace from pg_extension where extname = 'citext')) <> 'extensions'
  then
    alter extension citext set schema extensions;
  end if;
end $$;

create index if not exists motorist_profiles_invited_by_idx
  on public.motorist_profiles (invited_by)
  where invited_by is not null;

create index if not exists motorist_profiles_access_disabled_by_idx
  on public.motorist_profiles (access_disabled_by)
  where access_disabled_by is not null;

create index if not exists motorist_auth_email_events_organization_created_at_idx
  on public.motorist_auth_email_events (organization_id, created_at desc);

create index if not exists motorist_auth_email_events_profile_id_idx
  on public.motorist_auth_email_events (profile_id)
  where profile_id is not null;

create index if not exists motorist_auth_email_events_requested_by_idx
  on public.motorist_auth_email_events (requested_by)
  where requested_by is not null;

create unique index if not exists motorist_auth_email_events_idempotency_key_idx
  on public.motorist_auth_email_events (idempotency_key)
  where idempotency_key is not null;

revoke execute on function public.motorist_prevent_last_admin_profile_loss() from public, anon, authenticated;
