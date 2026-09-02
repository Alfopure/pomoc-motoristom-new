\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset pager off

begin isolation level repeatable read read only;
set local timezone = 'UTC';
set local datestyle = 'ISO, YMD';
set local intervalstyle = 'iso_8601';
set local bytea_output = 'hex';
set local extra_float_digits = 3;

select pg_catalog.format(
  'select %L || ''|'' || pg_catalog.count(*)::text || ''|'' || pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E''\n'' order by pg_catalog.to_jsonb(t)::text collate "C"), ''''), ''sha256''), ''hex'') from auth.%I as t;',
  table_name,
  table_name
)
from pg_catalog.unnest(array[
  'custom_oauth_providers',
  'flow_state',
  'identities',
  'mfa_amr_claims',
  'mfa_challenges',
  'mfa_factors',
  'one_time_tokens',
  'oauth_authorizations',
  'oauth_client_states',
  'oauth_clients',
  'oauth_consents',
  'refresh_tokens',
  'saml_providers',
  'saml_relay_states',
  'sessions',
  'sso_domains',
  'sso_providers',
  'users',
  'webauthn_challenges',
  'webauthn_credentials'
]::text[]) as selected(table_name)
where pg_catalog.to_regclass(pg_catalog.format('auth.%I', table_name)) is not null
order by table_name collate "C"
\gexec

commit;
