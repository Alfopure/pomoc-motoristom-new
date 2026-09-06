-- Optional runtime configuration when Vercel env management is unavailable.
-- Provision one stable JSON secret named motorist_web_push_vapid separately;
-- migrations and requests never generate, rotate or overwrite signing keys.
create or replace function public.motorist_get_web_push_config()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret_value text;
  config jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'Service role required';
  end if;

  select secrets.decrypted_secret into secret_value
  from vault.decrypted_secrets as secrets
  where secrets.name = 'motorist_web_push_vapid';

  if secret_value is null then
    return null;
  end if;

  begin
    config := secret_value::jsonb;
  exception when invalid_text_representation then
    -- Do not put malformed secret contents in a database/API error message.
    return null;
  end;

  return pg_catalog.jsonb_build_object(
    'publicKey', config ->> 'publicKey',
    'privateKey', config ->> 'privateKey',
    'subject', config ->> 'subject'
  );
end;
$$;

revoke all on function public.motorist_get_web_push_config() from public, anon, authenticated;
grant execute on function public.motorist_get_web_push_config() to service_role;

comment on function public.motorist_get_web_push_config() is
  'Service-role-only read of the single motorist_web_push_vapid Vault secret. No arbitrary secret lookup or mutation.';
