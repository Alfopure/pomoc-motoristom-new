-- Aggregate-only live-target continuity evidence. The cutoff placeholder is
-- replaced only after the snapshot id has passed a strict timestamp check.
-- This returns no row values, identifiers, object names, or secret values.
with
cutoff as (
  select timestamptz '__SNAPSHOT_CUTOFF__' as value
),
operational_baseline as (
  select timestamptz '2026-07-14T18:47:01Z' as value
),
watermark as (
  select (__LIVE_WATERMARK__)::timestamptz as value
),
validation_mode as (
  select '__LIVE_VALIDATION_MODE__'::text as value
),
column_contract as (
  select
    array['role']::text[] as profile_updates,
    array[
      'archive_reason',
      'archived_at',
      'archived_by',
      'assistance_service',
      'case_number',
      'customer_email',
      'customer_name',
      'customer_personal_number',
      'customer_phone',
      'is_concept',
      'is_draft',
      'is_towing_pickup',
      'is_towing_return',
      'pickup_comment',
      'pickup_customer_signature_exception_reason',
      'pickup_date',
      'pickup_equipment',
      'pickup_fuel_level',
      'pickup_insurance_document',
      'pickup_km',
      'pickup_location',
      'pickup_registration_document',
      'pickup_signature_customer',
      'pickup_signature_pm',
      'pickup_time',
      'planned_return_date',
      'return_by',
      'return_comment',
      'return_date',
      'return_equipment',
      'return_fuel_level',
      'return_insurance_document',
      'return_km',
      'return_location',
      'return_registration_document',
      'return_signature_customer',
      'return_signature_pm',
      'return_time',
      'status'
    ]::text[] as rental_updates,
    array[
      'brand',
      'current_km',
      'insurance_valid_until',
      'license_plate',
      'model',
      'notes',
      'photo_url',
      'status',
      'stk_valid_until'
    ]::text[] as vehicle_updates
),
operational_contract as (
  select pg_catalog.jsonb_build_object(
    'boundaryColumn', 'created_at',
    'operationalBaselineUtc', '2026-07-14T18:47:01Z',
    'requiresSourceFrozenNoLiveRows', true,
    'requiresBaselineKeyEquality', true,
    'requiresBaselineImmutableProjectionEquality', true,
    'requiresWatermarkReplay', true,
    'requiresZeroInvalidLiveRows', true,
    'tables', pg_catalog.jsonb_build_object(
      'motorist_call_events', pg_catalog.jsonb_build_object(
        'mode', 'append_only',
        'providers', pg_catalog.jsonb_build_array('viptel'),
        'eventTypes', pg_catalog.jsonb_build_array(
          'call.begin',
          'call.create_response',
          'call.end',
          'call.pickup',
          'queue.join',
          'queue.left'
        ),
        'handledStatuses', pg_catalog.jsonb_build_array('processed'),
        'requiresLinkedCall', true
      ),
      'motorist_call_recordings', pg_catalog.jsonb_build_object(
        'mode', 'mutable_then_watermarked',
        'providers', pg_catalog.jsonb_build_array('viptel'),
        'statuses', pg_catalog.jsonb_build_array('available'),
        'storageBucket', 'motorist-call-recordings',
        'requiredCallStatuses', pg_catalog.jsonb_build_array('ended'),
        'requiresPayloadMetadata', true
      ),
      'motorist_calls', pg_catalog.jsonb_build_object(
        'mode', 'mutable_then_watermarked',
        'baselineMutableColumns', pg_catalog.jsonb_build_array(
          'end_reason',
          'provider_call_id',
          'raw_latest_payload',
          'updated_at'
        ),
        'providers', pg_catalog.jsonb_build_array('viptel'),
        'directions', pg_catalog.jsonb_build_array('inbound', 'outbound'),
        'statuses', pg_catalog.jsonb_build_array('ended', 'failed', 'incoming', 'missed'),
        'requiresProviderIdentity', true,
        'requiresStartedAt', true
      ),
      'motorist_integration_raw_events', pg_catalog.jsonb_build_object(
        'mode', 'append_only',
        'contracts', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'provider', 'commander',
            'channel', 'rest',
            'direction', 'inbound',
            'statusCode', 200,
            'eventTypes', pg_catalog.jsonb_build_array('commander.positions', 'commander.vehicles')
          ),
          pg_catalog.jsonb_build_object(
            'provider', 'viptel',
            'channel', 'internal',
            'direction', 'inbound',
            'statusCode', 200,
            'eventTypes', pg_catalog.jsonb_build_array('recordings.sync_summary', 'transcripts.process_summary')
          ),
          pg_catalog.jsonb_build_object(
            'provider', 'webdispecink',
            'channel', 'rest',
            'direction', 'outbound',
            'statusCode', null,
            'eventTypes', pg_catalog.jsonb_build_array('fleet_sync')
          )
        )
      )
    )
  ) as value
),
exact_table_names as (
  select tables.table_name
  from information_schema.tables as tables
  where tables.table_schema = 'public'
    and tables.table_type = 'BASE TABLE'
    and tables.table_name not in (
      'audit_log',
      'motorist_call_events',
      'motorist_call_recordings',
      'motorist_calls',
      'motorist_integration_raw_events',
      'motorist_job_controls',
      'motorist_job_incidents',
      'motorist_job_runs',
      'motorist_worker_status',
      'profiles',
      'rental_archive_audit',
      'rental_photos',
      'rentals',
      'vehicle_photos',
      'vehicles'
    )
),
exact_table_fingerprints as (
  select
    names.table_name,
    ((pg_catalog.xpath('/row/row_count/text()', query_result.xml))[1]::text)::bigint as row_count,
    (pg_catalog.xpath('/row/row_digest/text()', query_result.xml))[1]::text as row_digest
  from exact_table_names as names
  cross join lateral (
    select pg_catalog.query_to_xml(
      pg_catalog.format(
        $query$
          select
            count(*)::bigint as row_count,
            pg_catalog.encode(
              extensions.digest(
                count(*)::text || ':' ||
                coalesce(sum(pg_catalog.hashtextextended(pg_catalog.to_jsonb(t)::text, 0)::numeric), 0)::text || ':' ||
                coalesce(sum(pg_catalog.hashtextextended(pg_catalog.to_jsonb(t)::text, 1)::numeric), 0)::text || ':' ||
                coalesce(pg_catalog.bit_xor(pg_catalog.hashtextextended(pg_catalog.to_jsonb(t)::text, 2)), 0)::text,
                'sha256'
              ),
              'hex'
            ) as row_digest
          from public.%I as t
        $query$,
        names.table_name
      ),
      false,
      true,
      ''
    ) as xml
  ) as query_result
),
reconciled_table_evidence as (
  select pg_catalog.jsonb_build_object(
    'vehicle_photos', pg_catalog.jsonb_build_object(
      'row_count', count(*),
      'key_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(id::text, E'\n' order by id::text), ''), 'sha256'), 'hex'),
      'immutable_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg((pg_catalog.to_jsonb(vehicle_photos) - 'public_url' - 'updated_at')::text, E'\n' order by (pg_catalog.to_jsonb(vehicle_photos) - 'public_url' - 'updated_at')::text collate "C"), ''), 'sha256'), 'hex'),
      'normalized_url_digest', pg_catalog.encode(
        extensions.digest(
          coalesce(
            pg_catalog.string_agg(
              replace(
                replace(public_url, 'https://jcwbiulwuwyrnmzjjbgr.supabase.co/', 'https://PROJECT_REF.supabase.co/'),
                'https://sjcsrygkkmersoczpunh.supabase.co/',
                'https://PROJECT_REF.supabase.co/'
              ),
              E'\n' order by id::text
            ),
            ''
          ),
          'sha256'
        ),
        'hex'
      )
    )
  ) as value
  from public.vehicle_photos
),
mutable_table_evidence as (
  select 'profiles'::text as table_name,
    count(*)::bigint as total_count,
    count(*) filter (where created_at <= cutoff.value)::bigint as baseline_count,
    pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(id::text, E'\n' order by id::text) filter (where created_at <= cutoff.value), ''), 'sha256'), 'hex') as baseline_key_digest,
	    pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg((pg_catalog.to_jsonb(profiles) - (column_contract.profile_updates || array['updated_at']))::text, E'\n' order by (pg_catalog.to_jsonb(profiles) - (column_contract.profile_updates || array['updated_at']))::text collate "C") filter (where created_at <= cutoff.value), ''), 'sha256'), 'hex') as baseline_immutable_digest,
	    count(*) filter (where created_at > cutoff.value)::bigint as live_count,
	    count(*) filter (where created_at is null)::bigint as invalid_boundary_count,
    count(*) filter (where created_at <= watermark.value)::bigint as watermarked_count,
    pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(id::text, E'\n' order by id::text) filter (where created_at <= watermark.value), ''), 'sha256'), 'hex') as watermarked_key_digest,
	    pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg((pg_catalog.to_jsonb(profiles) - (column_contract.profile_updates || array['updated_at']))::text, E'\n' order by id::text) filter (where created_at <= watermark.value), ''), 'sha256'), 'hex') as watermarked_content_digest,
    count(*) filter (where created_at > watermark.value)::bigint as post_watermark_count
	  from public.profiles cross join cutoff cross join watermark cross join column_contract
	  union all
	  select 'rental_photos', count(*)::bigint,
    count(*) filter (where uploaded_at <= cutoff.value)::bigint,
    pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(id::text, E'\n' order by id::text) filter (where uploaded_at <= cutoff.value), ''), 'sha256'), 'hex'),
    pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(rental_photos)::text, E'\n' order by pg_catalog.to_jsonb(rental_photos)::text collate "C") filter (where uploaded_at <= cutoff.value), ''), 'sha256'), 'hex'),
	    count(*) filter (where uploaded_at > cutoff.value)::bigint,
	    count(*) filter (where uploaded_at is null)::bigint,
    count(*) filter (where uploaded_at <= watermark.value)::bigint,
    pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(id::text, E'\n' order by id::text) filter (where uploaded_at <= watermark.value), ''), 'sha256'), 'hex'),
    pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(rental_photos)::text, E'\n' order by id::text) filter (where uploaded_at <= watermark.value), ''), 'sha256'), 'hex'),
    count(*) filter (where uploaded_at > watermark.value)::bigint
	  from public.rental_photos cross join cutoff cross join watermark
	  union all
	  select 'rentals', count(*)::bigint,
    count(*) filter (where created_at <= cutoff.value)::bigint,
    pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(id::text, E'\n' order by id::text) filter (where created_at <= cutoff.value), ''), 'sha256'), 'hex'),
    pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg((pg_catalog.to_jsonb(rentals) - (column_contract.rental_updates || array['updated_at']))::text, E'\n' order by (pg_catalog.to_jsonb(rentals) - (column_contract.rental_updates || array['updated_at']))::text collate "C") filter (where created_at <= cutoff.value), ''), 'sha256'), 'hex'),
	    count(*) filter (where created_at > cutoff.value)::bigint,
	    count(*) filter (where created_at is null)::bigint,
    count(*) filter (where created_at <= watermark.value)::bigint,
    pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(id::text, E'\n' order by id::text) filter (where created_at <= watermark.value), ''), 'sha256'), 'hex'),
    pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg((pg_catalog.to_jsonb(rentals) - (column_contract.rental_updates || array['updated_at']))::text, E'\n' order by id::text) filter (where created_at <= watermark.value), ''), 'sha256'), 'hex'),
    count(*) filter (where created_at > watermark.value)::bigint
	  from public.rentals cross join cutoff cross join watermark cross join column_contract
	  union all
	  select 'vehicles', count(*)::bigint,
    count(*) filter (where created_at <= cutoff.value)::bigint,
    pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(id::text, E'\n' order by id::text) filter (where created_at <= cutoff.value), ''), 'sha256'), 'hex'),
    pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg((pg_catalog.to_jsonb(vehicles) - (column_contract.vehicle_updates || array['updated_at']))::text, E'\n' order by (pg_catalog.to_jsonb(vehicles) - (column_contract.vehicle_updates || array['updated_at']))::text collate "C") filter (where created_at <= cutoff.value), ''), 'sha256'), 'hex'),
	    count(*) filter (where created_at > cutoff.value)::bigint,
	    count(*) filter (where created_at is null)::bigint,
    count(*) filter (where created_at <= watermark.value)::bigint,
    pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(id::text, E'\n' order by id::text) filter (where created_at <= watermark.value), ''), 'sha256'), 'hex'),
    pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg((pg_catalog.to_jsonb(vehicles) - (column_contract.vehicle_updates || array['updated_at']))::text, E'\n' order by id::text) filter (where created_at <= watermark.value), ''), 'sha256'), 'hex'),
    count(*) filter (where created_at > watermark.value)::bigint
	  from public.vehicles cross join cutoff cross join watermark cross join column_contract
),
audit_evidence as (
  select pg_catalog.jsonb_build_object(
    'baseline_count', count(*) filter (where audit_log.created_at <= cutoff.value),
    'baseline_key_digest', pg_catalog.encode(
      extensions.digest(
        coalesce(pg_catalog.string_agg(audit_log.id::text, E'\n' order by audit_log.id::text) filter (where audit_log.created_at <= cutoff.value), ''),
        'sha256'
      ),
      'hex'
    ),
    'baseline_content_digest', pg_catalog.encode(
      extensions.digest(
        coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(audit_log)::text, E'\n' order by audit_log.id::text) filter (where audit_log.created_at <= cutoff.value), ''),
        'sha256'
      ),
      'hex'
    ),
    'invalid_boundary_count', count(*) filter (where audit_log.created_at is null),
    'watermarked_count', count(*) filter (where audit_log.created_at <= watermark.value),
    'watermarked_key_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(audit_log.id::text, E'\n' order by audit_log.id::text) filter (where audit_log.created_at <= watermark.value), ''), 'sha256'), 'hex'),
    'watermarked_content_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(audit_log)::text, E'\n' order by audit_log.id::text) filter (where audit_log.created_at <= watermark.value), ''), 'sha256'), 'hex'),
    'post_watermark_count', count(*) filter (where audit_log.created_at > watermark.value),
    'post_cutoff_count', count(*) filter (where audit_log.created_at > cutoff.value),
    'unexpected_count', count(*) filter (
      where audit_log.created_at > cutoff.value
        and (
          audit_log.table_name not in ('profiles', 'rentals', 'vehicles')
          or audit_log.action not in ('INSERT', 'UPDATE')
        )
    ),
    'delete_count', count(*) filter (
      where audit_log.created_at > cutoff.value and audit_log.action = 'DELETE'
    ),
    'invalid_update_diff_count', count(*) filter (
      where audit_log.created_at > cutoff.value
        and audit_log.action = 'UPDATE'
        and (
          pg_catalog.jsonb_typeof(audit_log.diff) is distinct from 'object'
          or audit_log.diff = '{}'::jsonb
        )
    ),
    'disallowed_update_column_count', count(*) filter (
      where audit_log.created_at > cutoff.value
        and audit_log.action = 'UPDATE'
        and exists (
          select 1
          from pg_catalog.jsonb_object_keys(
            case
              when pg_catalog.jsonb_typeof(audit_log.diff) = 'object' then audit_log.diff
              else '{}'::jsonb
            end
          ) as changed(key)
          where (audit_log.table_name = 'profiles' and changed.key <> all(column_contract.profile_updates))
             or (audit_log.table_name = 'rentals' and changed.key <> all(column_contract.rental_updates))
             or (audit_log.table_name = 'vehicles' and changed.key <> all(column_contract.vehicle_updates))
             or audit_log.table_name not in ('profiles', 'rentals', 'vehicles')
        )
    ),
    'archive_update_count', count(*) filter (
      where audit_log.created_at > cutoff.value
        and audit_log.table_name = 'rentals'
        and audit_log.action = 'UPDATE'
        and audit_log.diff ?| array['archive_reason', 'archived_at', 'archived_by']
    ),
    'insert_counts', pg_catalog.jsonb_build_object(
      'profiles', count(*) filter (where audit_log.created_at > cutoff.value and audit_log.table_name = 'profiles' and audit_log.action = 'INSERT'),
      'rentals', count(*) filter (where audit_log.created_at > cutoff.value and audit_log.table_name = 'rentals' and audit_log.action = 'INSERT'),
      'vehicles', count(*) filter (where audit_log.created_at > cutoff.value and audit_log.table_name = 'vehicles' and audit_log.action = 'INSERT')
    )
  ) as value
	  from public.audit_log cross join cutoff cross join watermark cross join column_contract
),
operational_table_evidence_rows as (
  select
    'motorist_calls'::text as table_name,
    pg_catalog.jsonb_build_object(
      'total_count', count(*),
      'baseline_count', count(*) filter (where calls.created_at <= operational_baseline.value),
      'baseline_key_digest', pg_catalog.encode(extensions.digest(
        coalesce(pg_catalog.jsonb_agg(calls.id::text order by calls.id::text collate "C")
          filter (where calls.created_at <= operational_baseline.value), '[]'::jsonb)::text,
        'sha256'
      ), 'hex'),
      'baseline_immutable_digest', pg_catalog.encode(extensions.digest(
        coalesce(pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(calls) - array[
            'end_reason',
            'provider_call_id',
            'raw_latest_payload',
            'updated_at'
          ]::text[]
          order by calls.id::text collate "C"
        ) filter (where calls.created_at <= operational_baseline.value), '[]'::jsonb)::text,
        'sha256'
      ), 'hex'),
      'live_count', count(*) filter (where calls.created_at > operational_baseline.value),
      'invalid_boundary_count', count(*) filter (where calls.created_at is null),
      'watermarked_count', count(*) filter (where calls.created_at <= watermark.value),
      'watermarked_key_digest', pg_catalog.encode(extensions.digest(
        coalesce(pg_catalog.jsonb_agg(calls.id::text order by calls.id::text collate "C")
          filter (where calls.created_at <= watermark.value), '[]'::jsonb)::text,
        'sha256'
      ), 'hex'),
      'watermarked_content_digest', pg_catalog.encode(extensions.digest(
        coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(calls) order by calls.id::text collate "C")
          filter (where calls.created_at <= watermark.value), '[]'::jsonb)::text,
        'sha256'
      ), 'hex'),
      'post_watermark_count', count(*) filter (where calls.created_at > watermark.value),
      'invalid_live_contract_count', count(*) filter (
        where calls.created_at > operational_baseline.value
          and (
            calls.provider <> 'viptel'
            or calls.direction not in ('inbound', 'outbound')
            or calls.status not in ('ended', 'failed', 'incoming', 'missed')
            or coalesce(
              nullif(pg_catalog.btrim(calls.viptel_unique_id), ''),
              nullif(pg_catalog.btrim(calls.provider_call_id), '')
            ) is null
            or calls.started_at is null
            or not exists (
              select 1
              from public.motorist_organizations as organizations
              where organizations.id = calls.organization_id
            )
          )
      )
    ) as value
  from public.motorist_calls as calls cross join operational_baseline cross join watermark

  union all

  select
    'motorist_call_events'::text as table_name,
    pg_catalog.jsonb_build_object(
      'total_count', count(*),
      'baseline_count', count(*) filter (where events.created_at <= operational_baseline.value),
      'baseline_key_digest', pg_catalog.encode(extensions.digest(
        coalesce(pg_catalog.jsonb_agg(events.id::text order by events.id::text collate "C")
          filter (where events.created_at <= operational_baseline.value), '[]'::jsonb)::text,
        'sha256'
      ), 'hex'),
      'baseline_immutable_digest', pg_catalog.encode(extensions.digest(
        coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(events) order by events.id::text collate "C")
          filter (where events.created_at <= operational_baseline.value), '[]'::jsonb)::text,
        'sha256'
      ), 'hex'),
      'live_count', count(*) filter (where events.created_at > operational_baseline.value),
      'invalid_boundary_count', count(*) filter (where events.created_at is null),
      'watermarked_count', count(*) filter (where events.created_at <= watermark.value),
      'watermarked_key_digest', pg_catalog.encode(extensions.digest(
        coalesce(pg_catalog.jsonb_agg(events.id::text order by events.id::text collate "C")
          filter (where events.created_at <= watermark.value), '[]'::jsonb)::text,
        'sha256'
      ), 'hex'),
      'watermarked_content_digest', pg_catalog.encode(extensions.digest(
        coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(events) order by events.id::text collate "C")
          filter (where events.created_at <= watermark.value), '[]'::jsonb)::text,
        'sha256'
      ), 'hex'),
      'post_watermark_count', count(*) filter (where events.created_at > watermark.value),
      'invalid_live_contract_count', count(*) filter (
        where events.created_at > operational_baseline.value
          and (
            events.provider <> 'viptel'
            or events.event_type not in (
              'call.begin',
              'call.create_response',
              'call.end',
              'call.pickup',
              'queue.join',
              'queue.left'
            )
            or events.handled_status <> 'processed'
            or events.call_id is null
            or not exists (
              select 1
              from public.motorist_calls as linked_calls
              where linked_calls.id = events.call_id
                and linked_calls.organization_id = events.organization_id
            )
          )
      )
    ) as value
  from public.motorist_call_events as events cross join operational_baseline cross join watermark

  union all

  select
    'motorist_call_recordings'::text as table_name,
    pg_catalog.jsonb_build_object(
      'total_count', count(*),
      'baseline_count', count(*) filter (where recordings.created_at <= operational_baseline.value),
      'baseline_key_digest', pg_catalog.encode(extensions.digest(
        coalesce(pg_catalog.jsonb_agg(recordings.id::text order by recordings.id::text collate "C")
          filter (where recordings.created_at <= operational_baseline.value), '[]'::jsonb)::text,
        'sha256'
      ), 'hex'),
      'baseline_immutable_digest', pg_catalog.encode(extensions.digest(
        coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(recordings) order by recordings.id::text collate "C")
          filter (where recordings.created_at <= operational_baseline.value), '[]'::jsonb)::text,
        'sha256'
      ), 'hex'),
      'live_count', count(*) filter (where recordings.created_at > operational_baseline.value),
      'invalid_boundary_count', count(*) filter (where recordings.created_at is null),
      'watermarked_count', count(*) filter (where recordings.created_at <= watermark.value),
      'watermarked_key_digest', pg_catalog.encode(extensions.digest(
        coalesce(pg_catalog.jsonb_agg(recordings.id::text order by recordings.id::text collate "C")
          filter (where recordings.created_at <= watermark.value), '[]'::jsonb)::text,
        'sha256'
      ), 'hex'),
      'watermarked_content_digest', pg_catalog.encode(extensions.digest(
        coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(recordings) order by recordings.id::text collate "C")
          filter (where recordings.created_at <= watermark.value), '[]'::jsonb)::text,
        'sha256'
      ), 'hex'),
      'post_watermark_count', count(*) filter (where recordings.created_at > watermark.value),
      'invalid_live_contract_count', count(*) filter (
        where recordings.created_at > operational_baseline.value
          and (
            recordings.provider <> 'viptel'
            or recordings.status <> 'available'
            or recordings.storage_bucket <> 'motorist-call-recordings'
            or nullif(pg_catalog.btrim(recordings.storage_path), '') is null
            or recordings.size_bytes is null
            or recordings.size_bytes < 0
            or recordings.checksum is null
            or recordings.checksum !~ '^[0-9a-f]{64}$'
            or nullif(pg_catalog.btrim(recordings.mime_type), '') is null
            or recordings.fetched_at is null
            or recordings.call_id is null
            or not exists (
              select 1
              from public.motorist_calls as linked_calls
              where linked_calls.id = recordings.call_id
                and linked_calls.organization_id = recordings.organization_id
                and linked_calls.status = 'ended'
            )
            or not exists (
              select 1
              from storage.objects as recording_objects
              where recording_objects.bucket_id = recordings.storage_bucket
                and recording_objects.name = recordings.storage_path
                and case
                  when recording_objects.metadata ->> 'size' ~ '^[0-9]+$'
                    then (recording_objects.metadata ->> 'size')::bigint
                  else null
                end = recordings.size_bytes
            )
          )
      )
    ) as value
  from public.motorist_call_recordings as recordings cross join operational_baseline cross join watermark

  union all

  select
    'motorist_integration_raw_events'::text as table_name,
    pg_catalog.jsonb_build_object(
      'total_count', count(*),
      'baseline_count', count(*) filter (where raw_events.created_at <= operational_baseline.value),
      'baseline_key_digest', pg_catalog.encode(extensions.digest(
        coalesce(pg_catalog.jsonb_agg(raw_events.id::text order by raw_events.id::text collate "C")
          filter (where raw_events.created_at <= operational_baseline.value), '[]'::jsonb)::text,
        'sha256'
      ), 'hex'),
      'baseline_immutable_digest', pg_catalog.encode(extensions.digest(
        coalesce(pg_catalog.jsonb_agg(
          pg_catalog.encode(
            extensions.digest(pg_catalog.to_jsonb(raw_events)::text, 'sha256'),
            'hex'
          )
          order by raw_events.id::text collate "C"
        )
          filter (where raw_events.created_at <= operational_baseline.value), '[]'::jsonb)::text,
        'sha256'
      ), 'hex'),
      'live_count', count(*) filter (where raw_events.created_at > operational_baseline.value),
      'invalid_boundary_count', count(*) filter (where raw_events.created_at is null),
      'watermarked_count', count(*) filter (where raw_events.created_at <= watermark.value),
      'watermarked_key_digest', pg_catalog.encode(extensions.digest(
        coalesce(pg_catalog.jsonb_agg(raw_events.id::text order by raw_events.id::text collate "C")
          filter (where raw_events.created_at <= watermark.value), '[]'::jsonb)::text,
        'sha256'
      ), 'hex'),
      'watermarked_content_digest', pg_catalog.encode(extensions.digest(
        coalesce(pg_catalog.jsonb_agg(
          pg_catalog.encode(
            extensions.digest(pg_catalog.to_jsonb(raw_events)::text, 'sha256'),
            'hex'
          )
          order by raw_events.id::text collate "C"
        )
          filter (where raw_events.created_at <= watermark.value), '[]'::jsonb)::text,
        'sha256'
      ), 'hex'),
      'post_watermark_count', count(*) filter (where raw_events.created_at > watermark.value),
      'invalid_live_contract_count', count(*) filter (
        where raw_events.created_at > operational_baseline.value
          and (
            not exists (
              select 1
              from public.motorist_organizations as organizations
              where organizations.id = raw_events.organization_id
            )
            or not (
              (
                raw_events.provider = 'commander'
                and raw_events.channel = 'rest'
                and raw_events.direction = 'inbound'
                and raw_events.status_code = 200
                and raw_events.event_type in ('commander.positions', 'commander.vehicles')
              )
              or (
                raw_events.provider = 'viptel'
                and raw_events.channel = 'internal'
                and raw_events.direction = 'inbound'
                and raw_events.status_code = 200
                and raw_events.event_type in ('recordings.sync_summary', 'transcripts.process_summary')
              )
              or (
                raw_events.provider = 'webdispecink'
                and raw_events.channel = 'rest'
                and raw_events.direction = 'outbound'
                and raw_events.status_code is null
                and raw_events.event_type = 'fleet_sync'
              )
            )
          )
      )
    ) as value
  from public.motorist_integration_raw_events as raw_events cross join operational_baseline cross join watermark
),
operational_table_evidence as (
  select pg_catalog.jsonb_object_agg(table_name, value order by table_name) as value
  from operational_table_evidence_rows
),
storage_exact_bucket_counts as (
  select
    buckets.id,
    count(objects.id) as object_count,
    coalesce(sum((objects.metadata ->> 'size')::bigint), 0) as object_bytes,
    buckets.public
  from storage.buckets as buckets
  left join storage.objects as objects on objects.bucket_id = buckets.id
  where buckets.id <> 'rental-photos'
  group by buckets.id, buckets.public
),
storage_exact_buckets as (
  select coalesce(
    pg_catalog.jsonb_object_agg(
      id,
      pg_catalog.jsonb_build_object('objects', object_count, 'bytes', object_bytes, 'public', public)
      order by id
    ),
    '{}'::jsonb
  ) as value
  from storage_exact_bucket_counts
),
storage_live_bucket as (
  select pg_catalog.jsonb_build_object(
    'objects', count(objects.id),
    'bytes', coalesce(sum((objects.metadata ->> 'size')::bigint), 0),
    'public', buckets.public,
    'baseline_count', count(objects.id) filter (where objects.created_at <= cutoff.value),
    'baseline_key_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(objects.id::text, E'\n' order by objects.id::text) filter (where objects.created_at <= cutoff.value), ''), 'sha256'), 'hex'),
    'live_count', count(objects.id) filter (where objects.created_at > cutoff.value),
    'invalid_boundary_count', count(objects.id) filter (where objects.created_at is null)
	    , 'watermarked_count', count(objects.id) filter (where objects.created_at <= watermark.value)
	    , 'watermarked_key_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.jsonb_agg(objects.name order by objects.name collate "C") filter (where objects.created_at <= watermark.value), '[]'::jsonb)::text, 'sha256'), 'hex')
	    , 'watermarked_content_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', objects.name, 'size', objects.metadata ->> 'size') order by objects.name collate "C") filter (where objects.created_at <= watermark.value), '[]'::jsonb)::text, 'sha256'), 'hex')
	    , 'legacy_watermarked_key_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(objects.name, E'\n' order by objects.name) filter (where objects.created_at <= watermark.value), ''), 'sha256'), 'hex')
	    , 'legacy_watermarked_content_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.jsonb_build_object('name', objects.name, 'size', objects.metadata ->> 'size')::text, E'\n' order by objects.name) filter (where objects.created_at <= watermark.value), ''), 'sha256'), 'hex')
	    , 'post_watermark_count', count(objects.id) filter (where objects.created_at > watermark.value)
	    , 'live_key_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.jsonb_agg(objects.name order by objects.name collate "C") filter (where objects.created_at > cutoff.value), '[]'::jsonb)::text, 'sha256'), 'hex')
  ) as value
  from storage.buckets as buckets
  left join storage.objects as objects on objects.bucket_id = buckets.id
	  cross join cutoff
	  cross join watermark
  where buckets.id = 'rental-photos'
  group by buckets.public
),
rental_archive_audit_pair_evidence as (
  select count(*) as mismatch_count
  from (
    select
      archives.rental_id,
      updates.record_id,
      coalesce(archives.archive_count, 0) as archive_count,
      coalesce(updates.update_count, 0) as update_count
    from (
      select rental_archive_audit.rental_id, count(*) as archive_count
      from public.rental_archive_audit
      cross join cutoff
      where rental_archive_audit.performed_at > cutoff.value
        and rental_archive_audit.action = 'archive'
      group by rental_archive_audit.rental_id
    ) as archives
    full outer join (
      select audit_log.record_id, count(*) as update_count
      from public.audit_log
      cross join cutoff
      where audit_log.created_at > cutoff.value
        and audit_log.table_name = 'rentals'
        and audit_log.action = 'UPDATE'
        and audit_log.diff ?| array['archive_reason', 'archived_at', 'archived_by']
      group by audit_log.record_id
    ) as updates on updates.record_id = archives.rental_id
  ) as pairs
  where pairs.archive_count <> pairs.update_count
),
append_only_table_evidence as (
  select pg_catalog.jsonb_build_object(
    'rental_archive_audit', pg_catalog.jsonb_build_object(
      'total_count', count(*),
      'baseline_count', count(*) filter (where performed_at <= cutoff.value),
      'baseline_key_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(id::text, E'\n' order by id::text) filter (where performed_at <= cutoff.value), ''), 'sha256'), 'hex'),
      'baseline_content_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(rental_archive_audit)::text, E'\n' order by id::text) filter (where performed_at <= cutoff.value), ''), 'sha256'), 'hex'),
      'live_count', count(*) filter (where performed_at > cutoff.value),
      'invalid_boundary_count', count(*) filter (where performed_at is null),
      'watermarked_count', count(*) filter (where performed_at <= watermark.value),
      'watermarked_key_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(id::text, E'\n' order by id::text) filter (where performed_at <= watermark.value), ''), 'sha256'), 'hex'),
      'watermarked_content_digest', pg_catalog.encode(extensions.digest(coalesce(pg_catalog.string_agg(pg_catalog.to_jsonb(rental_archive_audit)::text, E'\n' order by id::text) filter (where performed_at <= watermark.value), ''), 'sha256'), 'hex'),
      'post_watermark_count', count(*) filter (where performed_at > watermark.value),
      'audit_pair_mismatch_count', (select mismatch_count from rental_archive_audit_pair_evidence),
      'live_action_counts', pg_catalog.jsonb_build_object(
        'archive', count(*) filter (where performed_at > cutoff.value and action = 'archive'),
        'unexpected', count(*) filter (where performed_at > cutoff.value and action <> 'archive')
      )
    )
  ) as value
  from public.rental_archive_audit
  cross join cutoff
  cross join watermark
),
transition_row_values as (
  select
    'profiles'::text as table_name,
    profiles.id,
    profiles.created_at <= cutoff.value as baseline,
    pg_catalog.encode(
      extensions.digest(
        profiles.id::text || pg_catalog.chr(31)
          || (pg_catalog.to_jsonb(profiles) - (column_contract.profile_updates || array['updated_at']))::text,
        'sha256'
      ),
      'hex'
    ) as immutable_digest,
    changed.column_name,
    pg_catalog.to_jsonb(profiles) -> changed.column_name as column_value
  from public.profiles
  cross join cutoff
  cross join column_contract
  cross join lateral unnest(column_contract.profile_updates) as changed(column_name)
  union all
  select
    'rentals',
    rentals.id,
    rentals.created_at <= cutoff.value,
    pg_catalog.encode(
      extensions.digest(
        rentals.id::text || pg_catalog.chr(31)
          || (pg_catalog.to_jsonb(rentals) - (column_contract.rental_updates || array['updated_at']))::text,
        'sha256'
      ),
      'hex'
    ),
    changed.column_name,
    pg_catalog.to_jsonb(rentals) -> changed.column_name
  from public.rentals
  cross join cutoff
  cross join column_contract
  cross join lateral unnest(column_contract.rental_updates) as changed(column_name)
  union all
  select
    'vehicles',
    vehicles.id,
    vehicles.created_at <= cutoff.value,
    pg_catalog.encode(
      extensions.digest(
        vehicles.id::text || pg_catalog.chr(31)
          || (pg_catalog.to_jsonb(vehicles) - (column_contract.vehicle_updates || array['updated_at']))::text,
        'sha256'
      ),
      'hex'
    ),
    changed.column_name,
    pg_catalog.to_jsonb(vehicles) -> changed.column_name
  from public.vehicles
  cross join cutoff
  cross join column_contract
  cross join lateral unnest(column_contract.vehicle_updates) as changed(column_name)
),
transition_rows as (
  select
    table_name,
    baseline,
    immutable_digest,
    pg_catalog.encode(
      extensions.digest(table_name || pg_catalog.chr(31) || id::text, 'sha256'),
      'hex'
    ) as record_key,
    pg_catalog.jsonb_object_agg(
      column_name,
      pg_catalog.encode(
        extensions.digest(
          id::text || pg_catalog.chr(31) || column_name || pg_catalog.chr(31) || column_value::text,
          'sha256'
        ),
        'hex'
      )
      order by column_name
    ) as column_digests
  from transition_row_values
  group by table_name, id, baseline, immutable_digest
),
transition_audit_events as (
  select
    row_number() over (order by audit_log.created_at, audit_log.id) as sequence,
    audit_log.id,
    audit_log.action,
    audit_log.table_name,
    audit_log.record_id,
    pg_catalog.encode(
      extensions.digest(audit_log.table_name || pg_catalog.chr(31) || audit_log.record_id::text, 'sha256'),
      'hex'
    ) as record_key,
    allowed.columns,
    case
      when audit_log.action = 'INSERT' then
        pg_catalog.jsonb_typeof(audit_log.diff) = 'object'
        and not exists (
          select 1
          from unnest(allowed.columns) as required(column_name)
          where not (audit_log.diff ? required.column_name)
        )
      when audit_log.action = 'UPDATE' then
        pg_catalog.jsonb_typeof(audit_log.diff) = 'object'
        and audit_log.diff <> '{}'::jsonb
        and not exists (
          select 1
          from pg_catalog.jsonb_each(audit_log.diff) as changed(column_name, change_value)
          where changed.column_name <> all(allowed.columns)
            or pg_catalog.jsonb_typeof(changed.change_value) <> 'object'
            or not (changed.change_value ? 'old')
            or not (changed.change_value ? 'new')
            or exists (
              select 1
              from pg_catalog.jsonb_object_keys(changed.change_value) as nested(key)
              where nested.key not in ('old', 'new')
            )
        )
      else false
    end as diff_valid,
    coalesce(
      case
        when audit_log.action = 'INSERT' then (
          select pg_catalog.jsonb_agg(column_name order by column_name)
          from unnest(allowed.columns) as inserted(column_name)
          where audit_log.diff ? inserted.column_name
        )
        when audit_log.action = 'UPDATE' then (
          select pg_catalog.jsonb_agg(changed.key order by changed.key)
          from pg_catalog.jsonb_object_keys(
            case
              when pg_catalog.jsonb_typeof(audit_log.diff) = 'object' then audit_log.diff
              else '{}'::jsonb
            end
          ) as changed(key)
        )
      end,
      '[]'::jsonb
    ) as diff_keys,
    case
      when audit_log.action = 'INSERT' then (
        select count(*)
        from unnest(allowed.columns) as required(column_name)
        where not (audit_log.diff ? required.column_name)
      )
      else 0
    end as missing_allowed_column_count,
    case
      when audit_log.action = 'UPDATE' and pg_catalog.jsonb_typeof(audit_log.diff) = 'object' then coalesce(
        (
          select pg_catalog.jsonb_object_agg(
            changed.key,
            pg_catalog.encode(
              extensions.digest(
                audit_log.record_id::text || pg_catalog.chr(31) || changed.key || pg_catalog.chr(31)
                  || (changed.value -> 'old')::text,
                'sha256'
              ),
              'hex'
            )
            order by changed.key
          )
          from pg_catalog.jsonb_each(audit_log.diff) as changed(key, value)
        ),
        '{}'::jsonb
      )
      else '{}'::jsonb
    end as old_column_digests,
    coalesce(
      (
        select pg_catalog.jsonb_object_agg(
          changed.column_name,
          pg_catalog.encode(
            extensions.digest(
              audit_log.record_id::text || pg_catalog.chr(31) || changed.column_name || pg_catalog.chr(31)
                || changed.column_value::text,
              'sha256'
            ),
            'hex'
          )
          order by changed.column_name
        )
        from (
          select
            inserted.column_name,
            audit_log.diff -> inserted.column_name as column_value
          from unnest(allowed.columns) as inserted(column_name)
          where audit_log.action = 'INSERT'
            and audit_log.diff ? inserted.column_name
          union all
          select
            updated.key,
            updated.value -> 'new'
          from pg_catalog.jsonb_each(
            case
              when audit_log.action = 'UPDATE' and pg_catalog.jsonb_typeof(audit_log.diff) = 'object'
                then audit_log.diff
              else '{}'::jsonb
            end
          ) as updated(key, value)
        ) as changed(column_name, column_value)
      ),
      '{}'::jsonb
    ) as new_column_digests,
    case
      when audit_log.action = 'INSERT' and pg_catalog.jsonb_typeof(audit_log.diff) = 'object' then
        pg_catalog.encode(
          extensions.digest(
            audit_log.record_id::text || pg_catalog.chr(31)
              || (audit_log.diff - (allowed.columns || array['updated_at']))::text,
            'sha256'
          ),
          'hex'
        )
      else null
    end as new_immutable_digest
  from public.audit_log
  cross join cutoff
  cross join lateral (
    select case audit_log.table_name
      when 'profiles' then column_contract.profile_updates
      when 'rentals' then column_contract.rental_updates
      when 'vehicles' then column_contract.vehicle_updates
      else array[]::text[]
    end as columns
    from column_contract
  ) as allowed
  where audit_log.created_at > cutoff.value
    and audit_log.action in ('INSERT', 'UPDATE')
    and audit_log.table_name in ('profiles', 'rentals', 'vehicles')
),
transition_evidence as (
  select pg_catalog.jsonb_build_object(
    'schemaVersion', 3,
    'rows', coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'table', transition_rows.table_name,
            'recordKey', transition_rows.record_key,
            'baseline', transition_rows.baseline,
            'immutableDigest', transition_rows.immutable_digest,
            'columnDigests', transition_rows.column_digests
          )
          order by transition_rows.table_name, transition_rows.record_key
        )
        from transition_rows
      ),
      '[]'::jsonb
    ),
    'events', coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'sequence', transition_audit_events.sequence,
            'eventKey', pg_catalog.encode(extensions.digest(transition_audit_events.id::text, 'sha256'), 'hex'),
            'action', transition_audit_events.action,
            'table', transition_audit_events.table_name,
            'recordKey', transition_audit_events.record_key,
            'diffValid', transition_audit_events.diff_valid,
            'diffKeys', transition_audit_events.diff_keys,
            'oldColumnDigests', transition_audit_events.old_column_digests,
            'newColumnDigests', transition_audit_events.new_column_digests,
            'newImmutableDigest', transition_audit_events.new_immutable_digest,
            'missingAllowedColumnCount', transition_audit_events.missing_allowed_column_count
          )
          order by transition_audit_events.sequence
        )
        from transition_audit_events
      ),
      '[]'::jsonb
    )
  ) as value
),
worker_state as (
  select pg_catalog.jsonb_build_object(
    'motorist_job_controls', case when pg_catalog.to_regclass('public.motorist_job_controls') is null then -1 else (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml('select count(*) as count from public.motorist_job_controls', false, true, '')))[1]::text::bigint end,
    'enabled_job_controls', case when pg_catalog.to_regclass('public.motorist_job_controls') is null then -1 else (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml('select count(*) as count from public.motorist_job_controls where enabled', false, true, '')))[1]::text::bigint end,
    'motorist_job_incidents', case when pg_catalog.to_regclass('public.motorist_job_incidents') is null then -1 else (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml('select count(*) as count from public.motorist_job_incidents', false, true, '')))[1]::text::bigint end,
    'motorist_job_runs', case when pg_catalog.to_regclass('public.motorist_job_runs') is null then -1 else (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml('select count(*) as count from public.motorist_job_runs', false, true, '')))[1]::text::bigint end,
    'motorist_worker_status', case when pg_catalog.to_regclass('public.motorist_worker_status') is null then -1 else (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml('select count(*) as count from public.motorist_worker_status', false, true, '')))[1]::text::bigint end,
    'expected_worker_identity_rows', case when pg_catalog.to_regclass('public.motorist_worker_status') is null then -1 else (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml($query$select count(*) as count from public.motorist_worker_status where instance_id = 'motorist-prod-01'$query$, false, true, '')))[1]::text::bigint end,
    'expected_listener_identity_rows', case when pg_catalog.to_regclass('public.motorist_worker_status') is null then -1 else (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml($query$select count(*) as count from public.motorist_worker_status where instance_id = 'motorist-prod-01-viptel'$query$, false, true, '')))[1]::text::bigint end,
    'unexpected_identity_rows', case when pg_catalog.to_regclass('public.motorist_worker_status') is null then -1 else (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml($query$select count(*) as count from public.motorist_worker_status where instance_id not in ('motorist-prod-01', 'motorist-prod-01-viptel')$query$, false, true, '')))[1]::text::bigint end,
    'duplicate_identity_rows', case when pg_catalog.to_regclass('public.motorist_worker_status') is null then -1 else (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml($query$select coalesce(sum(rows - 1), 0) as count from (select count(*) as rows from public.motorist_worker_status group by instance_id having count(*) > 1) as duplicates$query$, false, true, '')))[1]::text::bigint end,
    'unsafe_state_rows', case when pg_catalog.to_regclass('public.motorist_worker_status') is null then -1 else (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml($query$select count(*) as count from public.motorist_worker_status where not ((instance_id = 'motorist-prod-01' and scheduler_status = 'disabled' and viptel_ws_status = 'disabled' and scheduler_tick_at is null and last_viptel_event_at is null) or (instance_id = 'motorist-prod-01-viptel' and scheduler_status = 'listener' and viptel_ws_status = 'disabled' and scheduler_tick_at is null))$query$, false, true, '')))[1]::text::bigint end,
    'active_scheduler_rows', case when pg_catalog.to_regclass('public.motorist_worker_status') is null then -1 else (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml($query$select count(*) as count from public.motorist_worker_status where scheduler_status in ('running', 'draining') or scheduler_tick_at is not null$query$, false, true, '')))[1]::text::bigint end,
    'active_listener_rows', case when pg_catalog.to_regclass('public.motorist_worker_status') is null then -1 else (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml($query$select count(*) as count from public.motorist_worker_status where scheduler_status = 'listener' and viptel_ws_status is distinct from 'disabled'$query$, false, true, '')))[1]::text::bigint end,
    'invalid_timestamp_rows', case when pg_catalog.to_regclass('public.motorist_worker_status') is null then -1 else (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml($query$select count(*) as count from public.motorist_worker_status where heartbeat_at is null or updated_at is null or heartbeat_at > now() + interval '1 minute' or updated_at > now() + interval '1 minute' or heartbeat_at > updated_at + interval '5 seconds' or last_viptel_event_at > heartbeat_at + interval '5 seconds'$query$, false, true, '')))[1]::text::bigint end,
    'non_release_version_rows', case when pg_catalog.to_regclass('public.motorist_worker_status') is null then -1 else (pg_catalog.xpath('/row/count/text()', pg_catalog.query_to_xml($query$select count(*) as count from public.motorist_worker_status where deployment_version is null or deployment_version !~ '^hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$'$query$, false, true, '')))[1]::text::bigint end
  ) as value
),
projection_contract as (
  select pg_catalog.jsonb_build_object(
    'allowedUpdateColumns', pg_catalog.jsonb_build_object(
      'profiles', pg_catalog.to_jsonb(column_contract.profile_updates),
      'rentals', pg_catalog.to_jsonb(column_contract.rental_updates),
      'vehicles', pg_catalog.to_jsonb(column_contract.vehicle_updates)
    ),
    'immutableProjectionExcludedColumns', pg_catalog.jsonb_build_object(
      'profiles', pg_catalog.to_jsonb(column_contract.profile_updates || array['updated_at']),
      'rental_photos', '[]'::jsonb,
      'rentals', pg_catalog.to_jsonb(column_contract.rental_updates || array['updated_at']),
      'vehicles', pg_catalog.to_jsonb(column_contract.vehicle_updates || array['updated_at'])
    )
  ) as value
  from column_contract
)
select case when validation_mode.value = 'bounded' then pg_catalog.jsonb_build_object(
  'watermark_utc', pg_catalog.to_char(
    (select value from watermark) at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS"Z"'
  ),
  'mutable_tables', (
    select pg_catalog.jsonb_object_agg(
      table_name,
      pg_catalog.jsonb_build_object(
        'watermarked_count', watermarked_count,
        'watermarked_key_digest', watermarked_key_digest,
        'watermarked_content_digest', watermarked_content_digest,
        'post_watermark_count', post_watermark_count
      )
      order by table_name
    )
    from mutable_table_evidence
  ),
  'audit', (select value from audit_evidence),
  'operational_contract', (select value from operational_contract),
  'operational_tables', (select value from operational_table_evidence),
  'storage_live_bucket', coalesce((select value from storage_live_bucket), '{}'::jsonb),
  'append_only_tables', (select value from append_only_table_evidence)
) else pg_catalog.jsonb_build_object(
  'exact_tables', coalesce((select pg_catalog.jsonb_object_agg(table_name, pg_catalog.jsonb_build_object('row_count', row_count, 'row_digest', row_digest) order by table_name) from exact_table_fingerprints), '{}'::jsonb),
  'reconciled_tables', (select value from reconciled_table_evidence),
	  'watermark_utc', pg_catalog.to_char(
    (select value from watermark) at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS"Z"'
  ),
	  'mutable_tables', (select pg_catalog.jsonb_object_agg(table_name, pg_catalog.jsonb_build_object('total_count', total_count, 'baseline_count', baseline_count, 'baseline_key_digest', baseline_key_digest, 'baseline_immutable_digest', baseline_immutable_digest, 'live_count', live_count, 'invalid_boundary_count', invalid_boundary_count, 'watermarked_count', watermarked_count, 'watermarked_key_digest', watermarked_key_digest, 'watermarked_content_digest', watermarked_content_digest, 'post_watermark_count', post_watermark_count) order by table_name) from mutable_table_evidence),
  'audit', (select value from audit_evidence),
  'operational_contract', (select value from operational_contract),
  'operational_tables', (select value from operational_table_evidence),
  'storage_exact_buckets', (select value from storage_exact_buckets),
  'storage_live_bucket', coalesce((select value from storage_live_bucket), '{}'::jsonb),
	  'append_only_tables', (select value from append_only_table_evidence),
	  'projection_contract', (select value from projection_contract),
  'transition_evidence', (select value from transition_evidence),
  'worker_state', (select value from worker_state),
  'integrity', pg_catalog.jsonb_build_object(
    'all_photo_without_metadata', (select count(*) from public.rental_photos as photos where not exists (select 1 from storage.objects where objects.bucket_id = 'rental-photos' and objects.name = photos.storage_path)),
    'all_metadata_without_photo', (select count(*) from storage.objects as objects where objects.bucket_id = 'rental-photos' and not exists (select 1 from public.rental_photos where rental_photos.storage_path = objects.name)),
    'all_metadata_without_photo_digest', (
      select pg_catalog.encode(
        extensions.digest(
          coalesce(pg_catalog.jsonb_agg(objects.name order by objects.name collate "C"), '[]'::jsonb)::text,
          'sha256'
        ),
        'hex'
      )
      from storage.objects as objects
      where objects.bucket_id = 'rental-photos'
        and not exists (select 1 from public.rental_photos where rental_photos.storage_path = objects.name)
    ),
    'new_photo_orphans', (select count(*) from public.rental_photos as photos cross join cutoff where photos.uploaded_at > cutoff.value and not exists (select 1 from public.rentals where rentals.id = photos.rental_id)),
    'new_profile_auth_orphans', (select count(*) from public.profiles as profiles cross join cutoff where profiles.created_at > cutoff.value and not exists (select 1 from auth.users where users.id = profiles.id)),
    'new_photo_without_metadata', (select count(*) from public.rental_photos as photos cross join cutoff where photos.uploaded_at > cutoff.value and not exists (select 1 from storage.objects where objects.bucket_id = 'rental-photos' and objects.name = photos.storage_path)),
    'new_metadata_without_photo', (select count(*) from storage.objects as objects cross join cutoff where objects.bucket_id = 'rental-photos' and objects.created_at > cutoff.value and not exists (select 1 from public.rental_photos where rental_photos.storage_path = objects.name)),
    'new_archive_audit_without_rental', (select count(*) from public.rental_archive_audit as archive cross join cutoff where archive.performed_at > cutoff.value and (archive.rental_id is null or not exists (select 1 from public.rentals where rentals.id = archive.rental_id))),
    'duplicate_photo_storage_paths', (select count(*) from (select storage_path from public.rental_photos group by storage_path having count(*) > 1) as duplicates),
    'source_ref_photo_urls', (select count(*) from public.vehicle_photos where public_url like 'https://jcwbiulwuwyrnmzjjbgr.supabase.co/%') + (select count(*) from public.vehicles where photo_url like 'https://jcwbiulwuwyrnmzjjbgr.supabase.co/%')
  )
) end as continuity
from validation_mode;
