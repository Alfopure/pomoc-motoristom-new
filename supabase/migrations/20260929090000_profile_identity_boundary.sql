-- Private records rely on a stable profile-to-auth-user binding. Profile
-- management already uses authorized server APIs and their service client.
begin;
revoke insert, update, delete on public.motorist_profiles from anon, authenticated;

-- Also cover any inherited column-level grants. Trusted server operations and
-- existing security-definer provisioning functions retain their authority.
create or replace function app_private.motorist_profiles_trusted_write()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'Profile changes require the authorized account service' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function app_private.motorist_profiles_trusted_write() from public, anon, authenticated;
create trigger motorist_profiles_trusted_write before insert or update or delete on public.motorist_profiles
for each row execute function app_private.motorist_profiles_trusted_write();
commit;
