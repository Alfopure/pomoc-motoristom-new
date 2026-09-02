import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  EXACT_AUTH_CHURN_TABLES,
  OPERATIONAL_CONTINUITY_TABLES,
  validateAuthContinuity,
  validateLiveAuthCheckpoint,
  validateLivePublicCheckpoint,
  validatePreviousBoundedEvidence,
  validatePublicContinuity,
} from '../deploy/bin/validate-live-target-continuity.mjs';
import { readSecureFileSnapshot } from '../deploy/bin/secure-file-snapshot.mjs';
import { validateTargetReconciliationReceipts } from '../deploy/bin/target-reconciliation-receipts.mjs';

const policy = JSON.parse(readFileSync('deploy/supabase/live-target-continuity-policy.json', 'utf8'));

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileDigest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function valueDigest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function operationalEvidence(table, { baseline = 2, live = 0 } = {}) {
  const total = baseline + live;
  return {
    total_count: total,
    baseline_count: baseline,
    baseline_key_digest: digest(`${table}:baseline-key`),
    baseline_immutable_digest: digest(`${table}:baseline-content`),
    live_count: live,
    invalid_boundary_count: 0,
    watermarked_count: total,
    watermarked_key_digest: digest(`${table}:watermarked-key:${total}`),
    watermarked_content_digest: digest(`${table}:watermarked-content:${total}`),
    post_watermark_count: 0,
    invalid_live_contract_count: 0,
  };
}

function publicEvidence() {
  const baselineCounts = { profiles: 34, rental_photos: 2821, rentals: 1085, vehicles: 70 };
  const mutable = Object.fromEntries(Object.entries(baselineCounts).map(([table, count]) => [table, {
    total_count: count,
    baseline_count: count,
    baseline_key_digest: digest(table[0]),
    baseline_immutable_digest: digest(table.at(-1)),
    live_count: 0,
    invalid_boundary_count: 0,
    watermarked_count: count,
    watermarked_key_digest: digest(table[0].toUpperCase()),
    watermarked_content_digest: digest(table.at(-1).toUpperCase()),
    post_watermark_count: 0,
  }]));
  return {
    watermark_utc: '2026-07-15T10:00:00Z',
    projection_contract: {
      allowedUpdateColumns: structuredClone(policy.publicData.allowedUpdateColumns),
      immutableProjectionExcludedColumns: structuredClone(
        policy.publicData.immutableProjectionExcludedColumns,
      ),
    },
    exact_tables: { organizations: { row_count: 2, row_digest: digest('e') } },
    reconciled_tables: {
      vehicle_photos: {
        row_count: 16,
        key_digest: digest('k'),
        immutable_digest: digest('i'),
        normalized_url_digest: digest('u'),
      },
    },
    operational_contract: structuredClone(policy.publicData.operationalContinuity),
    operational_tables: Object.fromEntries(
      OPERATIONAL_CONTINUITY_TABLES.map((table) => [table, operationalEvidence(table)]),
    ),
    mutable_tables: mutable,
    audit: {
      baseline_count: 5648,
      baseline_key_digest: digest('g'),
      baseline_content_digest: digest('h'),
      invalid_boundary_count: 0,
      watermarked_count: 5648,
      watermarked_key_digest: digest('A'),
      watermarked_content_digest: digest('B'),
      post_watermark_count: 0,
      post_cutoff_count: 0,
      unexpected_count: 0,
      delete_count: 0,
      invalid_update_diff_count: 0,
      disallowed_update_column_count: 0,
      archive_update_count: 0,
      insert_counts: { profiles: 0, rentals: 0, vehicles: 0 },
    },
    storage_exact_buckets: { signatures: { objects: 3, bytes: 200, public: false } },
    storage_live_bucket: {
      objects: 2852,
      bytes: 1000,
      public: false,
      baseline_count: 2852,
      baseline_key_digest: digest('s'),
      live_count: 0,
      invalid_boundary_count: 0,
      watermarked_count: 2852,
      watermarked_key_digest: digest('C'),
      watermarked_content_digest: digest('D'),
      post_watermark_count: 0,
    },
    append_only_tables: {
      rental_archive_audit: {
        total_count: 40,
        baseline_count: 40,
        baseline_key_digest: digest('q'),
        baseline_content_digest: digest('r'),
        live_count: 0,
        invalid_boundary_count: 0,
        watermarked_count: 40,
        watermarked_key_digest: digest('Q'),
        watermarked_content_digest: digest('R'),
        post_watermark_count: 0,
        audit_pair_mismatch_count: 0,
        live_action_counts: { archive: 0, unexpected: 0 },
      },
    },
    worker_state: {
      motorist_job_controls: -1,
      enabled_job_controls: -1,
      motorist_job_incidents: -1,
      motorist_job_runs: -1,
      motorist_worker_status: -1,
      expected_worker_identity_rows: -1,
      expected_listener_identity_rows: -1,
      unexpected_identity_rows: -1,
      duplicate_identity_rows: -1,
      unsafe_state_rows: -1,
      active_scheduler_rows: -1,
      active_listener_rows: -1,
      invalid_timestamp_rows: -1,
      non_release_version_rows: -1,
    },
    integrity: {
      all_photo_without_metadata: 0,
      all_metadata_without_photo: 32,
      all_metadata_without_photo_digest: valueDigest('inherited-orphans'),
      new_photo_orphans: 0,
      new_profile_auth_orphans: 0,
      new_photo_without_metadata: 0,
      new_metadata_without_photo: 0,
      new_archive_audit_without_rental: 0,
      duplicate_photo_storage_paths: 1,
      source_ref_photo_urls: 16,
    },
    transition_evidence: {
      schemaVersion: 3,
      rows: policy.publicData.auditedTables.map((table, index) => ({
        table,
        recordKey: valueDigest(String(index + 1)),
        baseline: true,
        immutableDigest: valueDigest(`immutable-${table}-${index}`),
        columnDigests: Object.fromEntries(
          policy.publicData.allowedUpdateColumns[table].map((column) => [column, valueDigest(column)]),
        ),
      })),
      events: [],
    },
  };
}

function livePublicEvidence() {
  const target = structuredClone(publicEvidence());
  const growth = { profiles: 1, rental_photos: 156, rentals: 12, vehicles: 0 };
  for (const [table, count] of Object.entries(growth)) {
    target.mutable_tables[table].live_count = count;
    target.mutable_tables[table].total_count += count;
    target.mutable_tables[table].watermarked_count += count;
  }
  target.audit.post_cutoff_count = 14;
  target.audit.watermarked_count += 14;
  target.audit.insert_counts = { profiles: 1, rentals: 12, vehicles: 0 };
  target.audit.archive_update_count = 3;
  const rentalTransition = target.transition_evidence.rows.find((row) => row.table === 'rentals');
  const originalStatusDigest = rentalTransition.columnDigests.status;
  rentalTransition.columnDigests.status = valueDigest('changed-status');
  target.transition_evidence.events = [{
    sequence: 1,
    eventKey: valueDigest('event'),
    action: 'UPDATE',
    table: 'rentals',
    recordKey: rentalTransition.recordKey,
    diffValid: true,
    diffKeys: ['status'],
    oldColumnDigests: { status: originalStatusDigest },
    newColumnDigests: { status: rentalTransition.columnDigests.status },
    newImmutableDigest: null,
    missingAllowedColumnCount: 0,
  }];
  for (const [table, count] of Object.entries({ profiles: 1, rentals: 12 })) {
    for (let index = 0; index < count; index += 1) {
      const recordKey = valueDigest(`live-${table}-${index}`);
      const columnDigests = Object.fromEntries(
        policy.publicData.allowedUpdateColumns[table]
          .map((column) => [column, valueDigest(`live-${table}-${index}-${column}`)]),
      );
      const immutableDigest = valueDigest(`live-immutable-${table}-${index}`);
      target.transition_evidence.rows.push({
        table,
        recordKey,
        baseline: false,
        immutableDigest,
        columnDigests,
      });
      target.transition_evidence.events.push({
        sequence: target.transition_evidence.events.length + 1,
        eventKey: valueDigest(`insert-${table}-${index}`),
        action: 'INSERT',
        table,
        recordKey,
        diffValid: true,
        diffKeys: [...policy.publicData.allowedUpdateColumns[table]].sort(),
        oldColumnDigests: {},
        newColumnDigests: columnDigests,
        newImmutableDigest: immutableDigest,
        missingAllowedColumnCount: 0,
      });
    }
  }
  target.storage_live_bucket.objects += 156;
  target.storage_live_bucket.bytes += 500;
  target.storage_live_bucket.live_count = 156;
  target.storage_live_bucket.watermarked_count += 156;
  target.append_only_tables.rental_archive_audit.total_count += 3;
  target.append_only_tables.rental_archive_audit.live_count = 3;
  target.append_only_tables.rental_archive_audit.watermarked_count += 3;
  target.append_only_tables.rental_archive_audit.live_action_counts.archive = 3;
  const operationalGrowth = {
    motorist_call_events: 6,
    motorist_call_recordings: 1,
    motorist_calls: 55,
    motorist_integration_raw_events: 16,
  };
  for (const [table, live] of Object.entries(operationalGrowth)) {
    const current = target.operational_tables[table];
    current.live_count = live;
    current.total_count += live;
    current.watermarked_count += live;
    current.watermarked_key_digest = digest(`${table}:live-key:${live}`);
    current.watermarked_content_digest = digest(`${table}:live-content:${live}`);
  }
  target.worker_state = {
    motorist_job_controls: 11,
    enabled_job_controls: 0,
    motorist_job_incidents: 0,
    motorist_job_runs: 0,
    motorist_worker_status: 2,
    expected_worker_identity_rows: 1,
    expected_listener_identity_rows: 1,
    unexpected_identity_rows: 0,
    duplicate_identity_rows: 0,
    unsafe_state_rows: 0,
    active_scheduler_rows: 0,
    active_listener_rows: 0,
    invalid_timestamp_rows: 0,
    non_release_version_rows: 0,
  };
  target.integrity.source_ref_photo_urls = 0;
  return target;
}

function authEvidence() {
  const stable = Object.fromEntries([
    ...policy.auth.stableConfigurationTables,
    ...EXACT_AUTH_CHURN_TABLES,
  ].map((table) => [table, {
    row_count: 0,
    row_digest: digest('a'),
  }]));
  return {
    watermark_utc: '2026-07-15T10:00:00Z',
    schema_table_count: 23,
    schema_tables: Array.from({ length: 23 }, (_, index) => `table_${index}`),
    stable_tables: stable,
    users: {
      total_count: 34,
      baseline_count: 34,
      baseline_key_digest: digest('b'),
      baseline_credential_digest: digest('c'),
      live_count: 0,
      invalid_boundary_count: 0,
      baseline_deleted_after_cutoff: 0,
      watermarked_count: 34,
      watermarked_key_digest: digest('U'),
      watermarked_credential_digest: digest('V'),
      post_watermark_count: 0,
    },
    identities: {
      total_count: 34,
      baseline_count: 34,
      baseline_key_digest: digest('d'),
      baseline_identity_digest: digest('e'),
      live_count: 0,
      invalid_boundary_count: 0,
      watermarked_count: 34,
      watermarked_key_digest: digest('I'),
      watermarked_identity_digest: digest('J'),
      post_watermark_count: 0,
    },
    volatile_counts: { sessions: 83, refresh_tokens: 794 },
    orphan_counts: {
      identities: 0,
      sessions: 0,
      refresh_tokens: 0,
      mfa_factors: 0,
      mfa_amr_claims: 0,
      live_users_without_profile: 0,
      live_users_without_identity: 0,
    },
  };
}

function liveAuthEvidence() {
  const target = structuredClone(authEvidence());
  target.users.total_count = 35;
  target.users.live_count = 1;
  target.users.watermarked_count = 35;
  target.users.watermarked_key_digest = digest('u');
  target.users.watermarked_credential_digest = digest('v');
  target.identities.total_count = 35;
  target.identities.live_count = 1;
  target.identities.watermarked_count = 35;
  target.identities.watermarked_key_digest = digest('i');
  target.identities.watermarked_identity_digest = digest('j');
  target.volatile_counts = { sessions: 92, refresh_tokens: 807 };
  return target;
}

function watermarkAnchor() {
  const publicTarget = livePublicEvidence();
  const authTarget = liveAuthEvidence();
  return {
    schemaVersion: 12,
    watermarkUtc: publicTarget.watermark_utc,
    evidence: {
      public: {
        mutableTables: Object.fromEntries(Object.entries(publicTarget.mutable_tables).map(([table, evidence]) => [table, {
          watermarked_count: evidence.watermarked_count,
          watermarked_key_digest: evidence.watermarked_key_digest,
          watermarked_content_digest: evidence.watermarked_content_digest,
        }])),
        audit: {
          watermarked_count: publicTarget.audit.watermarked_count,
          watermarked_key_digest: publicTarget.audit.watermarked_key_digest,
          watermarked_content_digest: publicTarget.audit.watermarked_content_digest,
        },
        storageLiveBucket: {
          watermarked_count: publicTarget.storage_live_bucket.watermarked_count,
          watermarked_key_digest: publicTarget.storage_live_bucket.watermarked_key_digest,
          watermarked_content_digest: publicTarget.storage_live_bucket.watermarked_content_digest,
        },
        appendOnlyTables: {
          rental_archive_audit: {
            watermarked_count: publicTarget.append_only_tables.rental_archive_audit.watermarked_count,
            watermarked_key_digest: publicTarget.append_only_tables.rental_archive_audit.watermarked_key_digest,
            watermarked_content_digest: publicTarget.append_only_tables.rental_archive_audit.watermarked_content_digest,
            audit_pair_mismatch_count: 0,
          },
        },
        operationalTables: Object.fromEntries(
          OPERATIONAL_CONTINUITY_TABLES.map((table) => [table, {
            watermarked_count: publicTarget.operational_tables[table].watermarked_count,
            watermarked_key_digest: publicTarget.operational_tables[table].watermarked_key_digest,
            watermarked_content_digest: publicTarget.operational_tables[table].watermarked_content_digest,
          }]),
        ),
      },
      auth: {
        users: {
          watermarked_count: authTarget.users.watermarked_count,
          watermarked_key_digest: authTarget.users.watermarked_key_digest,
          watermarked_content_digest: authTarget.users.watermarked_credential_digest,
        },
        identities: {
          watermarked_count: authTarget.identities.watermarked_count,
          watermarked_key_digest: authTarget.identities.watermarked_key_digest,
          watermarked_content_digest: authTarget.identities.watermarked_identity_digest,
        },
      },
    },
  };
}

function laterLivePublicEvidence() {
  const target = livePublicEvidence();
  target.watermark_utc = '2026-07-15T11:00:00Z';
  const rentalTransition = target.transition_evidence.rows.find((row) => row.table === 'rentals');
  const oldStatusDigest = rentalTransition.columnDigests.status;
  rentalTransition.columnDigests.status = valueDigest('later-status');
  target.transition_evidence.events.push({
    sequence: target.transition_evidence.events.length + 1,
    eventKey: valueDigest('later-event'),
    action: 'UPDATE',
    table: 'rentals',
    recordKey: rentalTransition.recordKey,
    diffValid: true,
    diffKeys: ['status'],
    oldColumnDigests: { status: oldStatusDigest },
    newColumnDigests: { status: rentalTransition.columnDigests.status },
    newImmutableDigest: null,
    missingAllowedColumnCount: 0,
  });
  target.audit.post_cutoff_count += 1;
  target.audit.watermarked_count += 1;
  target.audit.watermarked_key_digest = digest('L');
  target.audit.watermarked_content_digest = digest('M');
  return target;
}

function previousBoundedPublicEvidence() {
  const target = livePublicEvidence();
  target.audit.post_watermark_count = 1;
  return target;
}

function laterLiveAuthEvidence() {
  const target = liveAuthEvidence();
  target.watermark_utc = '2026-07-15T11:00:00Z';
  target.users.total_count = 36;
  target.users.live_count = 2;
  target.users.watermarked_count = 36;
  target.users.watermarked_key_digest = digest('w');
  target.users.watermarked_credential_digest = digest('x');
  target.identities.total_count = 36;
  target.identities.live_count = 2;
  target.identities.watermarked_count = 36;
  target.identities.watermarked_key_digest = digest('y');
  target.identities.watermarked_identity_digest = digest('z');
  return target;
}

function previousBoundedAuthEvidence() {
  const target = liveAuthEvidence();
  target.users.total_count = 36;
  target.users.post_watermark_count = 1;
  target.identities.total_count = 36;
  target.identities.post_watermark_count = 1;
  return target;
}

test('public continuity accepts frozen baseline plus audited Rentals growth', () => {
  const report = validatePublicContinuity(publicEvidence(), livePublicEvidence(), policy, watermarkAnchor());
  assert.equal(report.status, 'pass_continuity');
  assert.equal(report.liveGrowth.rental_photos, 156);
  assert.equal(report.activeJobControls, 0);
  assert.equal(JSON.stringify(report).includes(digest('s')), false);
});

test('live public checkpoint accepts audited growth after the immutable watermark', () => {
  const report = validateLivePublicCheckpoint(
    publicEvidence(),
    laterLivePublicEvidence(),
    previousBoundedPublicEvidence(),
    policy,
    watermarkAnchor(),
  );
  assert.equal(report.status, 'pass_continuity');
  assert.equal(report.validationMode, 'live_checkpoint_bound_to_immutable_anchor');
  assert.equal(report.validationWatermarkUtc, '2026-07-15T11:00:00Z');
  assert.equal(report.transition.auditUpdateCount, 2);
});

test('live public checkpoint rejects rewritten immutable history', () => {
  const previous = previousBoundedPublicEvidence();
  previous.audit.watermarked_content_digest = digest('x');
  assert.throws(
    () => validateLivePublicCheckpoint(
      publicEvidence(),
      laterLivePublicEvidence(),
      previous,
      policy,
      watermarkAnchor(),
    ),
    /LIVE_CONTINUITY_FAILED: previous public audit bounded content differs/,
  );
});

test('public continuity fails closed on baseline drift, deletion, orphan, or active job', () => {
  const mutations = [
    (target) => { target.mutable_tables.rentals.baseline_immutable_digest = digest('x'); },
    (target) => { target.audit.delete_count = 1; },
    (target) => { target.integrity.new_photo_orphans = 1; },
    (target) => { target.integrity.all_metadata_without_photo_digest = digest('x'); },
    (target) => { target.worker_state.enabled_job_controls = 1; },
    (target) => { target.worker_state.unsafe_state_rows = 1; },
    (target) => { target.worker_state.active_scheduler_rows = 1; },
    (target) => { target.worker_state.active_listener_rows = 1; },
    (target) => { target.worker_state.unexpected_identity_rows = 1; },
    (target) => { target.worker_state.duplicate_identity_rows = 1; },
    (target) => { target.worker_state.invalid_timestamp_rows = 1; },
    (target) => { target.worker_state.non_release_version_rows = 1; },
    (target) => { target.worker_state.motorist_worker_status = 3; },
    (target) => { target.worker_state = {}; },
    (target) => { target.reconciled_tables.vehicle_photos.normalized_url_digest = digest('x'); },
    (target) => { target.audit.baseline_count -= 1; },
    (target) => { target.audit.baseline_content_digest = digest('x'); },
    (target) => { target.projection_contract.allowedUpdateColumns.rentals = ['status']; },
    (target) => { target.transition_evidence.events[0].diffValid = false; },
    (target) => { target.transition_evidence.events = []; },
    (target) => { target.transition_evidence.events[0].oldColumnDigests.status = digest('x'); },
    (target) => { target.transition_evidence.events.at(-1).sequence -= 1; },
    (target) => {
      target.transition_evidence.rows.at(-1).columnDigests = {
        ...target.transition_evidence.rows.at(-1).columnDigests,
        status: digest('x'),
      };
    },
    (target) => { target.transition_evidence.rows.at(-1).immutableDigest = digest('x'); },
    (target) => { target.transition_evidence.events.at(-1).newImmutableDigest = digest('x'); },
    (target) => {
      target.mutable_tables.rentals.total_count += 1;
      target.mutable_tables.rentals.post_watermark_count = 1;
    },
    (target) => { target.append_only_tables.rental_archive_audit.live_action_counts.unexpected = 1; },
    (target) => { target.append_only_tables.rental_archive_audit.audit_pair_mismatch_count = 1; },
    (target) => { target.append_only_tables.rental_archive_audit.watermarked_content_digest = digest('x'); },
    (target) => {
      target.mutable_tables.rentals.total_count -= 12;
      target.mutable_tables.rentals.live_count = 0;
      target.mutable_tables.rentals.watermarked_count -= 12;
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const target = livePublicEvidence();
    mutate(target);
    assert.throws(
      () => validatePublicContinuity(publicEvidence(), target, policy, watermarkAnchor()),
      /LIVE_CONTINUITY_FAILED/,
      `mutation ${index} unexpectedly passed`,
    );
  }
  const sourceWithoutWorkerEvidence = publicEvidence();
  sourceWithoutWorkerEvidence.worker_state = {};
  assert.throws(
    () => validatePublicContinuity(sourceWithoutWorkerEvidence, livePublicEvidence(), policy, watermarkAnchor()),
    /LIVE_CONTINUITY_FAILED/,
  );
});

test('a new watermark replays the exact previous bounded public, Storage, and Auth evidence', () => {
  const previous = watermarkAnchor();
  previous.schemaVersion = 9;
  const previousPublic = livePublicEvidence();
  previousPublic.storage_live_bucket.legacy_watermarked_key_digest =
    previous.evidence.public.storageLiveBucket.watermarked_key_digest;
  previousPublic.storage_live_bucket.legacy_watermarked_content_digest =
    previous.evidence.public.storageLiveBucket.watermarked_content_digest;
  const previousAuth = liveAuthEvidence();
  assert.doesNotThrow(() => validatePreviousBoundedEvidence(previousPublic, previousAuth, previous));

  const mutations = [
    (publicValue) => { publicValue.mutable_tables.rentals.watermarked_content_digest = digest('x'); },
    (publicValue) => { publicValue.audit.watermarked_key_digest = digest('x'); },
    (publicValue) => { publicValue.storage_live_bucket.legacy_watermarked_key_digest = digest('x'); },
    (publicValue) => { publicValue.append_only_tables.rental_archive_audit.watermarked_count -= 1; },
  ];
  for (const mutate of mutations) {
    const publicValue = structuredClone(previousPublic);
    mutate(publicValue);
    assert.throws(
      () => validatePreviousBoundedEvidence(publicValue, previousAuth, previous),
      /LIVE_CONTINUITY_FAILED/,
    );
  }
  const authValue = structuredClone(previousAuth);
  authValue.users.watermarked_credential_digest = digest('x');
  assert.throws(
    () => validatePreviousBoundedEvidence(previousPublic, authValue, previous),
    /LIVE_CONTINUITY_FAILED/,
  );
});

test('Auth continuity accepts durable principals plus session churn', () => {
  const report = validateAuthContinuity(authEvidence(), liveAuthEvidence(), policy, watermarkAnchor());
  assert.equal(report.status, 'pass_continuity');
  assert.equal(report.liveUsers, 1);
  assert.equal(report.sessionDelta, 9);
  assert.equal(JSON.stringify(report).includes(digest('c')), false);
});

test('live Auth checkpoint accepts principal growth after the immutable watermark', () => {
  const report = validateLiveAuthCheckpoint(
    authEvidence(),
    laterLiveAuthEvidence(),
    previousBoundedAuthEvidence(),
    policy,
    watermarkAnchor(),
  );
  assert.equal(report.status, 'pass_continuity');
  assert.equal(report.validationMode, 'live_checkpoint_bound_to_immutable_anchor');
  assert.equal(report.validationWatermarkUtc, '2026-07-15T11:00:00Z');
  assert.equal(report.liveUsers, 2);
});

test('live Auth checkpoint rejects rewritten immutable principal history', () => {
  const previous = previousBoundedAuthEvidence();
  previous.users.watermarked_credential_digest = digest('x');
  assert.throws(
    () => validateLiveAuthCheckpoint(
      authEvidence(),
      laterLiveAuthEvidence(),
      previous,
      policy,
      watermarkAnchor(),
    ),
    /LIVE_CONTINUITY_FAILED: previous Auth users bounded content differs/,
  );
});

test('snapshot validators bind live evidence to a DB transaction and replay the immutable bound', () => {
  const publicSql = readFileSync('deploy/supabase/public-live-continuity-readonly.sql', 'utf8');
  const authSql = readFileSync('deploy/supabase/auth-live-continuity-readonly.sql', 'utf8');
  const watermarkCapture = readFileSync('deploy/supabase/capture-live-watermark-anchor.zsh', 'utf8');
  const targetValidator = readFileSync('deploy/supabase/validate-target-snapshot.zsh', 'utf8');
  const authValidator = readFileSync('deploy/supabase/validate-auth-snapshot.zsh', 'utf8');
  const freezeBinding = readFileSync('deploy/bin/validate-freeze-anchor-binding.mjs', 'utf8');

  assert.match(publicSql, /select \(__LIVE_WATERMARK__\)::timestamptz as value/);
  assert.match(publicSql, /select '__LIVE_VALIDATION_MODE__'::text as value/);
  assert.match(publicSql, /validation_mode\.value = 'bounded'/);
  assert.match(authSql, /select \(__LIVE_WATERMARK__\)::timestamptz as value/);
  for (const script of [targetValidator, authValidator]) {
    assert.match(script, /__LIVE_WATERMARK__\/pg_catalog\.transaction_timestamp\(\)/);
    assert.match(script, /__LIVE_WATERMARK__\/timestamptz '\$\{watermark_utc\}'/);
    assert.match(script, /\.policySha256 \| select\(test\("\^\[0-9a-f\]\{64\}\$"\)\)/);
    assert.match(script, /\.currentSha256 \| select\(test\("\^\[0-9a-f\]\{64\}\$"\)\)/);
    assert.doesNotMatch(script, /continuity_policy_sha256="\$\(shasum/);
    assert.doesNotMatch(script, /watermark_anchor_sha256="\$\(shasum/);
  }
  assert.match(targetValidator, /__LIVE_VALIDATION_MODE__\/bounded/);
  assert.match(targetValidator, /CONTINUITY_VALIDATOR\}" public-live/);
  assert.match(authValidator, /CONTINUITY_VALIDATOR\}" auth-live/);
  for (const script of [targetValidator, authValidator]) {
    assert.match(script, /--arg validated_at_utc "\$\{validation_watermark_utc\}"/);
    assert.match(script, /report_completed_at_utc/);
  }
  const gate = readFileSync('deploy/supabase/validate-cutover-gate.zsh', 'utf8');
  assert.match(gate, /\.validated_at_utc == \.continuity_summary\.validationWatermarkUtc/);
  for (const script of [watermarkCapture, targetValidator, gate]) {
    assert.match(script, /FREEZE_BINDING_HELPER/);
    assert.match(script, /validate-freeze-anchor-binding[.]mjs/);
    assert.match(script, /\.operationalBaselineUtc/);
  }
  assert.match(gate, /operational_baseline_utc/);
  assert.match(freezeBinding, /\.publicData\?\.operationalContinuity\?\.operationalBaselineUtc/);
  assert.match(freezeBinding, /freeze\.frozen_at_utc/);
  assert.match(freezeBinding, /anchor\.evidence\?\.sourceFreezeReceiptSha256/);
  assert.match(freezeBinding, /anchor\.evidence\?\.snapshotManifestSha256/);
  assert.match(freezeBinding, /anchor\.evidence\?\.configManifestSha256/);
  assert.ok(watermarkCapture.indexOf('node "${FREEZE_BINDING_HELPER}"') < watermarkCapture.indexOf('source "${SECRET_FILE}"'));
  assert.ok(watermarkCapture.indexOf('node "${WATERMARK_RESOLVER}"') < watermarkCapture.indexOf('source "${SECRET_FILE}"'));
  assert.ok(targetValidator.indexOf('node "${FREEZE_BINDING_HELPER}"') < targetValidator.indexOf('source "${SECRET_FILE}"'));
  assert.ok(gate.indexOf('node "${FREEZE_BINDING_HELPER}"') < gate.indexOf('Obnovujem live read-only DB'));
  assert.doesNotMatch(gate, /readonly operational_baseline_utc="\$\(jq/);
});

test('Auth continuity fails closed on credential, principal, schema, or orphan drift', () => {
  const mutations = [
    (target) => { target.users.baseline_credential_digest = digest('x'); },
    (target) => { target.identities.baseline_key_digest = digest('x'); },
    (target) => { target.schema_table_count = 22; },
    (target) => { target.orphan_counts.identities = 1; },
    (target) => {
      target.users.total_count -= 1;
      target.users.live_count = 0;
      target.users.watermarked_count -= 1;
    },
  ];
  for (const mutate of mutations) {
    const target = liveAuthEvidence();
    mutate(target);
    assert.throws(() => validateAuthContinuity(authEvidence(), target, policy, watermarkAnchor()), /LIVE_CONTINUITY_FAILED/);
  }
});

test('live Storage mode forbids copy and validates source payloads toward target', () => {
  const script = readFileSync('deploy/supabase/copy-storage-snapshot.zsh', 'utf8');
  assert.match(script, /check "source:\$\{bucket\}" "target:\$\{bucket\}"[\s\\]*\n[\s]*--one-way --download/);
  assert.match(script, /\[\[ "\$\{bucket\}" != "\$\{live_bucket\}" \]\]/);
  const copyAttempt = spawnSync(
    'zsh',
    ['deploy/supabase/copy-storage-snapshot.zsh', policy.snapshotId, '--copy-storage'],
    { encoding: 'utf8' },
  );
  assert.notEqual(copyAttempt.status, 0);
  assert.match(copyAttempt.stderr, /--copy-storage je zakázané/);
  assert.match(script, /target_only_keyset_matches_database/);
  assert.match(script, /anchored_live_content_matches/);
  assert.match(script, /management_api_readonly_json "\$\{EXPECTED_TARGET_REF\}"/);
  assert.match(script, /cmp -s "\$\{anchored_content\}" "\$\{current_anchored_content\}"/);
});

test('v12 policy preserves the exact v11 chain and scopes reviewed Storage growth', () => {
  const v11Path = 'deploy/supabase/live-target-continuity-policy-v11.json';
  const v11 = JSON.parse(readFileSync(v11Path, 'utf8'));

  assert.equal(v11.schemaVersion, 11);
  assert.equal(v11.storage.onlyLiveGrowthBucket, 'rental-photos');
  assert.equal(policy.schemaVersion, 12);
  assert.equal(policy.supersedesPolicyPath, v11Path);
  assert.equal(policy.supersedesPolicySha256, fileDigest(v11Path));
  assert.equal(policy.storage.sourcePayloadsMustRemainAContentExactSubset, true);
  assert.equal(policy.storage.rootAnchorBucket, 'rental-photos');
  assert.deepEqual(policy.storage.allowedLiveGrowthBuckets, [
    'motorist-call-recordings',
    'rental-photos',
  ]);
  assert.deepEqual(
    policy.storage.allowedLiveGrowthBuckets,
    [...policy.storage.allowedLiveGrowthBuckets].sort(),
  );
  assert.equal('onlyLiveGrowthBucket' in policy.storage, false);
  assert.deepEqual(policy.storage.recordingGrowthContract, {
    bucket: 'motorist-call-recordings',
    provider: 'viptel',
    requiredRecordingStatus: 'available',
    requiredCallStatus: 'ended',
    requirePostSnapshotObject: true,
    requireSizeMatch: true,
    requireChecksumMatch: true,
    requireAppendOnlyTransitionEvidence: true,
  });
  assert.deepEqual(policy.guards, {
    sourceMustRemainFrozen: true,
    sourceDeletionForbidden: true,
    targetRewindForbidden: true,
    targetCronMustRemainDisabled: true,
    targetJobsMustRemainDisabled: true,
  });
});

test('private Storage path digests require a unique byte-sorted catalog', () => {
  const directory = mkdtempSync(join(tmpdir(), 'motorist-storage-paths-'));
  const sorted = join(directory, 'sorted.txt');
  const unsorted = join(directory, 'unsorted.txt');
  writeFileSync(sorted, 'a/one.jpg\nb/two.jpg\n', { mode: 0o600 });
  writeFileSync(unsorted, 'b/two.jpg\na/one.jpg\n', { mode: 0o600 });

  const accepted = spawnSync('node', ['deploy/bin/digest-private-path-list.mjs', sorted], { encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).count, 2);
  assert.notEqual(
    spawnSync('node', ['deploy/bin/digest-private-path-list.mjs', unsorted], { encoding: 'utf8' }).status,
    0,
  );
  chmodSync(sorted, 0o644);
  assert.notEqual(
    spawnSync('node', ['deploy/bin/digest-private-path-list.mjs', sorted], { encoding: 'utf8' }).status,
    0,
  );
});

test('public reconciliation receipts reject extra fields and non-canonical timestamps', () => {
  const directory = mkdtempSync(join(tmpdir(), 'motorist-reconciliation-receipts-'));
  const policyDirectory = join(directory, 'deploy', 'supabase');
  const receiptDirectory = join(policyDirectory, 'reconciliation-receipts');
  mkdirSync(receiptDirectory, { recursive: true });
  const policyPath = join(policyDirectory, 'live-target-continuity-policy.json');
  const candidatePolicy = structuredClone(policy);
  for (const entry of candidatePolicy.publicData.approvedTargetReconciliations) {
    const file = entry.receiptPath.split('/').at(-1);
    writeFileSync(
      join(receiptDirectory, file),
      readFileSync(join('deploy/supabase/reconciliation-receipts', file)),
    );
  }
  assert.doesNotThrow(() => validateTargetReconciliationReceipts(
    candidatePolicy,
    policyPath,
    '2026-07-16T14:00:00Z',
  ));

  const entry = candidatePolicy.publicData.approvedTargetReconciliations[0];
  const receiptPath = join(directory, entry.receiptPath);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  receipt.unexpectedObjectName = 'must-not-be-accepted';
  writeFileSync(receiptPath, JSON.stringify(receipt));
  entry.receiptSha256 = fileDigest(receiptPath);
  assert.throws(
    () => validateTargetReconciliationReceipts(candidatePolicy, policyPath, '2026-07-16T14:00:00Z'),
    /privacy contract/,
  );

  delete receipt.unexpectedObjectName;
  receipt.capturedAtUtc = '2026-02-30T12:00:00Z';
  writeFileSync(receiptPath, JSON.stringify(receipt));
  entry.receiptSha256 = fileDigest(receiptPath);
  assert.throws(
    () => validateTargetReconciliationReceipts(candidatePolicy, policyPath, '2026-07-16T14:00:00Z'),
    /canonical UTC/,
  );
});

test('secure migration snapshots reject parent and final-component symlinks', () => {
  const directory = mkdtempSync(join(tmpdir(), 'motorist-secure-snapshot-'));
  const actualDirectory = join(directory, 'actual');
  mkdirSync(actualDirectory);
  const file = join(actualDirectory, 'evidence.json');
  writeFileSync(file, '{}', { mode: 0o600 });
  assert.equal(
    readSecureFileSnapshot(file, { trustedRoot: directory, privateFile: true }).contents.toString('utf8'),
    '{}',
  );

  const linkedDirectory = join(directory, 'linked');
  symlinkSync(actualDirectory, linkedDirectory, 'dir');
  assert.throws(
    () => readSecureFileSnapshot(join(linkedDirectory, 'evidence.json'), {
      trustedRoot: directory,
      privateFile: true,
    }),
    /symbolic link/,
  );

  const linkedFile = join(actualDirectory, 'linked.json');
  symlinkSync(file, linkedFile, 'file');
  assert.throws(
    () => readSecureFileSnapshot(linkedFile, { trustedRoot: directory, privateFile: true }),
    /symbolic link/,
  );
});

test('continuity CLI rejects evidence replaced after its checksum was captured', () => {
  mkdirSync('.context', { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join('.context', 'continuity-cli-'));
  const evidencePath = join(directory, 'evidence.json');
  writeFileSync(evidencePath, '{}', { mode: 0o600 });
  const policyPath = 'deploy/supabase/live-target-continuity-policy.json';
  const result = spawnSync('node', [
    'deploy/bin/validate-live-target-continuity.mjs',
    'public',
    evidencePath,
    evidencePath,
    policyPath,
    evidencePath,
    valueDigest('stale-source-checksum'),
    fileDigest(evidencePath),
    fileDigest(policyPath),
    fileDigest(evidencePath),
  ], { encoding: 'utf8' });
  rmSync(directory, { recursive: true, force: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source evidence checksum changed before validation/);
});

test('watermark resolver requires a complete policy-linked chain and transition receipts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'motorist-watermark-chain-'));
  const policyDirectory = join(directory, 'deploy', 'supabase');
  mkdirSync(policyDirectory, { recursive: true });
  const rootPolicy = join(policyDirectory, 'live-target-continuity-policy-v1.json');
  const previousPolicy = join(policyDirectory, 'live-target-continuity-policy-v2.json');
  const policyV3 = join(policyDirectory, 'live-target-continuity-policy-v3.json');
  const policyV4 = join(policyDirectory, 'live-target-continuity-policy-v4.json');
  const policyV5 = join(policyDirectory, 'live-target-continuity-policy-v5.json');
  const policyV6 = join(policyDirectory, 'live-target-continuity-policy-v6.json');
  const policyV7 = join(policyDirectory, 'live-target-continuity-policy-v7.json');
  const policyV8 = join(policyDirectory, 'live-target-continuity-policy-v8.json');
  const policyV9 = join(policyDirectory, 'live-target-continuity-policy-v9.json');
  const policyV10 = join(policyDirectory, 'live-target-continuity-policy-v10.json');
  const policyV11 = join(policyDirectory, 'live-target-continuity-policy-v11.json');
  const currentPolicy = join(policyDirectory, 'live-target-continuity-policy.json');
  writeFileSync(rootPolicy, readFileSync('deploy/supabase/live-target-continuity-policy-v1.json'));
  writeFileSync(previousPolicy, readFileSync('deploy/supabase/live-target-continuity-policy-v2.json'));
  writeFileSync(policyV3, readFileSync('deploy/supabase/live-target-continuity-policy-v3.json'));
  writeFileSync(policyV4, readFileSync('deploy/supabase/live-target-continuity-policy-v4.json'));
  writeFileSync(policyV5, readFileSync('deploy/supabase/live-target-continuity-policy-v5.json'));
  writeFileSync(policyV6, readFileSync('deploy/supabase/live-target-continuity-policy-v6.json'));
  writeFileSync(policyV7, readFileSync('deploy/supabase/live-target-continuity-policy-v7.json'));
  writeFileSync(policyV8, readFileSync('deploy/supabase/live-target-continuity-policy-v8.json'));
  writeFileSync(policyV9, readFileSync('deploy/supabase/live-target-continuity-policy-v9.json'));
  writeFileSync(policyV10, readFileSync('deploy/supabase/live-target-continuity-policy-v10.json'));
  writeFileSync(policyV11, readFileSync('deploy/supabase/live-target-continuity-policy-v11.json'));
  writeFileSync(currentPolicy, readFileSync('deploy/supabase/live-target-continuity-policy.json'));
  const reconciliationDirectory = join(policyDirectory, 'reconciliation-receipts');
  mkdirSync(reconciliationDirectory, { recursive: true });
  for (const file of [
    'rental-photo-orphan-20260716T115610Z.json',
    'rental-photo-duplicate-20260716T121149Z.json',
  ]) {
    writeFileSync(
      join(reconciliationDirectory, file),
      readFileSync(join('deploy/supabase/reconciliation-receipts', file)),
    );
  }

  const base = join(directory, 'base.json');
  writeFileSync(base, JSON.stringify({
    schemaVersion: 1,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    evidence: { continuityPolicySha256: fileDigest(rootPolicy) },
  }), { mode: 0o600 });
  const root = join(directory, 'watermark-v1.json');
  writeFileSync(root, JSON.stringify({
    schemaVersion: 1,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-15T09:25:12Z',
    continuityPolicySha256: fileDigest(rootPolicy),
    baseContinuityAnchorSha256: fileDigest(base),
  }), { mode: 0o600 });
  const previous = join(directory, 'live-watermark-20260714T184445Z-20260715T111508Z.json');
  writeFileSync(previous, JSON.stringify({
    schemaVersion: 2,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-15T11:15:08Z',
    continuityPolicySha256: fileDigest(previousPolicy),
    supersedesPolicySha256: fileDigest(rootPolicy),
    baseContinuityAnchorSha256: fileDigest(base),
    previousWatermarkAnchorSha256: fileDigest(root),
    projectionMode: 'policy-defined-immutable-fields-plus-append-only-audit',
  }), { mode: 0o600 });
  const transitionV3 = join(directory, 'live-transition-20260714T184445Z-20260715T120000Z.json');
  writeFileSync(transitionV3, JSON.stringify({
    schemaVersion: 1,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-15T12:00:00Z',
    continuityPolicySha256: fileDigest(policyV3),
    previousWatermarkAnchorSha256: fileDigest(previous),
    status: 'pass_transition_coverage',
    transition: { unexplainedDirectChangeCount: 0, invalidAuditDiffCount: 0 },
  }), { mode: 0o600 });
  const watermarkV3 = join(directory, 'live-watermark-20260714T184445Z-20260715T120000Z.json');
  writeFileSync(watermarkV3, JSON.stringify({
    schemaVersion: 3,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-15T12:00:00Z',
    continuityPolicySha256: fileDigest(policyV3),
    supersedesPolicySha256: fileDigest(previousPolicy),
    rootPolicySha256: fileDigest(rootPolicy),
    baseContinuityAnchorSha256: fileDigest(base),
    previousWatermarkAnchorSha256: fileDigest(previous),
    transitionReceiptFile: transitionV3.split('/').at(-1),
    transitionReceiptSha256: fileDigest(transitionV3),
    projectionMode: 'policy-defined-immutable-fields-plus-append-only-audit-and-direct-transition-v3',
  }), { mode: 0o600 });
  const transitionV4 = join(directory, 'live-transition-20260714T184445Z-20260715T123000Z.json');
  writeFileSync(transitionV4, JSON.stringify({
    schemaVersion: 1,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-15T12:30:00Z',
    continuityPolicySha256: fileDigest(policyV4),
    previousWatermarkAnchorSha256: fileDigest(watermarkV3),
    status: 'pass_transition_coverage',
    transition: { unexplainedDirectChangeCount: 0, invalidAuditDiffCount: 0 },
  }), { mode: 0o600 });
  const watermarkV4 = join(directory, 'live-watermark-20260714T184445Z-20260715T123000Z.json');
  const watermarkV4Value = {
    schemaVersion: 4,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-15T12:30:00Z',
    continuityPolicySha256: fileDigest(policyV4),
    supersedesPolicySha256: fileDigest(policyV3),
    rootPolicySha256: fileDigest(rootPolicy),
    baseContinuityAnchorSha256: fileDigest(base),
    previousWatermarkAnchorSha256: fileDigest(watermarkV3),
    transitionReceiptFile: transitionV4.split('/').at(-1),
    transitionReceiptSha256: fileDigest(transitionV4),
    projectionMode: 'policy-defined-immutable-fields-plus-append-only-audit-and-direct-transition-v4',
  };
  writeFileSync(watermarkV4, JSON.stringify(watermarkV4Value), { mode: 0o600 });

  const transitionV5 = join(directory, 'live-transition-20260714T184445Z-20260715T130000Z.json');
  writeFileSync(transitionV5, JSON.stringify({
    schemaVersion: 1,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-15T13:00:00Z',
    continuityPolicySha256: fileDigest(policyV5),
    previousWatermarkAnchorSha256: fileDigest(watermarkV4),
    status: 'pass_transition_coverage',
    transition: { unexplainedDirectChangeCount: 0, invalidAuditDiffCount: 0 },
  }), { mode: 0o600 });
  const watermarkV5 = join(directory, 'live-watermark-20260714T184445Z-20260715T130000Z.json');
  const watermarkV5Value = {
    schemaVersion: 5,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-15T13:00:00Z',
    continuityPolicySha256: fileDigest(policyV5),
    supersedesPolicySha256: fileDigest(policyV4),
    rootPolicySha256: fileDigest(rootPolicy),
    baseContinuityAnchorSha256: fileDigest(base),
    previousWatermarkAnchorSha256: fileDigest(watermarkV4),
    transitionReceiptFile: transitionV5.split('/').at(-1),
    transitionReceiptSha256: fileDigest(transitionV5),
    projectionMode: 'policy-defined-immutable-fields-plus-append-only-audit-and-direct-transition-v5',
  };
  writeFileSync(watermarkV5, JSON.stringify(watermarkV5Value), { mode: 0o600 });

  const transitionV6 = join(directory, 'live-transition-20260714T184445Z-20260715T133000Z.json');
  writeFileSync(transitionV6, JSON.stringify({
    schemaVersion: 1,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-15T13:30:00Z',
    continuityPolicySha256: fileDigest(policyV6),
    previousWatermarkAnchorSha256: fileDigest(watermarkV5),
    status: 'pass_transition_coverage',
    transition: { unexplainedDirectChangeCount: 0, invalidAuditDiffCount: 0 },
  }), { mode: 0o600 });
  const watermarkV6 = join(directory, 'live-watermark-20260714T184445Z-20260715T133000Z.json');
  const watermarkV6Value = {
    schemaVersion: 6,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-15T13:30:00Z',
    continuityPolicySha256: fileDigest(policyV6),
    supersedesPolicySha256: fileDigest(policyV5),
    rootPolicySha256: fileDigest(rootPolicy),
    baseContinuityAnchorSha256: fileDigest(base),
    previousWatermarkAnchorSha256: fileDigest(watermarkV5),
    transitionReceiptFile: transitionV6.split('/').at(-1),
    transitionReceiptSha256: fileDigest(transitionV6),
    projectionMode: 'policy-defined-immutable-fields-plus-append-only-audit-and-direct-transition-v6',
  };
  writeFileSync(watermarkV6, JSON.stringify(watermarkV6Value), { mode: 0o600 });

  const transitionV7 = join(directory, 'live-transition-20260714T184445Z-20260715T140000Z.json');
  writeFileSync(transitionV7, JSON.stringify({
    schemaVersion: 1,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-15T14:00:00Z',
    continuityPolicySha256: fileDigest(policyV7),
    previousWatermarkAnchorSha256: fileDigest(watermarkV6),
    status: 'pass_transition_coverage',
    transition: { unexplainedDirectChangeCount: 0, invalidAuditDiffCount: 0 },
  }), { mode: 0o600 });
  const watermarkV7 = join(directory, 'live-watermark-20260714T184445Z-20260715T140000Z.json');
  const watermarkV7Value = {
    schemaVersion: 7,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-15T14:00:00Z',
    continuityPolicySha256: fileDigest(policyV7),
    supersedesPolicySha256: fileDigest(policyV6),
    rootPolicySha256: fileDigest(rootPolicy),
    baseContinuityAnchorSha256: fileDigest(base),
    previousWatermarkAnchorSha256: fileDigest(watermarkV6),
    transitionReceiptFile: transitionV7.split('/').at(-1),
    transitionReceiptSha256: fileDigest(transitionV7),
    projectionMode: 'policy-defined-immutable-fields-plus-append-only-audit-and-direct-transition-v7',
  };
  writeFileSync(watermarkV7, JSON.stringify(watermarkV7Value), { mode: 0o600 });

  const transitionV8 = join(directory, 'live-transition-20260714T184445Z-20260716T130000Z.json');
  writeFileSync(transitionV8, JSON.stringify({
    schemaVersion: 1,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-16T13:00:00Z',
    continuityPolicySha256: fileDigest(policyV8),
    previousWatermarkAnchorSha256: fileDigest(watermarkV7),
    status: 'pass_transition_coverage',
    transition: { unexplainedDirectChangeCount: 0, invalidAuditDiffCount: 0 },
  }), { mode: 0o600 });
  const watermarkV8 = join(directory, 'live-watermark-20260714T184445Z-20260716T130000Z.json');
  const watermarkV8Value = {
    schemaVersion: 8,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-16T13:00:00Z',
    continuityPolicySha256: fileDigest(policyV8),
    supersedesPolicySha256: fileDigest(policyV7),
    rootPolicySha256: fileDigest(rootPolicy),
    baseContinuityAnchorSha256: fileDigest(base),
    previousWatermarkAnchorSha256: fileDigest(watermarkV7),
    transitionReceiptFile: transitionV8.split('/').at(-1),
    transitionReceiptSha256: fileDigest(transitionV8),
    targetReconciliationReceiptFiles: [
      'rental-photo-orphan-20260716T115610Z.json',
      'rental-photo-duplicate-20260716T121149Z.json',
    ],
    targetReconciliationReceiptSha256s: [
      '2a32db27a5798cf4302dc2dc2bed94a6c30b786d13ea0344da8a10c619966908',
      '84eff0e9f669b3b94ba7a814827d554f91ec4e96c51ac8a56066b2167f5f9801',
    ],
    projectionMode: 'policy-defined-immutable-fields-plus-append-only-audit-and-direct-transition-v8',
  };
  writeFileSync(watermarkV8, JSON.stringify(watermarkV8Value), { mode: 0o600 });

  const transitionV9 = join(directory, 'live-transition-20260714T184445Z-20260716T133000Z.json');
  writeFileSync(transitionV9, JSON.stringify({
    schemaVersion: 1,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-16T13:30:00Z',
    continuityPolicySha256: fileDigest(policyV9),
    previousWatermarkAnchorSha256: fileDigest(watermarkV8),
    status: 'pass_transition_coverage',
    transition: { unexplainedDirectChangeCount: 0, invalidAuditDiffCount: 0 },
  }), { mode: 0o600 });
  const watermarkV9 = join(directory, 'live-watermark-20260714T184445Z-20260716T133000Z.json');
  const watermarkV9Value = {
    ...watermarkV8Value,
    schemaVersion: 9,
    watermarkUtc: '2026-07-16T13:30:00Z',
    continuityPolicySha256: fileDigest(policyV9),
    supersedesPolicySha256: fileDigest(policyV8),
    previousWatermarkAnchorSha256: fileDigest(watermarkV8),
    transitionReceiptFile: transitionV9.split('/').at(-1),
    transitionReceiptSha256: fileDigest(transitionV9),
    projectionMode: 'policy-defined-immutable-fields-plus-append-only-audit-and-direct-transition-v9',
  };
  writeFileSync(watermarkV9, JSON.stringify(watermarkV9Value), { mode: 0o600 });

  const transitionV10 = join(directory, 'live-transition-20260714T184445Z-20260716T140000Z.json');
  writeFileSync(transitionV10, JSON.stringify({
    schemaVersion: 1,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-16T14:00:00Z',
    continuityPolicySha256: fileDigest(policyV10),
    previousWatermarkAnchorSha256: fileDigest(watermarkV9),
    status: 'pass_transition_coverage',
    transition: {
      status: 'pass_transition_replay',
      unexplainedDirectChangeCount: 0,
      invalidAuditDiffCount: 0,
    },
  }), { mode: 0o600 });
  const watermarkV10 = join(directory, 'live-watermark-20260714T184445Z-20260716T140000Z.json');
  const watermarkV10Value = {
    ...watermarkV9Value,
    schemaVersion: 10,
    watermarkUtc: '2026-07-16T14:00:00Z',
    continuityPolicySha256: fileDigest(policyV10),
    supersedesPolicySha256: fileDigest(policyV9),
    previousWatermarkAnchorSha256: fileDigest(watermarkV9),
    transitionReceiptFile: transitionV10.split('/').at(-1),
    transitionReceiptSha256: fileDigest(transitionV10),
    projectionMode: 'policy-defined-immutable-fields-plus-append-only-audit-and-direct-transition-v10',
  };
  writeFileSync(watermarkV10, JSON.stringify(watermarkV10Value), { mode: 0o600 });

  const transitionV11 = join(directory, 'live-transition-20260714T184445Z-20260716T143000Z.json');
  writeFileSync(transitionV11, JSON.stringify({
    schemaVersion: 1,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-16T14:30:00Z',
    continuityPolicySha256: fileDigest(policyV11),
    previousWatermarkAnchorSha256: fileDigest(watermarkV10),
    status: 'pass_transition_coverage',
    transition: {
      status: 'pass_transition_replay',
      unexplainedDirectChangeCount: 0,
      invalidAuditDiffCount: 0,
    },
  }), { mode: 0o600 });
  const watermarkV11 = join(directory, 'live-watermark-20260714T184445Z-20260716T143000Z.json');
  const watermarkV11Value = {
    ...watermarkV10Value,
    schemaVersion: 11,
    watermarkUtc: '2026-07-16T14:30:00Z',
    continuityPolicySha256: fileDigest(policyV11),
    supersedesPolicySha256: fileDigest(policyV10),
    previousWatermarkAnchorSha256: fileDigest(watermarkV10),
    transitionReceiptFile: transitionV11.split('/').at(-1),
    transitionReceiptSha256: fileDigest(transitionV11),
    projectionMode: 'policy-defined-immutable-fields-plus-append-only-audit-and-direct-transition-v11',
  };
  writeFileSync(watermarkV11, JSON.stringify(watermarkV11Value), { mode: 0o600 });

  const transitionV12 = join(directory, 'live-transition-20260714T184445Z-20260716T150000Z.json');
  writeFileSync(transitionV12, JSON.stringify({
    schemaVersion: 1,
    snapshotId: policy.snapshotId,
    sourceProjectRef: policy.sourceProjectRef,
    targetProjectRef: policy.targetProjectRef,
    watermarkUtc: '2026-07-16T15:00:00Z',
    continuityPolicySha256: fileDigest(currentPolicy),
    previousWatermarkAnchorSha256: fileDigest(watermarkV11),
    status: 'pass_transition_coverage',
    transition: {
      status: 'pass_transition_replay',
      unexplainedDirectChangeCount: 0,
      invalidAuditDiffCount: 0,
    },
  }), { mode: 0o600 });
  const current = join(directory, 'live-watermark-20260714T184445Z-20260716T150000Z.json');
  const currentValue = {
    ...watermarkV11Value,
    schemaVersion: 12,
    watermarkUtc: '2026-07-16T15:00:00Z',
    continuityPolicySha256: fileDigest(currentPolicy),
    supersedesPolicySha256: fileDigest(policyV11),
    previousWatermarkAnchorSha256: fileDigest(watermarkV11),
    transitionReceiptFile: transitionV12.split('/').at(-1),
    transitionReceiptSha256: fileDigest(transitionV12),
    projectionMode: 'policy-defined-immutable-fields-plus-append-only-audit-and-direct-transition-v12',
  };
  writeFileSync(current, JSON.stringify(currentValue), { mode: 0o600 });

  const resolver = 'deploy/bin/resolve-live-watermark-anchor.mjs';
  const accepted = spawnSync(
    'node',
    [resolver, currentPolicy, base, root, previous, watermarkV3, watermarkV4, watermarkV5, watermarkV6, watermarkV7, watermarkV8, watermarkV9, watermarkV10, watermarkV11, current],
    { encoding: 'utf8' },
  );
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).currentSha256, fileDigest(current));

  const reconciliationReceipt = join(
    reconciliationDirectory,
    'rental-photo-orphan-20260716T115610Z.json',
  );
  const reconciliationReceiptContents = readFileSync(reconciliationReceipt, 'utf8');
  writeFileSync(
    reconciliationReceipt,
    reconciliationReceiptContents.replace('"targetEnabledJobsAfter": 0', '"targetEnabledJobsAfter": 1'),
  );
  const receiptTamperRejected = spawnSync(
    'node',
    [resolver, currentPolicy, base, root, previous, watermarkV3, watermarkV4, watermarkV5, watermarkV6, watermarkV7, watermarkV8, watermarkV9, watermarkV10, watermarkV11, current],
    { encoding: 'utf8' },
  );
  assert.notEqual(receiptTamperRejected.status, 0);
  writeFileSync(reconciliationReceipt, reconciliationReceiptContents);

  writeFileSync(current, JSON.stringify({ ...currentValue, previousWatermarkAnchorSha256: digest('x') }), { mode: 0o600 });
  const rejected = spawnSync(
    'node',
    [resolver, currentPolicy, base, root, previous, watermarkV3, watermarkV4, watermarkV5, watermarkV6, watermarkV7, watermarkV8, watermarkV9, watermarkV10, watermarkV11, current],
    { encoding: 'utf8' },
  );
  assert.notEqual(rejected.status, 0);
});

test('rental return evolution is explicit in policy, SQL projection, and audit allowlist', () => {
  const returnColumns = [
    'return_by',
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
  ];
  for (const column of returnColumns) {
    assert.ok(policy.publicData.allowedUpdateColumns.rentals.includes(column));
    assert.ok(policy.publicData.immutableProjectionExcludedColumns.rentals.includes(column));
  }
  const sql = readFileSync('deploy/supabase/public-live-continuity-readonly.sql', 'utf8');
  assert.match(sql, /projection_contract as/);
  assert.match(sql, /disallowed_update_column_count/);
  for (const column of returnColumns) assert.ok(sql.includes(`'${column}'`));
});

test('Rentals edit workflows are explicit and remain audit-bound', () => {
  const rentalEditColumns = [
    'assistance_service',
    'case_number',
    'customer_email',
    'customer_name',
    'customer_personal_number',
    'customer_phone',
    'is_concept',
    'is_towing_pickup',
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
  ];
  const vehicleEditColumns = [
    'brand',
    'insurance_valid_until',
    'license_plate',
    'model',
    'notes',
    'stk_valid_until',
  ];
  for (const column of rentalEditColumns) {
    assert.ok(policy.publicData.allowedUpdateColumns.rentals.includes(column));
    assert.ok(policy.publicData.immutableProjectionExcludedColumns.rentals.includes(column));
  }
  for (const column of vehicleEditColumns) {
    assert.ok(policy.publicData.allowedUpdateColumns.vehicles.includes(column));
    assert.ok(policy.publicData.immutableProjectionExcludedColumns.vehicles.includes(column));
  }
  assert.equal(policy.publicData.reviewedLiveEvolution.auditAndDirectColumnDiffMustAgree, true);
  const sql = readFileSync('deploy/supabase/public-live-continuity-readonly.sql', 'utf8');
  assert.match(sql, /column_contract as/);
  assert.match(sql, /changed\.key <> all\(column_contract\.rental_updates\)/);
  assert.match(sql, /unnest\(column_contract\.rental_updates\)/);
  for (const column of [...rentalEditColumns, ...vehicleEditColumns]) {
    assert.ok(sql.includes(`'${column}'`));
  }
});

test('graceful runtime shutdown records a terminal disabled heartbeat', () => {
  const scheduler = readFileSync('src/worker/scheduler.ts', 'utf8');
  const listener = readFileSync('src/worker/viptel-listener.ts', 'utf8');
  const continuitySql = readFileSync('deploy/supabase/public-live-continuity-readonly.sql', 'utf8');
  assert.match(scheduler, /this\.clearTimers\(\);\s+await this\.heartbeat\("disabled"\)/);
  assert.match(scheduler, /schedulerTickAt: stoppedStatus \? null : this\.lastSchedulerTickAt/);
  assert.match(listener, /this\.clearHeartbeat\(\);\s+await this\.terminalHeartbeat\(\)/);
  assert.match(listener, /viptelWsStatus: stoppedStatus \?\? \(this\.stopping \? "draining" : this\.status\)/);
  assert.match(continuitySql, /active_scheduler_rows[\s\S]*scheduler_status in \('running', 'draining'\)/);
  assert.match(continuitySql, /active_listener_rows[\s\S]*viptel_ws_status is distinct from 'disabled'/);
});
