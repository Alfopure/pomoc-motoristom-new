-- Aggregate-only Auth continuity evidence. It returns only counts and digests;
-- callers must not persist or emit the digests. The cutoff is substituted only
-- after strict snapshot-id validation.
with
cutoff as (
  select timestamptz '__SNAPSHOT_CUTOFF__' as value
),
watermark as (
  select (__LIVE_WATERMARK__)::timestamptz as value
),
stable_table_names(table_name) as (
  values
    ('custom_oauth_providers'::text),
    ('flow_state'::text),
    ('mfa_challenges'::text),
    ('mfa_factors'::text),
    ('oauth_authorizations'::text),
    ('oauth_client_states'::text),
    ('oauth_clients'::text),
    ('oauth_consents'::text),
    ('one_time_tokens'::text),
    ('saml_providers'::text),
    ('saml_relay_states'::text),
    ('sso_domains'::text),
    ('sso_providers'::text),
    ('webauthn_challenges'::text),
    ('webauthn_credentials'::text)
),
stable_table_fingerprints as (
  select
    names.table_name,
    ((pg_catalog.xpath('/row/row_count/text()', query_result.xml))[1]::text)::bigint as row_count,
    (pg_catalog.xpath('/row/row_digest/text()', query_result.xml))[1]::text as row_digest
  from stable_table_names as names
  cross join lateral (
    select pg_catalog.query_to_xml(
      pg_catalog.format(
        $query$
          select
            count(*)::bigint as row_count,
            pg_catalog.encode(
              extensions.digest(
                coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(t)::text, E'\n' order by pg_catalog.to_jsonb(t)::text collate "C"), ''),
                'sha256'
              ),
              'hex'
            ) as row_digest
          from auth.%I as t
        $query$,
        names.table_name
      ),
      false,
      true,
      ''
    ) as xml
  ) as query_result
),
schema_evidence as (
  select
    pg_catalog.jsonb_agg(tables.table_name order by tables.table_name) as tables,
    count(*)::bigint as table_count
  from information_schema.tables as tables
  where tables.table_schema = 'auth' and tables.table_type = 'BASE TABLE'
),
user_evidence as (
  select pg_catalog.jsonb_build_object(
    'total_count', count(*),
    'baseline_count', count(*) filter (where users.created_at <= cutoff.value),
    'baseline_key_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(users.id::text, E'\n' order by users.id::text) filter (where users.created_at <= cutoff.value), ''), 'sha256'), 'hex'),
    'baseline_credential_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.jsonb_build_object('id', users.id, 'instance_id', users.instance_id, 'aud', users.aud, 'role', users.role, 'email', users.email, 'encrypted_password', users.encrypted_password, 'email_confirmed_at', users.email_confirmed_at, 'raw_app_meta_data', users.raw_app_meta_data, 'phone', users.phone, 'phone_confirmed_at', users.phone_confirmed_at, 'confirmed_at', users.confirmed_at, 'banned_until', users.banned_until, 'is_sso_user', users.is_sso_user, 'deleted_at', users.deleted_at, 'is_anonymous', users.is_anonymous)::text, E'\n' order by users.id::text) filter (where users.created_at <= cutoff.value), ''), 'sha256'), 'hex'),
    'live_count', count(*) filter (where users.created_at > cutoff.value),
    'invalid_boundary_count', count(*) filter (where users.created_at is null),
    'baseline_deleted_after_cutoff', count(*) filter (where users.created_at <= cutoff.value and users.deleted_at > cutoff.value),
    'watermarked_count', count(*) filter (where users.created_at <= watermark.value),
    'watermarked_key_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(users.id::text, E'\n' order by users.id::text) filter (where users.created_at <= watermark.value), ''), 'sha256'), 'hex'),
    'watermarked_credential_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.jsonb_build_object('id', users.id, 'instance_id', users.instance_id, 'aud', users.aud, 'role', users.role, 'email', users.email, 'encrypted_password', users.encrypted_password, 'email_confirmed_at', users.email_confirmed_at, 'raw_app_meta_data', users.raw_app_meta_data, 'phone', users.phone, 'phone_confirmed_at', users.phone_confirmed_at, 'confirmed_at', users.confirmed_at, 'banned_until', users.banned_until, 'is_sso_user', users.is_sso_user, 'deleted_at', users.deleted_at, 'is_anonymous', users.is_anonymous)::text, E'\n' order by users.id::text) filter (where users.created_at <= watermark.value), ''), 'sha256'), 'hex'),
    'post_watermark_count', count(*) filter (where users.created_at > watermark.value)
  ) as value
  from auth.users cross join cutoff cross join watermark
),
identity_evidence as (
  select pg_catalog.jsonb_build_object(
    'total_count', count(*),
    'baseline_count', count(*) filter (where identities.created_at <= cutoff.value),
    'baseline_key_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg((identities.id::text || '|' || identities.user_id::text || '|' || identities.provider), E'\n' order by (identities.id::text || '|' || identities.user_id::text || '|' || identities.provider)) filter (where identities.created_at <= cutoff.value), ''), 'sha256'), 'hex'),
    'baseline_identity_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.jsonb_build_object('id', identities.id, 'user_id', identities.user_id, 'provider_id', identities.provider_id, 'provider', identities.provider, 'email', identities.email)::text, E'\n' order by identities.id::text) filter (where identities.created_at <= cutoff.value), ''), 'sha256'), 'hex'),
    'live_count', count(*) filter (where identities.created_at > cutoff.value),
    'invalid_boundary_count', count(*) filter (where identities.created_at is null),
    'watermarked_count', count(*) filter (where identities.created_at <= watermark.value),
    'watermarked_key_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg((identities.id::text || '|' || identities.user_id::text || '|' || identities.provider), E'\n' order by (identities.id::text || '|' || identities.user_id::text || '|' || identities.provider)) filter (where identities.created_at <= watermark.value), ''), 'sha256'), 'hex'),
    'watermarked_identity_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.jsonb_build_object('id', identities.id, 'user_id', identities.user_id, 'provider_id', identities.provider_id, 'provider', identities.provider, 'email', identities.email)::text, E'\n' order by identities.id::text) filter (where identities.created_at <= watermark.value), ''), 'sha256'), 'hex'),
    'post_watermark_count', count(*) filter (where identities.created_at > watermark.value)
  ) as value
  from auth.identities cross join cutoff cross join watermark
),
volatile_counts as (
  select pg_catalog.jsonb_build_object(
    'flow_state', (select count(*) from auth.flow_state),
    'mfa_amr_claims', (select count(*) from auth.mfa_amr_claims),
    'mfa_challenges', (select count(*) from auth.mfa_challenges),
    'mfa_factors', (select count(*) from auth.mfa_factors),
    'oauth_authorizations', (select count(*) from auth.oauth_authorizations),
    'oauth_client_states', (select count(*) from auth.oauth_client_states),
    'oauth_consents', (select count(*) from auth.oauth_consents),
    'one_time_tokens', (select count(*) from auth.one_time_tokens),
    'refresh_tokens', (select count(*) from auth.refresh_tokens),
    'saml_relay_states', (select count(*) from auth.saml_relay_states),
    'sessions', (select count(*) from auth.sessions),
    'webauthn_challenges', (select count(*) from auth.webauthn_challenges),
    'webauthn_credentials', (select count(*) from auth.webauthn_credentials)
  ) as value
),
orphan_counts as (
  select pg_catalog.jsonb_build_object(
    'identities', (select count(*) from auth.identities where not exists (select 1 from auth.users where users.id = identities.user_id)),
    'sessions', (select count(*) from auth.sessions where not exists (select 1 from auth.users where users.id = sessions.user_id)),
    'refresh_tokens', (select count(*) from auth.refresh_tokens where user_id is not null and not exists (select 1 from auth.users where users.id::text = refresh_tokens.user_id)),
    'mfa_factors', (select count(*) from auth.mfa_factors where not exists (select 1 from auth.users where users.id = mfa_factors.user_id)),
    'mfa_amr_claims', (select count(*) from auth.mfa_amr_claims where not exists (select 1 from auth.sessions where sessions.id = mfa_amr_claims.session_id))
    , 'live_users_without_profile', (select count(*) from auth.users cross join cutoff where users.created_at > cutoff.value and not exists (select 1 from public.profiles where profiles.id = users.id))
    , 'live_users_without_identity', (select count(*) from auth.users cross join cutoff where users.created_at > cutoff.value and not exists (select 1 from auth.identities where identities.user_id = users.id))
  ) as value
)
select pg_catalog.jsonb_build_object(
  'watermark_utc', pg_catalog.to_char(
    (select value from watermark) at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS"Z"'
  ),
  'schema_tables', (select tables from schema_evidence),
  'schema_table_count', (select table_count from schema_evidence),
  'stable_tables', (select pg_catalog.jsonb_object_agg(table_name, pg_catalog.jsonb_build_object('row_count', row_count, 'row_digest', row_digest) order by table_name) from stable_table_fingerprints),
  'users', (select value from user_evidence),
  'identities', (select value from identity_evidence),
  'volatile_counts', (select value from volatile_counts),
  'orphan_counts', (select value from orphan_counts)
) as continuity;
