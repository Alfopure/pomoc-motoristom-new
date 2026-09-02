select parity.table_name, parity.row_count, parity.row_digest
from (
  select
    'custom_oauth_providers'::text as table_name,
    pg_catalog.count(*)::bigint as row_count,
    pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex') as row_digest
  from auth.custom_oauth_providers as t
  union all
  select 'flow_state', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.flow_state as t
  union all
  select 'identities', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.identities as t
  union all
  select 'mfa_amr_claims', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.mfa_amr_claims as t
  union all
  select 'mfa_challenges', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.mfa_challenges as t
  union all
  select 'mfa_factors', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.mfa_factors as t
  union all
  select 'oauth_authorizations', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.oauth_authorizations as t
  union all
  select 'oauth_client_states', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.oauth_client_states as t
  union all
  select 'oauth_clients', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.oauth_clients as t
  union all
  select 'oauth_consents', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.oauth_consents as t
  union all
  select 'one_time_tokens', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.one_time_tokens as t
  union all
  select 'refresh_tokens', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.refresh_tokens as t
  union all
  select 'saml_providers', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.saml_providers as t
  union all
  select 'saml_relay_states', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.saml_relay_states as t
  union all
  select 'sessions', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.sessions as t
  union all
  select 'sso_domains', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.sso_domains as t
  union all
  select 'sso_providers', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.sso_providers as t
  union all
  select 'users', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.users as t
  union all
  select 'webauthn_challenges', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.webauthn_challenges as t
  union all
  select 'webauthn_credentials', pg_catalog.count(*)::bigint, pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''), 'sha256'), 'hex')
  from auth.webauthn_credentials as t
  union all
  select
    '__auth_schema__',
    pg_catalog.count(*)::bigint,
    pg_catalog.encode(
      extensions.digest(
        coalesce(pg_catalog.string_agg(tables.table_name, E'\n' order by tables.table_name collate "C"), ''),
        'sha256'
      ),
      'hex'
    )
  from information_schema.tables
  where tables.table_schema = 'auth'
    and tables.table_type = 'BASE TABLE'
) as parity
order by parity.table_name collate "C";
