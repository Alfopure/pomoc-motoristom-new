#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSecureJsonSnapshot } from './secure-file-snapshot.mjs';

const EXPECTED_AUTH_TABLE_COUNT = 23;
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WORKER_STATE_FIELDS = [
  'active_listener_rows',
  'active_scheduler_rows',
  'duplicate_identity_rows',
  'enabled_job_controls',
  'expected_listener_identity_rows',
  'expected_worker_identity_rows',
  'invalid_timestamp_rows',
  'motorist_job_controls',
  'motorist_job_incidents',
  'motorist_job_runs',
  'motorist_worker_status',
  'non_release_version_rows',
  'unexpected_identity_rows',
  'unsafe_state_rows',
];
export const OPERATIONAL_CONTINUITY_TABLES = [
  'motorist_call_events',
  'motorist_call_recordings',
  'motorist_calls',
  'motorist_integration_raw_events',
];
export const OPERATIONAL_BASELINE_UTC = '2026-07-14T18:47:01Z';
export const EXACT_AUTH_CHURN_TABLES = [
  'flow_state',
  'mfa_challenges',
  'oauth_authorizations',
  'oauth_client_states',
  'oauth_consents',
  'one_time_tokens',
  'saml_relay_states',
  'webauthn_challenges',
];

function fail(message) {
  throw new Error(`LIVE_CONTINUITY_FAILED: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function sameCanonical(left, right) {
  return same(canonicalJson(left), canonicalJson(right));
}

function normalizedUtc(value, requireCondition = assert) {
  const date = new Date(value);
  requireCondition(Number.isFinite(date.valueOf()), 'watermark timestamp is invalid');
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function assertPreviousDigest(
  evidence,
  anchor,
  label,
  requireCondition,
  { legacyStorage = false, contentField } = {},
) {
  const keyField = legacyStorage ? 'legacy_watermarked_key_digest' : 'watermarked_key_digest';
  const resolvedContentField = contentField
    ?? (legacyStorage ? 'legacy_watermarked_content_digest' : 'watermarked_content_digest');
  requireCondition(evidence?.watermarked_count === anchor?.watermarked_count, `${label} bounded count differs`);
  requireCondition(evidence?.[keyField] === anchor?.watermarked_key_digest, `${label} bounded keys differ`);
  requireCondition(
    evidence?.[resolvedContentField] === anchor?.watermarked_content_digest,
    `${label} bounded content differs`,
  );
}

export function validatePreviousOperationalBoundedEvidence(
  publicEvidence,
  previousWatermark,
  requireCondition = assert,
) {
  if (previousWatermark.schemaVersion < 12) return;
  requireCondition(
    Number.isInteger(previousWatermark.schemaVersion),
    'previous operational watermark schema is invalid',
  );
  const anchors = previousWatermark.evidence?.public?.operationalTables;
  requireCondition(
    same(Object.keys(anchors ?? {}).sort(), OPERATIONAL_CONTINUITY_TABLES),
    'previous operational watermark table set differs',
  );
  requireCondition(
    same(Object.keys(publicEvidence.operational_tables ?? {}).sort(), OPERATIONAL_CONTINUITY_TABLES),
    'previous operational evidence table set differs',
  );
  for (const table of OPERATIONAL_CONTINUITY_TABLES) {
    assertPreviousDigest(
      publicEvidence.operational_tables[table],
      anchors[table],
      `previous public operational ${table}`,
      requireCondition,
    );
  }
}

export function validatePreviousPublicBoundedEvidence(
  publicEvidence,
  previousWatermark,
  requireCondition = assert,
) {
  requireCondition(
    normalizedUtc(publicEvidence.watermark_utc, requireCondition)
      === normalizedUtc(previousWatermark.watermarkUtc, requireCondition),
    'previous public bounded watermark differs',
  );
  for (const [table, anchor] of Object.entries(previousWatermark.evidence?.public?.mutableTables ?? {})) {
    assertPreviousDigest(
      publicEvidence.mutable_tables?.[table],
      anchor,
      `previous public ${table}`,
      requireCondition,
    );
  }
  assertPreviousDigest(
    publicEvidence.audit,
    previousWatermark.evidence?.public?.audit,
    'previous public audit',
    requireCondition,
  );
  assertPreviousDigest(
    publicEvidence.storage_live_bucket,
    previousWatermark.evidence?.public?.storageLiveBucket,
    'previous public Storage',
    requireCondition,
    { legacyStorage: previousWatermark.schemaVersion < 10 },
  );
  for (const [table, anchor] of Object.entries(previousWatermark.evidence?.public?.appendOnlyTables ?? {})) {
    const evidence = publicEvidence.append_only_tables?.[table];
    assertPreviousDigest(evidence, anchor, `previous public ${table}`, requireCondition);
    requireCondition(
      evidence?.audit_pair_mismatch_count === anchor.audit_pair_mismatch_count,
      `previous public ${table} pairing differs`,
    );
  }
  validatePreviousOperationalBoundedEvidence(publicEvidence, previousWatermark, requireCondition);
}

export function validatePreviousAuthBoundedEvidence(
  authEvidence,
  previousWatermark,
  requireCondition = assert,
) {
  requireCondition(
    normalizedUtc(authEvidence.watermark_utc, requireCondition)
      === normalizedUtc(previousWatermark.watermarkUtc, requireCondition),
    'previous Auth bounded watermark differs',
  );
  assertPreviousDigest(
    authEvidence.users,
    previousWatermark.evidence?.auth?.users,
    'previous Auth users',
    requireCondition,
    { contentField: 'watermarked_credential_digest' },
  );
  assertPreviousDigest(
    authEvidence.identities,
    previousWatermark.evidence?.auth?.identities,
    'previous Auth identities',
    requireCondition,
    { contentField: 'watermarked_identity_digest' },
  );
}

export function validatePreviousBoundedEvidence(
  publicEvidence,
  authEvidence,
  previousWatermark,
  requireCondition = assert,
) {
  validatePreviousPublicBoundedEvidence(publicEvidence, previousWatermark, requireCondition);
  validatePreviousAuthBoundedEvidence(authEvidence, previousWatermark, requireCondition);
}

function normalizedColumnContract(value) {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([table, columns]) => [table, [...columns].sort()]),
  );
}

function assertZeroObject(value, label) {
  for (const [key, count] of Object.entries(value ?? {})) {
    assert(count === 0, `${label}.${key} must be zero`);
  }
}

function assertPartition(evidence, label) {
  assert(evidence.invalid_boundary_count === 0, `${label} has rows without a cutoff boundary`);
  assert(
    evidence.total_count === evidence.baseline_count + evidence.live_count,
    `${label} baseline/live counts do not partition the total`,
  );
}

function assertWatermark(evidence, anchor, label, contentField = 'watermarked_content_digest') {
  assert(
    evidence.total_count === evidence.watermarked_count + evidence.post_watermark_count,
    `${label} watermark/post-watermark counts do not partition the total`,
  );
  assert(evidence.watermarked_count === anchor.watermarked_count, `${label} lost or gained watermarked rows`);
  assert(evidence.watermarked_key_digest === anchor.watermarked_key_digest, `${label} watermarked keys differ`);
  assert(evidence[contentField] === anchor.watermarked_content_digest, `${label} watermarked content differs`);
  assert(evidence.post_watermark_count === 0, `${label} changed after the immutable watermark`);
}

function requireOperationalPolicy(policy) {
  const contract = policy.publicData?.operationalContinuity;
  assert(policy.schemaVersion >= 12, 'policy schema does not support operational continuity');
  assert(contract?.boundaryColumn === 'created_at', 'operational boundary column differs');
  assert(
    contract?.operationalBaselineUtc === OPERATIONAL_BASELINE_UTC,
    'operational baseline timestamp differs from the completed source freeze',
  );
  for (const guard of [
    'requiresSourceFrozenNoLiveRows',
    'requiresBaselineKeyEquality',
    'requiresBaselineImmutableProjectionEquality',
    'requiresWatermarkReplay',
    'requiresZeroInvalidLiveRows',
  ]) {
    assert(contract?.[guard] === true, `operational policy does not require ${guard}`);
  }
  assert(
    same(Object.keys(contract.tables ?? {}).sort(), OPERATIONAL_CONTINUITY_TABLES),
    'operational policy table set differs',
  );
  return contract;
}

function assertOperationalDigest(value, label) {
  assert(/^[0-9a-f]{64}$/.test(value ?? ''), `${label} is invalid`);
}

export function validateOperationalContinuity(source, target, policy, watermarkAnchor) {
  const contract = requireOperationalPolicy(policy);
  assert(
    sameCanonical(source.operational_contract, contract),
    'source operational contract differs from policy',
  );
  assert(
    sameCanonical(target.operational_contract, contract),
    'target operational contract differs from policy',
  );
  assert(
    same(Object.keys(source.operational_tables ?? {}).sort(), OPERATIONAL_CONTINUITY_TABLES),
    'source operational table set differs from policy',
  );
  assert(
    same(Object.keys(target.operational_tables ?? {}).sort(), OPERATIONAL_CONTINUITY_TABLES),
    'target operational table set differs from policy',
  );
  assert(
    same(
      Object.keys(watermarkAnchor.evidence?.public?.operationalTables ?? {}).sort(),
      OPERATIONAL_CONTINUITY_TABLES,
    ),
    'operational watermark table set differs from policy',
  );

  const growth = {};
  for (const table of OPERATIONAL_CONTINUITY_TABLES) {
    const baseline = source.operational_tables[table];
    const live = target.operational_tables[table];
    assertPartition(baseline, `source operational ${table}`);
    assertPartition(live, `target operational ${table}`);
    assert(baseline.live_count === 0, `source operational ${table} changed after the operational baseline`);
    assert(baseline.total_count === live.baseline_count, `target operational ${table} lost or gained baseline rows`);
    assert(baseline.baseline_count === live.baseline_count, `target operational ${table} baseline count differs`);
    assertOperationalDigest(baseline.baseline_key_digest, `source operational ${table} baseline key digest`);
    assertOperationalDigest(live.baseline_key_digest, `target operational ${table} baseline key digest`);
    assertOperationalDigest(
      baseline.baseline_immutable_digest,
      `source operational ${table} baseline immutable digest`,
    );
    assertOperationalDigest(
      live.baseline_immutable_digest,
      `target operational ${table} baseline immutable digest`,
    );
    assert(
      baseline.baseline_key_digest === live.baseline_key_digest,
      `target operational ${table} baseline keys differ`,
    );
    assert(
      baseline.baseline_immutable_digest === live.baseline_immutable_digest,
      `target operational ${table} baseline immutable fields differ`,
    );
    assert(
      baseline.invalid_live_contract_count === 0,
      `source operational ${table} violates the live contract`,
    );
    assert(
      live.invalid_live_contract_count === 0,
      `target operational ${table} violates the live contract`,
    );
    assertWatermark(
      live,
      watermarkAnchor.evidence.public.operationalTables[table],
      `target operational ${table}`,
    );
    growth[table] = live.live_count;
  }
  return growth;
}

export function validateTargetWorkerState(target, policy) {
  assert(
    same(Object.keys(target ?? {}).sort(), WORKER_STATE_FIELDS),
    'target worker state fields differ from the evidence contract',
  );
  assert(
    Object.values(target).every(Number.isInteger),
    'target worker state contains a non-integer value',
  );
  for (const [table, expected] of Object.entries(policy.publicData.targetOnlyTables)) {
    assert(target[table] === expected, `target worker state ${table} differs from policy`);
  }
  assert(target.enabled_job_controls === 0, 'target job controls are enabled');

  const contract = policy.publicData.workerStatusContract;
  assert(contract && typeof contract === 'object', 'worker status contract is missing');
  const statusRows = target.motorist_worker_status;
  assert(Number.isInteger(statusRows) && statusRows >= 0, 'target worker status row count is invalid');
  assert(statusRows <= contract.maximumRows, 'target worker status row count exceeds policy');
  assert(
    target.expected_worker_identity_rows <= contract.maximumRowsPerIdentity,
    'target worker identity is duplicated',
  );
  assert(
    target.expected_listener_identity_rows <= contract.maximumRowsPerIdentity,
    'target listener identity is duplicated',
  );
  assert(target.duplicate_identity_rows === 0, 'target worker status contains duplicate identities');
  assert(
    statusRows === target.expected_worker_identity_rows
      + target.expected_listener_identity_rows
      + target.unexpected_identity_rows,
    'target worker status identity counts do not partition the table',
  );
  for (const [field, expected] of [
    ['unexpected_identity_rows', contract.unexpectedIdentityRows],
    ['unsafe_state_rows', contract.unsafeStateRows],
    ['active_scheduler_rows', contract.activeSchedulerRows],
    ['active_listener_rows', contract.activeListenerRows],
    ['invalid_timestamp_rows', contract.invalidTimestampRows],
    ['non_release_version_rows', contract.nonReleaseVersionRows],
  ]) {
    assert(target[field] === expected, `target worker status ${field} differs from policy`);
  }

  return statusRows;
}

function validateWorkerState(source, target, policy) {
  assert(
    same(Object.keys(source ?? {}).sort(), WORKER_STATE_FIELDS),
    'source worker state fields differ from the evidence contract',
  );
  assert(
    Object.values(source).every(Number.isInteger),
    'source worker state contains a non-integer value',
  );
  const statusRows = validateTargetWorkerState(target, policy);
  for (const value of Object.values(source)) {
    assert(value === -1 || value === 0, 'source contains active worker state');
  }
  return statusRows;
}

function transitionRowMap(evidence, policy, label) {
  assert(evidence?.schemaVersion === 3, `${label} transition evidence schema differs`);
  assert(Array.isArray(evidence.rows), `${label} transition rows are invalid`);
  const expectedTables = [...policy.publicData.auditedTables].sort();
  const rows = new Map();
  for (const row of evidence.rows) {
    assert(expectedTables.includes(row?.table), `${label} transition table is not allowed`);
    assert(/^[0-9a-f]{64}$/.test(row?.recordKey ?? ''), `${label} transition record key is invalid`);
    assert(typeof row.baseline === 'boolean', `${label} transition baseline marker is invalid`);
    assert(/^[0-9a-f]{64}$/.test(row.immutableDigest ?? ''), `${label} immutable row digest is invalid`);
    const expectedColumns = [...policy.publicData.allowedUpdateColumns[row.table]].sort();
    const actualColumns = Object.keys(row?.columnDigests ?? {}).sort();
    assert(same(actualColumns, expectedColumns), `${label}.${row.table} transition columns differ from policy`);
    assert(
      Object.values(row.columnDigests).every((value) => /^[0-9a-f]{64}$/.test(value)),
      `${label}.${row.table} transition column digest is invalid`,
    );
    const key = `${row.table}:${row.recordKey}`;
    assert(!rows.has(key), `${label} transition row is duplicated`);
    rows.set(key, {
      baseline: row.baseline,
      immutableDigest: row.immutableDigest,
      columnDigests: row.columnDigests,
    });
  }
  return rows;
}

function validateTransitionDigestMap(value, expectedColumns, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} is invalid`);
  assert(same(Object.keys(value).sort(), expectedColumns), `${label} columns differ`);
  assert(
    Object.values(value).every((digest) => /^[0-9a-f]{64}$/.test(digest)),
    `${label} contains an invalid digest`,
  );
}

export function validateDirectTransitions(source, target, policy) {
  assert(
    policy.publicData.reviewedLiveEvolution?.auditAndDirectColumnDiffMustAgree === true,
    'policy does not require audit/direct-transition agreement',
  );
  assert(
    policy.publicData.reviewedLiveEvolution?.requiresIncrementalAuditReplay === true,
    'policy does not require incremental audit replay',
  );
  assert(
    policy.publicData.reviewedLiveEvolution?.requiresFullInsertStateReplay === true,
    'policy does not require full insert-state replay',
  );
  const sourceRows = transitionRowMap(source.transition_evidence, policy, 'source');
  const targetRows = transitionRowMap(target.transition_evidence, policy, 'target');
  assert([...sourceRows.values()].every((row) => row.baseline), 'source contains a live transition row');
  const sourceKeys = [...sourceRows.keys()].sort();
  const targetBaselineKeys = [...targetRows]
    .filter(([, row]) => row.baseline)
    .map(([key]) => key)
    .sort();
  assert(same(sourceKeys, targetBaselineKeys), 'transition baseline key set differs');
  assert(Array.isArray(source.transition_evidence.events), 'source transition events are invalid');
  assert(source.transition_evidence.events.length === 0, 'source has post-cutoff transition events');
  assert(Array.isArray(target.transition_evidence.events), 'target transition events are invalid');

  const replay = new Map(
    [...sourceRows].map(([key, row]) => [key, {
      immutableDigest: row.immutableDigest,
      columnDigests: { ...row.columnDigests },
    }]),
  );
  const eventKeys = new Set();
  let insertCount = 0;
  let updateCount = 0;
  for (const [index, event] of target.transition_evidence.events.entries()) {
    assert(event?.sequence === index + 1, 'transition event sequence is not contiguous');
    assert(policy.publicData.auditedTables.includes(event?.table), 'transition event table is not allowed');
    assert(['INSERT', 'UPDATE'].includes(event?.action), 'transition event action is not allowed');
    assert(/^[0-9a-f]{64}$/.test(event?.recordKey ?? ''), 'transition event record key is invalid');
    assert(/^[0-9a-f]{64}$/.test(event?.eventKey ?? ''), 'transition event key is invalid');
    assert(!eventKeys.has(event.eventKey), 'transition event is duplicated');
    eventKeys.add(event.eventKey);
    assert(event.diffValid === true, 'transition event has an invalid audit diff');
    assert(event.missingAllowedColumnCount === 0, 'transition event is missing an allowed column');
    assert(Array.isArray(event.diffKeys) && event.diffKeys.length > 0, 'transition event has no audit columns');
    assert(same(event.diffKeys, [...new Set(event.diffKeys)].sort()), 'transition event columns are not unique and sorted');
    const allowedColumns = [...policy.publicData.allowedUpdateColumns[event.table]].sort();
    assert(event.diffKeys.every((column) => allowedColumns.includes(column)), 'transition event has a disallowed audit column');
    const key = `${event.table}:${event.recordKey}`;

    if (event.action === 'INSERT') {
      insertCount += 1;
      assert(!replay.has(key), 'transition insert targets an existing row');
      assert(same(event.diffKeys, allowedColumns), 'transition insert does not cover every allowed column');
      validateTransitionDigestMap(event.oldColumnDigests, [], 'transition insert old state');
      validateTransitionDigestMap(event.newColumnDigests, allowedColumns, 'transition insert new state');
      assert(/^[0-9a-f]{64}$/.test(event.newImmutableDigest ?? ''), 'transition insert immutable state is invalid');
      replay.set(key, {
        immutableDigest: event.newImmutableDigest,
        columnDigests: { ...event.newColumnDigests },
      });
      continue;
    }

    updateCount += 1;
    const current = replay.get(key);
    assert(current, 'transition update targets a missing row');
    assert(event.newImmutableDigest === null, 'transition update unexpectedly changes immutable state');
    validateTransitionDigestMap(event.oldColumnDigests, event.diffKeys, 'transition update old state');
    validateTransitionDigestMap(event.newColumnDigests, event.diffKeys, 'transition update new state');
    for (const column of event.diffKeys) {
      assert(
        current.columnDigests[column] === event.oldColumnDigests[column],
        'transition update old state differs from replay',
      );
      current.columnDigests[column] = event.newColumnDigests[column];
    }
  }

  assert(same([...replay.keys()].sort(), [...targetRows.keys()].sort()), 'transition replay row set differs from target');
  let directChangeCount = 0;
  for (const [key, replayRow] of replay) {
    const targetRow = targetRows.get(key);
    assert(targetRow, 'transition replay row is absent from target');
    assert(
      targetRow.baseline === sourceRows.has(key),
      'target transition baseline marker differs from the frozen source',
    );
    assert(
      replayRow.immutableDigest === targetRow.immutableDigest,
      'target immutable state is not the result of the audited insert',
    );
    for (const column of Object.keys(replayRow.columnDigests).sort()) {
      if (sourceRows.get(key)?.columnDigests[column] !== targetRow.columnDigests[column]) {
        directChangeCount += 1;
      }
      assert(
        replayRow.columnDigests[column] === targetRow.columnDigests[column],
        'target mutable state is not the result of the audit replay',
      );
    }
  }
  return {
    status: 'pass_transition_replay',
    baselineRowCount: sourceRows.size,
    liveRowCount: targetRows.size - sourceRows.size,
    auditEventCount: target.transition_evidence.events.length,
    auditInsertCount: insertCount,
    auditUpdateCount: updateCount,
    directChangeCount,
    unexplainedDirectChangeCount: 0,
    invalidAuditDiffCount: 0,
  };
}

export function validatePublicContinuity(source, target, policy, watermarkAnchor) {
  assert(
    policy.publicData.reviewedLiveEvolution?.requiresPerRentalArchiveAuditPairing === true,
    'policy does not require per-rental archive/audit pairing',
  );
  assert(
    policy.publicData.reviewedLiveEvolution?.requiresRentalPhotoPathSetIntegrity === true,
    'policy does not require rental photo path-set integrity',
  );
  assert(
    new Date(target.watermark_utc).toISOString() === new Date(watermarkAnchor.watermarkUtc).toISOString(),
    'public continuity watermark differs from anchor',
  );
  assert(same(source.exact_tables, target.exact_tables), 'an exact public table changed');
  const operationalGrowth = validateOperationalContinuity(
    source,
    target,
    policy,
    watermarkAnchor,
  );
  const expectedProjectionContract = {
    allowedUpdateColumns: normalizedColumnContract(policy.publicData.allowedUpdateColumns),
    immutableProjectionExcludedColumns: normalizedColumnContract(
      policy.publicData.immutableProjectionExcludedColumns,
    ),
  };
  for (const [label, evidence] of [['source', source], ['target', target]]) {
    const actualProjectionContract = {
      allowedUpdateColumns: normalizedColumnContract(
        evidence.projection_contract?.allowedUpdateColumns,
      ),
      immutableProjectionExcludedColumns: normalizedColumnContract(
        evidence.projection_contract?.immutableProjectionExcludedColumns,
      ),
    };
    assert(
      same(actualProjectionContract, expectedProjectionContract),
      `${label} projection contract differs from policy`,
    );
  }
  assert(
    same(source.reconciled_tables, target.reconciled_tables),
    'the approved vehicle photo URL rewrite changed row content',
  );
  const transitionSummary = validateDirectTransitions(source, target, policy);

  const mutableNames = Object.keys(policy.publicData.mutableTables).sort();
  assert(same(Object.keys(source.mutable_tables).sort(), mutableNames), 'source mutable table set differs from policy');
  assert(same(Object.keys(target.mutable_tables).sort(), mutableNames), 'target mutable table set differs from policy');

  for (const table of mutableNames) {
    const baseline = source.mutable_tables[table];
    const live = target.mutable_tables[table];
    assertPartition(baseline, `source.${table}`);
    assertPartition(live, `target.${table}`);
    assert(baseline.live_count === 0, `source.${table} changed after the freeze cutoff`);
    assert(baseline.total_count === live.baseline_count, `target.${table} lost or gained baseline rows`);
    assert(baseline.baseline_count === live.baseline_count, `target.${table} baseline count differs`);
    assert(baseline.baseline_key_digest === live.baseline_key_digest, `target.${table} baseline keys differ`);
    assert(
      baseline.baseline_immutable_digest === live.baseline_immutable_digest,
      `target.${table} baseline immutable fields differ`,
    );
    assertWatermark(
      live,
      watermarkAnchor.evidence.public.mutableTables[table],
      `target.${table}`,
    );
  }

  const appendOnlyNames = Object.keys(policy.publicData.appendOnlyTables ?? {}).sort();
  assert(same(Object.keys(source.append_only_tables ?? {}).sort(), appendOnlyNames), 'source append-only table set differs from policy');
  assert(same(Object.keys(target.append_only_tables ?? {}).sort(), appendOnlyNames), 'target append-only table set differs from policy');
  for (const table of appendOnlyNames) {
    const baseline = source.append_only_tables[table];
    const live = target.append_only_tables[table];
    assertPartition(baseline, `source.${table}`);
    assertPartition(live, `target.${table}`);
    assert(baseline.live_count === 0, `source.${table} changed after the freeze cutoff`);
    assert(baseline.baseline_count === live.baseline_count, `target.${table} baseline count differs`);
    assert(baseline.baseline_key_digest === live.baseline_key_digest, `target.${table} baseline keys differ`);
    assert(baseline.baseline_content_digest === live.baseline_content_digest, `target.${table} baseline content differs`);
    assert(baseline.audit_pair_mismatch_count === 0, `source.${table} has unmatched archive/audit rows`);
    assert(live.audit_pair_mismatch_count === 0, `target.${table} has unmatched archive/audit rows`);
    assert(
      watermarkAnchor.evidence.public.appendOnlyTables[table].audit_pair_mismatch_count === 0,
      `target.${table} watermark did not anchor archive/audit pairing`,
    );
    assertWatermark(live, watermarkAnchor.evidence.public.appendOnlyTables[table], `target.${table}`);
    const allowedActions = policy.publicData.appendOnlyTables[table].allowedActions;
    assert(live.live_action_counts.unexpected === 0, `target.${table} has an unexpected action`);
    assert(
      allowedActions.reduce((count, action) => count + live.live_action_counts[action], 0) === live.live_count,
      `target.${table} live rows are not covered by allowed actions`,
    );
  }

  assert(source.audit.invalid_boundary_count === 0, 'source audit log has rows without a cutoff boundary');
  assert(target.audit.invalid_boundary_count === 0, 'target audit log has rows without a cutoff boundary');
  assert(source.audit.post_cutoff_count === 0, 'source audit log changed after the freeze cutoff');
  assert(source.audit.baseline_count === target.audit.baseline_count, 'target audit log lost or gained baseline rows');
  assert(source.audit.baseline_key_digest === target.audit.baseline_key_digest, 'target audit log baseline keys differ');
  assert(
    source.audit.baseline_content_digest === target.audit.baseline_content_digest,
    'target audit log baseline content differs',
  );
  assertWatermark(
    { ...target.audit, total_count: target.audit.watermarked_count + target.audit.post_watermark_count },
    watermarkAnchor.evidence.public.audit,
    'target.audit',
  );
  assertZeroObject(
    {
      unexpected_count: source.audit.unexpected_count,
      delete_count: source.audit.delete_count,
      invalid_update_diff_count: source.audit.invalid_update_diff_count,
      disallowed_update_column_count: source.audit.disallowed_update_column_count,
      ...source.audit.insert_counts,
    },
    'source.audit',
  );
  assertZeroObject(
    {
      unexpected_count: target.audit.unexpected_count,
      delete_count: target.audit.delete_count,
      invalid_update_diff_count: target.audit.invalid_update_diff_count,
      disallowed_update_column_count: target.audit.disallowed_update_column_count,
    },
    'target.audit',
  );
  for (const table of policy.publicData.auditedTables) {
    assert(
      target.audit.insert_counts[table] === target.mutable_tables[table].live_count,
      `target.${table} live inserts are not fully represented in the audit log`,
    );
  }
  const auditedLiveRowCount = policy.publicData.auditedTables.reduce(
    (count, table) => count + target.mutable_tables[table].live_count,
    0,
  );
  const auditedInsertCount = policy.publicData.auditedTables.reduce(
    (count, table) => count + target.audit.insert_counts[table],
    0,
  );
  assert(
    transitionSummary.liveRowCount === auditedLiveRowCount,
    'transition replay live row count differs from audited table growth',
  );
  assert(
    transitionSummary.auditInsertCount === auditedInsertCount,
    'transition replay insert count differs from the audit aggregate',
  );
  assert(
    transitionSummary.auditEventCount === target.audit.post_cutoff_count,
    'transition replay event count differs from the audit aggregate',
  );

  assert(same(source.storage_exact_buckets, target.storage_exact_buckets), 'a non-live Storage bucket changed');
  const sourceStorage = source.storage_live_bucket;
  const targetStorage = target.storage_live_bucket;
  assert(sourceStorage.invalid_boundary_count === 0, 'source live Storage bucket has rows without a cutoff boundary');
  assert(targetStorage.invalid_boundary_count === 0, 'target live Storage bucket has rows without a cutoff boundary');
  assert(sourceStorage.live_count === 0, 'source live Storage bucket changed after the freeze cutoff');
  assert(sourceStorage.objects === sourceStorage.baseline_count, 'source live Storage bucket partition is invalid');
  assert(
    targetStorage.objects === targetStorage.baseline_count + targetStorage.live_count,
    'target live Storage bucket partition is invalid',
  );
  assert(sourceStorage.baseline_count === targetStorage.baseline_count, 'target lost baseline Storage metadata');
  assert(sourceStorage.baseline_key_digest === targetStorage.baseline_key_digest, 'target baseline Storage keys differ');
  assert(sourceStorage.public === targetStorage.public, 'live Storage bucket visibility changed');
  assert(targetStorage.bytes >= sourceStorage.bytes, 'target live Storage bucket is smaller than source');
  assertWatermark(
    { ...targetStorage, total_count: targetStorage.objects },
    watermarkAnchor.evidence.public.storageLiveBucket,
    'target.storage.rental-photos',
  );

  assertZeroObject(
    {
      all_photo_without_metadata: source.integrity.all_photo_without_metadata,
      new_photo_orphans: source.integrity.new_photo_orphans,
      new_profile_auth_orphans: source.integrity.new_profile_auth_orphans,
      new_photo_without_metadata: source.integrity.new_photo_without_metadata,
      new_metadata_without_photo: source.integrity.new_metadata_without_photo,
      new_archive_audit_without_rental: source.integrity.new_archive_audit_without_rental,
    },
    'source.integrity',
  );
  assertZeroObject(
    {
      all_photo_without_metadata: target.integrity.all_photo_without_metadata,
      new_photo_orphans: target.integrity.new_photo_orphans,
      new_profile_auth_orphans: target.integrity.new_profile_auth_orphans,
      new_photo_without_metadata: target.integrity.new_photo_without_metadata,
      new_metadata_without_photo: target.integrity.new_metadata_without_photo,
      new_archive_audit_without_rental: target.integrity.new_archive_audit_without_rental,
      source_ref_photo_urls: target.integrity.source_ref_photo_urls,
    },
    'target.integrity',
  );
  assert(
    source.integrity.all_metadata_without_photo === target.integrity.all_metadata_without_photo,
    'target changed the inherited unreferenced Storage object count',
  );
  assert(
    source.integrity.all_metadata_without_photo_digest === target.integrity.all_metadata_without_photo_digest,
    'target changed the inherited unreferenced Storage object set',
  );
  assert(
    Number.isInteger(target.integrity.all_metadata_without_photo)
      && target.integrity.all_metadata_without_photo >= 0,
    'target unreferenced Storage object count is invalid',
  );
  assert(
    /^[0-9a-f]{64}$/.test(target.integrity.all_metadata_without_photo_digest ?? ''),
    'target unreferenced Storage object digest is invalid',
  );
  assert(
    source.integrity.duplicate_photo_storage_paths === target.integrity.duplicate_photo_storage_paths,
    'target introduced duplicate rental photo paths',
  );
  assert(
    target.append_only_tables.rental_archive_audit.live_count === target.audit.archive_update_count,
    'rental archive audit rows and rental archive updates differ',
  );

  const rewrite = policy.publicData.approvedRestoreTransformations.vehiclePhotoProjectUrlRehome;
  assert(
    source.integrity.source_ref_photo_urls === rewrite.sourceReferenceCount,
    'source vehicle photo reference count differs from the frozen migration contract',
  );
  assert(
    target.integrity.source_ref_photo_urls === rewrite.targetReferenceCount,
    'target still contains a forbidden source project URL',
  );

  const workerStatusRows = validateWorkerState(source.worker_state, target.worker_state, policy);

  return {
    status: 'pass_continuity',
    exactTableCount: Object.keys(source.exact_tables).length,
    baseline: Object.fromEntries(mutableNames.map((table) => [table, source.mutable_tables[table].baseline_count])),
    liveGrowth: Object.fromEntries(mutableNames.map((table) => [table, target.mutable_tables[table].live_count])),
    operationalGrowth,
    storageLiveGrowth: targetStorage.live_count,
    activeJobControls: target.worker_state.enabled_job_controls,
    workerStatusRows,
    transition: transitionSummary,
    appendOnlyGrowth: Object.fromEntries(
      appendOnlyNames.map((table) => [table, target.append_only_tables[table].live_count]),
    ),
  };
}

export function validateAuthContinuity(source, target, policy, watermarkAnchor) {
  assert(
    new Date(target.watermark_utc).toISOString() === new Date(watermarkAnchor.watermarkUtc).toISOString(),
    'Auth continuity watermark differs from anchor',
  );
  assert(source.schema_table_count === EXPECTED_AUTH_TABLE_COUNT, 'source Auth schema table count changed');
  assert(target.schema_table_count === EXPECTED_AUTH_TABLE_COUNT, 'target Auth schema table count changed');
  assert(same(source.schema_tables, target.schema_tables), 'Auth schema table list differs');
  assert(
    same(
      Object.keys(source.stable_tables).sort(),
      [...policy.auth.stableConfigurationTables, ...EXACT_AUTH_CHURN_TABLES].sort(),
    ),
    'source stable Auth table set differs from policy',
  );
  assert(same(source.stable_tables, target.stable_tables), 'stable Auth configuration changed');

  for (const [name, digestField] of [
    ['users', 'baseline_credential_digest'],
    ['identities', 'baseline_identity_digest'],
  ]) {
    const baseline = source[name];
    const live = target[name];
    assertPartition(baseline, `source.auth.${name}`);
    assertPartition(live, `target.auth.${name}`);
    assert(baseline.live_count === 0, `source Auth ${name} changed after the freeze cutoff`);
    assert(baseline.baseline_count === live.baseline_count, `target Auth ${name} baseline count differs`);
    assert(baseline.baseline_key_digest === live.baseline_key_digest, `target Auth ${name} baseline keys differ`);
    assert(baseline[digestField] === live[digestField], `target Auth ${name} durable fields differ`);
    const anchorContentField = name === 'users' ? 'watermarked_credential_digest' : 'watermarked_identity_digest';
    assertWatermark(
      live,
      watermarkAnchor.evidence.auth[name],
      `target.auth.${name}`,
      anchorContentField,
    );
  }
  assert(source.users.baseline_deleted_after_cutoff === 0, 'a source baseline Auth user was deleted after cutoff');
  assert(target.users.baseline_deleted_after_cutoff === 0, 'a target baseline Auth user was deleted after cutoff');
  assertZeroObject(source.orphan_counts, 'source.auth.orphans');
  assertZeroObject(target.orphan_counts, 'target.auth.orphans');

  return {
    status: 'pass_continuity',
    schemaTableCount: EXPECTED_AUTH_TABLE_COUNT,
    baselineUsers: source.users.baseline_count,
    liveUsers: target.users.live_count,
    baselineIdentities: source.identities.baseline_count,
    liveIdentities: target.identities.live_count,
    sessionDelta: target.volatile_counts.sessions - source.volatile_counts.sessions,
    refreshTokenDelta: target.volatile_counts.refresh_tokens - source.volatile_counts.refresh_tokens,
  };
}

function assertCheckpointTime(target, immutableWatermarkAnchor, label) {
  const validationWatermarkUtc = normalizedUtc(target.watermark_utc);
  assert(target.watermark_utc === validationWatermarkUtc, `${label} validation watermark is not canonical UTC`);
  const immutableWatermarkUtc = normalizedUtc(immutableWatermarkAnchor.watermarkUtc);
  assert(
    new Date(validationWatermarkUtc) > new Date(immutableWatermarkUtc),
    `${label} validation watermark does not advance the immutable anchor`,
  );
  assert(
    new Date(validationWatermarkUtc).valueOf() <= Date.now() + 5_000,
    `${label} validation watermark is in the future`,
  );
  return validationWatermarkUtc;
}

function currentDigestAnchor(evidence, label, contentField = 'watermarked_content_digest') {
  assert(Number.isInteger(evidence?.watermarked_count), `${label} watermarked count is invalid`);
  assert(evidence.watermarked_count >= 0, `${label} watermarked count is negative`);
  assert(evidence.post_watermark_count === 0, `${label} changed during the validation checkpoint`);
  assert(/^[0-9a-f]{64}$/.test(evidence.watermarked_key_digest ?? ''), `${label} key digest is invalid`);
  assert(/^[0-9a-f]{64}$/.test(evidence[contentField] ?? ''), `${label} content digest is invalid`);
  return {
    watermarked_count: evidence.watermarked_count,
    watermarked_key_digest: evidence.watermarked_key_digest,
    watermarked_content_digest: evidence[contentField],
  };
}

function currentPublicAnchor(target, policy, immutableWatermarkAnchor) {
  const watermarkUtc = assertCheckpointTime(target, immutableWatermarkAnchor, 'public');
  const operationalContract = requireOperationalPolicy(policy);
  assert(
    sameCanonical(target.operational_contract, operationalContract),
    'target operational contract differs from policy',
  );
  const mutableTables = Object.fromEntries(
    Object.keys(policy.publicData.mutableTables).sort().map((table) => [
      table,
      currentDigestAnchor(target.mutable_tables?.[table], `target.${table}`),
    ]),
  );
  const appendOnlyTables = Object.fromEntries(
    Object.keys(policy.publicData.appendOnlyTables ?? {}).sort().map((table) => {
      const evidence = target.append_only_tables?.[table];
      const anchor = currentDigestAnchor(evidence, `target.${table}`);
      assert(
        Number.isInteger(evidence.audit_pair_mismatch_count),
        `target.${table} pairing count is invalid`,
      );
      return [table, {
        ...anchor,
        audit_pair_mismatch_count: evidence.audit_pair_mismatch_count,
      }];
    }),
  );
  const operationalTables = Object.fromEntries(
    OPERATIONAL_CONTINUITY_TABLES.map((table) => [
      table,
      currentDigestAnchor(
        target.operational_tables?.[table],
        `target operational ${table}`,
      ),
    ]),
  );
  return {
    watermarkUtc,
    evidence: {
      public: {
        mutableTables,
        audit: currentDigestAnchor(target.audit, 'target.audit'),
        storageLiveBucket: currentDigestAnchor(
          target.storage_live_bucket,
          'target.storage.rental-photos',
        ),
        appendOnlyTables,
        operationalTables,
      },
    },
  };
}

function currentAuthAnchor(target, immutableWatermarkAnchor) {
  const watermarkUtc = assertCheckpointTime(target, immutableWatermarkAnchor, 'Auth');
  return {
    watermarkUtc,
    evidence: {
      auth: {
        users: currentDigestAnchor(
          target.users,
          'target.auth.users',
          'watermarked_credential_digest',
        ),
        identities: currentDigestAnchor(
          target.identities,
          'target.auth.identities',
          'watermarked_identity_digest',
        ),
      },
    },
  };
}

export function validateLivePublicCheckpoint(
  source,
  target,
  previousTarget,
  policy,
  immutableWatermarkAnchor,
) {
  validatePreviousPublicBoundedEvidence(previousTarget, immutableWatermarkAnchor);
  const validationAnchor = currentPublicAnchor(target, policy, immutableWatermarkAnchor);
  return {
    ...validatePublicContinuity(source, target, policy, validationAnchor),
    validationMode: 'live_checkpoint_bound_to_immutable_anchor',
    validationWatermarkUtc: validationAnchor.watermarkUtc,
  };
}

export function validateLiveAuthCheckpoint(
  source,
  target,
  previousTarget,
  policy,
  immutableWatermarkAnchor,
) {
  validatePreviousAuthBoundedEvidence(previousTarget, immutableWatermarkAnchor);
  const validationAnchor = currentAuthAnchor(target, immutableWatermarkAnchor);
  return {
    ...validateAuthContinuity(source, target, policy, validationAnchor),
    validationMode: 'live_checkpoint_bound_to_immutable_anchor',
    validationWatermarkUtc: validationAnchor.watermarkUtc,
  };
}

function usage() {
  fail([
    'usage: validate-live-target-continuity.mjs',
    '<public|auth> <source.json> <target.json> <policy.json> <watermark-anchor.json>',
    '<source-sha256> <target-sha256> <policy-sha256> <anchor-sha256>',
    'or <public-live|auth-live> <source.json> <target.json> <previous-target.json>',
    '<policy.json> <immutable-watermark-anchor.json> <source-sha256> <target-sha256>',
    '<previous-target-sha256> <policy-sha256> <anchor-sha256>',
  ].join(' '));
}

function readBoundJson(path, expectedSha256, label, { privateFile = true } = {}) {
  assert(/^[0-9a-f]{64}$/.test(expectedSha256 ?? ''), `${label} expected checksum is invalid`);
  const snapshot = readSecureJsonSnapshot(resolve(path), {
    trustedRoot: REPOSITORY_ROOT,
    privateFile,
  });
  assert(snapshot.sha256 === expectedSha256, `${label} checksum changed before validation`);
  return snapshot.value;
}

function main(argv) {
  if (![9, 11].includes(argv.length)) usage();
  const [mode, sourcePath, targetPath] = argv;
  const liveMode = mode === 'public-live' || mode === 'auth-live';
  assert(argv.length === (liveMode ? 11 : 9), 'validator mode has an invalid argument count');
  const previousTargetPath = liveMode ? argv[3] : null;
  const policyPath = argv[liveMode ? 4 : 3];
  const watermarkAnchorPath = argv[liveMode ? 5 : 4];
  const checksumOffset = liveMode ? 6 : 5;
  const sourceSha256 = argv[checksumOffset];
  const targetSha256 = argv[checksumOffset + 1];
  const previousTargetSha256 = liveMode ? argv[checksumOffset + 2] : null;
  const policySha256 = argv[checksumOffset + (liveMode ? 3 : 2)];
  const watermarkAnchorSha256 = argv[checksumOffset + (liveMode ? 4 : 3)];
  const source = readBoundJson(sourcePath, sourceSha256, 'source evidence');
  const target = readBoundJson(targetPath, targetSha256, 'target evidence');
  const previousTarget = previousTargetPath
    ? readBoundJson(previousTargetPath, previousTargetSha256, 'previous target evidence')
    : null;
  const policy = readBoundJson(policyPath, policySha256, 'continuity policy', { privateFile: false });
  const watermarkAnchor = readBoundJson(
    watermarkAnchorPath,
    watermarkAnchorSha256,
    'watermark anchor',
  );
  const report = mode === 'public'
    ? validatePublicContinuity(source, target, policy, watermarkAnchor)
    : mode === 'auth'
      ? validateAuthContinuity(source, target, policy, watermarkAnchor)
      : mode === 'public-live'
        ? validateLivePublicCheckpoint(source, target, previousTarget, policy, watermarkAnchor)
        : mode === 'auth-live'
          ? validateLiveAuthCheckpoint(source, target, previousTarget, policy, watermarkAnchor)
      : usage();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
