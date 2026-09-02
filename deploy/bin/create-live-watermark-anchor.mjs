#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readSecureJsonSnapshot,
  writeExclusiveSecureFile,
} from './secure-file-snapshot.mjs';
import { validateTargetReconciliationReceipts } from './target-reconciliation-receipts.mjs';
import {
  OPERATIONAL_BASELINE_UTC,
  OPERATIONAL_CONTINUITY_TABLES,
  validateAuthContinuity,
  validatePreviousBoundedEvidence,
  validatePublicContinuity,
  validateTargetWorkerState,
} from './validate-live-target-continuity.mjs';

const EXPECTED_SOURCE_REF = 'jcwbiulwuwyrnmzjjbgr';
const EXPECTED_TARGET_REF = 'sjcsrygkkmersoczpunh';
const EXPECTED_INITIAL_LIVE = {
  profiles: 1,
  rental_photos: 156,
  rentals: 12,
  vehicles: 0,
};
const EXPECTED_INITIAL_APPEND_ONLY = {
  rental_archive_audit: 3,
};

function requireCondition(condition, message) {
  if (!condition) throw new Error(`LIVE_WATERMARK_ANCHOR_FAILED: ${message}`);
}

function normalizedUtc(value) {
  const date = new Date(value);
  requireCondition(Number.isFinite(date.valueOf()), 'watermark timestamp is invalid');
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function digestFields(evidence, names) {
  const output = {};
  for (const name of names) {
    requireCondition(Number.isInteger(evidence[name]) && evidence[name] >= 0, `${name} is invalid`);
    output[name] = evidence[name];
  }
  for (const name of ['watermarked_key_digest', 'watermarked_content_digest']) {
    requireCondition(/^[0-9a-f]{64}$/.test(evidence[name]), `${name} is invalid`);
    output[name] = evidence[name];
  }
  return output;
}

function normalizedColumnContract(value) {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([table, columns]) => [table, [...columns].sort()]),
  );
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

function resolveSupersededPolicy(repositoryRoot, policyDirectory, relativePath) {
  requireCondition(
    typeof relativePath === 'string'
      && /^deploy\/supabase\/live-target-continuity-policy-v\d+[.]json$/.test(relativePath),
    'superseded policy path is invalid',
  );
  const path = resolve(repositoryRoot, relativePath);
  requireCondition(realpathSync(dirname(path)) === policyDirectory, 'superseded policy escaped its directory');
  return path;
}

function main(argv) {
  if (argv.length !== 11) {
    throw new Error([
      'usage: create-live-watermark-anchor.mjs TARGET_PUBLIC TARGET_AUTH',
      'PREVIOUS_TARGET_PUBLIC PREVIOUS_TARGET_AUTH SOURCE_PUBLIC SOURCE_AUTH',
      'POLICY BASE_ANCHOR PREVIOUS_WATERMARK TRANSITION_RECEIPT OUTPUT',
    ].join(' '));
  }
  const [
    publicPath,
    authPath,
    previousPublicPath,
    previousAuthPath,
    sourcePublicPath,
    sourceAuthPath,
    policyArgument,
    baseAnchorArgument,
    previousWatermarkArgument,
    transitionReceiptArgument,
    outputArgument,
  ] = argv;
  const policyPath = resolve(policyArgument);
  const policyDirectory = realpathSync(dirname(policyPath));
  const repositoryRoot = resolve(dirname(policyPath), '../..');
  const baseAnchorPath = resolve(baseAnchorArgument);
  const previousWatermarkPath = resolve(previousWatermarkArgument);
  const transitionReceiptPath = resolve(transitionReceiptArgument);
  const outputPath = resolve(outputArgument);
  const continuityDirectory = realpathSync(dirname(baseAnchorPath));
  for (const path of [previousWatermarkPath, transitionReceiptPath, outputPath]) {
    requireCondition(realpathSync(dirname(path)) === continuityDirectory, 'continuity artifact escaped its directory');
  }
  const privateSnapshot = (path) => readSecureJsonSnapshot(resolve(path), {
    trustedRoot: repositoryRoot,
    privateFile: true,
  });
  const publicEvidence = privateSnapshot(publicPath).value;
  const authEvidence = privateSnapshot(authPath).value;
  const previousPublicEvidence = privateSnapshot(previousPublicPath).value;
  const previousAuthEvidence = privateSnapshot(previousAuthPath).value;
  const sourcePublicEvidence = privateSnapshot(sourcePublicPath).value;
  const sourceAuthEvidence = privateSnapshot(sourceAuthPath).value;
  const policySnapshot = readSecureJsonSnapshot(policyPath, { trustedRoot: repositoryRoot });
  const policy = policySnapshot.value;
  const baseAnchorSnapshot = privateSnapshot(baseAnchorPath);
  const baseAnchor = baseAnchorSnapshot.value;
  const previousWatermarkSnapshot = privateSnapshot(previousWatermarkPath);
  const previousWatermark = previousWatermarkSnapshot.value;
  const transitionReceiptSnapshot = privateSnapshot(transitionReceiptPath);
  const transitionReceipt = transitionReceiptSnapshot.value;
  const supersededPolicyPath = resolveSupersededPolicy(
    repositoryRoot,
    policyDirectory,
    policy.supersedesPolicyPath,
  );
  const supersededPolicySnapshot = readSecureJsonSnapshot(supersededPolicyPath, {
    trustedRoot: repositoryRoot,
  });
  const supersededPolicy = supersededPolicySnapshot.value;
  let rootPolicy = policy;
  let rootPolicySha256 = policySnapshot.sha256;
  while (rootPolicy.schemaVersion > 1) {
    const nextPath = resolveSupersededPolicy(
      repositoryRoot,
      policyDirectory,
      rootPolicy.supersedesPolicyPath,
    );
    const nextSnapshot = readSecureJsonSnapshot(nextPath, { trustedRoot: repositoryRoot });
    requireCondition(nextSnapshot.sha256 === rootPolicy.supersedesPolicySha256, 'policy chain hash differs');
    rootPolicy = nextSnapshot.value;
    rootPolicySha256 = nextSnapshot.sha256;
  }

  requireCondition(policy.schemaVersion >= 3, 'policy schema is older than v3');
  requireCondition(
    policy.publicData.reviewedLiveEvolution?.requiresPerRentalArchiveAuditPairing === true,
    'policy does not require per-rental archive/audit pairing',
  );
  requireCondition(
    policy.publicData.reviewedLiveEvolution?.requiresRentalPhotoPathSetIntegrity === true,
    'policy does not require rental photo path-set integrity',
  );
  for (const flag of [
    'requiresIncrementalAuditReplay',
    'requiresFullInsertStateReplay',
    'requiresPreviousBoundedEvidenceReplay',
    'requiresVerifiedPrivateQuarantinesAtCapture',
    'requiresCanonicalStoragePathDigests',
  ]) {
    requireCondition(policy.publicData.reviewedLiveEvolution?.[flag] === true, `policy does not require ${flag}`);
  }
  const operationalPolicy = policy.publicData.operationalContinuity;
  requireCondition(policy.schemaVersion >= 12, 'policy schema is older than v12');
  requireCondition(operationalPolicy?.boundaryColumn === 'created_at', 'operational boundary column differs');
  requireCondition(
    operationalPolicy?.operationalBaselineUtc === OPERATIONAL_BASELINE_UTC,
    'operational baseline timestamp differs from the completed source freeze',
  );
  for (const guard of [
    'requiresSourceFrozenNoLiveRows',
    'requiresBaselineKeyEquality',
    'requiresBaselineImmutableProjectionEquality',
    'requiresWatermarkReplay',
    'requiresZeroInvalidLiveRows',
  ]) {
    requireCondition(operationalPolicy?.[guard] === true, `policy does not require ${guard}`);
  }
  requireCondition(
    same(Object.keys(operationalPolicy.tables ?? {}).sort(), OPERATIONAL_CONTINUITY_TABLES),
    'operational policy table set differs',
  );
  requireCondition(supersededPolicy.schemaVersion === policy.schemaVersion - 1, 'superseded policy schema is not consecutive');
  requireCondition(
    supersededPolicySnapshot.sha256 === policy.supersedesPolicySha256,
    'superseded policy file hash differs',
  );
  requireCondition(policy.sourceProjectRef === EXPECTED_SOURCE_REF, 'policy source differs');
  requireCondition(policy.targetProjectRef === EXPECTED_TARGET_REF, 'policy target differs');
  requireCondition(baseAnchor.sourceProjectRef === EXPECTED_SOURCE_REF, 'base anchor source differs');
  requireCondition(baseAnchor.targetProjectRef === EXPECTED_TARGET_REF, 'base anchor target differs');
  requireCondition(baseAnchor.snapshotId === policy.snapshotId, 'base anchor snapshot differs');
  requireCondition(
    baseAnchor.evidence?.continuityPolicySha256 === rootPolicySha256,
    'root policy hash differs from base anchor',
  );
  requireCondition(previousWatermark.schemaVersion === policy.schemaVersion - 1, 'previous watermark schema is not consecutive');
  requireCondition(previousWatermark.snapshotId === policy.snapshotId, 'previous watermark snapshot differs');
  requireCondition(previousWatermark.sourceProjectRef === EXPECTED_SOURCE_REF, 'previous watermark source differs');
  requireCondition(previousWatermark.targetProjectRef === EXPECTED_TARGET_REF, 'previous watermark target differs');
  requireCondition(
    previousWatermark.continuityPolicySha256 === policy.supersedesPolicySha256,
    'previous watermark policy differs from the superseded policy',
  );
  requireCondition(
    previousWatermark.baseContinuityAnchorSha256 === baseAnchorSnapshot.sha256,
    'previous watermark base anchor differs',
  );
  requireCondition(transitionReceipt.schemaVersion === 1, 'transition receipt schema differs');
  requireCondition(transitionReceipt.snapshotId === policy.snapshotId, 'transition receipt snapshot differs');
  requireCondition(transitionReceipt.sourceProjectRef === EXPECTED_SOURCE_REF, 'transition receipt source differs');
  requireCondition(transitionReceipt.targetProjectRef === EXPECTED_TARGET_REF, 'transition receipt target differs');
  requireCondition(transitionReceipt.continuityPolicySha256 === policySnapshot.sha256, 'transition receipt policy differs');
  requireCondition(
    transitionReceipt.previousWatermarkAnchorSha256 === previousWatermarkSnapshot.sha256,
    'transition receipt previous watermark differs',
  );
  requireCondition(transitionReceipt.status === 'pass_transition_coverage', 'transition receipt did not pass');
  requireCondition(
    transitionReceipt.transition?.status === 'pass_transition_replay',
    'transition receipt did not complete incremental replay',
  );
  requireCondition(
    transitionReceipt.transition?.unexplainedDirectChangeCount === 0
      && transitionReceipt.transition?.invalidAuditDiffCount === 0,
    'transition receipt contains an unsafe transition',
  );
  requireCondition(
    same(normalizedColumnContract(publicEvidence.projection_contract?.allowedUpdateColumns),
      normalizedColumnContract(policy.publicData.allowedUpdateColumns)),
    'allowed update projection differs from policy',
  );
  requireCondition(
    same(normalizedColumnContract(publicEvidence.projection_contract?.immutableProjectionExcludedColumns),
      normalizedColumnContract(policy.publicData.immutableProjectionExcludedColumns)),
    'immutable projection differs from policy',
  );

  const publicWatermark = normalizedUtc(publicEvidence.watermark_utc);
  const authWatermark = normalizedUtc(authEvidence.watermark_utc);
  const previousWatermarkUtc = normalizedUtc(previousWatermark.watermarkUtc);
  validatePreviousBoundedEvidence(
    previousPublicEvidence,
    previousAuthEvidence,
    previousWatermark,
    requireCondition,
  );
  const targetReconciliations = validateTargetReconciliationReceipts(
    policy,
    policyPath,
    publicWatermark,
    { requirePrivateQuarantine: true },
  );
  requireCondition(publicWatermark === authWatermark, 'public/Auth watermark differs');
  requireCondition(
    publicWatermark === normalizedUtc(sourcePublicEvidence.watermark_utc),
    'source/target public watermark differs',
  );
  requireCondition(
    authWatermark === normalizedUtc(sourceAuthEvidence.watermark_utc),
    'source/target Auth watermark differs',
  );
  requireCondition(publicWatermark === normalizedUtc(transitionReceipt.watermarkUtc), 'transition watermark differs');
  requireCondition(
    new Date(publicWatermark) > new Date(previousWatermarkUtc),
    'watermark does not advance the immutable chain',
  );
  requireCondition(new Date(publicWatermark) <= new Date(), 'watermark is in the future');

  const mutableTables = {};
  for (const [table, minimumLiveCount] of Object.entries(EXPECTED_INITIAL_LIVE)) {
    const evidence = publicEvidence.mutable_tables?.[table];
    requireCondition(evidence?.live_count >= minimumLiveCount, `${table} lost previously approved live rows`);
    requireCondition(evidence.post_watermark_count === 0, `${table} changed after the capture watermark`);
    mutableTables[table] = digestFields(evidence, [
      'watermarked_count',
      'post_watermark_count',
    ]);
  }
  const appendOnlyTables = {};
  for (const [table, minimumLiveCount] of Object.entries(EXPECTED_INITIAL_APPEND_ONLY)) {
    const evidence = publicEvidence.append_only_tables?.[table];
    requireCondition(policy.publicData.appendOnlyTables?.[table], `${table} is missing from policy`);
    requireCondition(evidence?.live_count >= minimumLiveCount, `${table} lost previously approved live rows`);
    requireCondition(evidence.post_watermark_count === 0, `${table} changed after the capture watermark`);
    requireCondition(evidence.audit_pair_mismatch_count === 0, `${table} has unmatched archive/audit rows`);
    requireCondition(evidence.live_action_counts?.unexpected === 0, `${table} contains an unexpected action`);
    appendOnlyTables[table] = digestFields(evidence, [
      'watermarked_count',
      'post_watermark_count',
      'audit_pair_mismatch_count',
    ]);
  }
  requireCondition(publicEvidence.audit?.post_cutoff_count >= 22, 'approved audit delta is incomplete');
  requireCondition(publicEvidence.audit?.post_watermark_count === 0, 'audit changed after the capture watermark');
  requireCondition(publicEvidence.audit?.unexpected_count === 0, 'unexpected audit action exists');
  requireCondition(publicEvidence.audit?.delete_count === 0, 'audited deletion exists');
  requireCondition(publicEvidence.audit?.invalid_update_diff_count === 0, 'empty or invalid update audit diff exists');
  requireCondition(
    publicEvidence.audit?.disallowed_update_column_count === 0,
    'disallowed audited update exists',
  );
  requireCondition(publicEvidence.storage_live_bucket?.live_count >= 156, 'approved Storage metadata delta is incomplete');
  requireCondition(publicEvidence.storage_live_bucket?.post_watermark_count === 0, 'Storage metadata changed after the capture watermark');
  requireCondition(
    same(canonicalJson(publicEvidence.operational_contract), canonicalJson(operationalPolicy)),
    'operational evidence contract differs from policy',
  );
  requireCondition(
    same(Object.keys(publicEvidence.operational_tables ?? {}).sort(), OPERATIONAL_CONTINUITY_TABLES),
    'operational evidence table set differs from policy',
  );
  const operationalTables = {};
  for (const table of OPERATIONAL_CONTINUITY_TABLES) {
    const evidence = publicEvidence.operational_tables[table];
    requireCondition(evidence?.invalid_live_contract_count === 0, `${table} violates the operational contract`);
    requireCondition(evidence.post_watermark_count === 0, `${table} changed after the capture watermark`);
    operationalTables[table] = digestFields(evidence, [
      'watermarked_count',
      'post_watermark_count',
    ]);
  }
  validateTargetWorkerState(publicEvidence.worker_state, policy);
  for (const [name, count] of Object.entries(publicEvidence.integrity ?? {})) {
    if (['all_metadata_without_photo', 'all_metadata_without_photo_digest', 'duplicate_photo_storage_paths'].includes(name)) continue;
    requireCondition(count === 0, `public integrity ${name} is non-zero`);
  }
  requireCondition(
    Number.isInteger(publicEvidence.integrity?.all_metadata_without_photo)
      && publicEvidence.integrity.all_metadata_without_photo >= 0,
    'unreferenced Storage object count is invalid',
  );
  requireCondition(
    /^[0-9a-f]{64}$/.test(publicEvidence.integrity?.all_metadata_without_photo_digest ?? ''),
    'unreferenced Storage object digest is invalid',
  );
  requireCondition(authEvidence.users?.live_count >= 1, 'approved Auth user delta is incomplete');
  requireCondition(authEvidence.identities?.live_count >= 1, 'approved Auth identity delta is incomplete');
  requireCondition(authEvidence.users?.post_watermark_count === 0, 'Auth users changed after the capture watermark');
  requireCondition(authEvidence.identities?.post_watermark_count === 0, 'Auth identities changed after the capture watermark');
  requireCondition(Object.values(authEvidence.orphan_counts ?? {}).every((count) => count === 0), 'Auth orphan detected');

  const userEvidence = {
    ...digestFields({
      ...authEvidence.users,
      watermarked_content_digest: authEvidence.users.watermarked_credential_digest,
    }, ['watermarked_count', 'post_watermark_count']),
  };
  const identityEvidence = {
    ...digestFields({
      ...authEvidence.identities,
      watermarked_content_digest: authEvidence.identities.watermarked_identity_digest,
    }, ['watermarked_count', 'post_watermark_count']),
  };
  const anchor = {
    schemaVersion: policy.schemaVersion,
    snapshotId: policy.snapshotId,
    sourceProjectRef: EXPECTED_SOURCE_REF,
    targetProjectRef: EXPECTED_TARGET_REF,
    watermarkUtc: publicWatermark,
    capturedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    continuityPolicySha256: policySnapshot.sha256,
    supersedesPolicySha256: policy.supersedesPolicySha256,
    rootPolicySha256,
    baseContinuityAnchorSha256: baseAnchorSnapshot.sha256,
    previousWatermarkAnchorSha256: previousWatermarkSnapshot.sha256,
    transitionReceiptFile: basename(transitionReceiptPath),
    transitionReceiptSha256: transitionReceiptSnapshot.sha256,
    targetReconciliationReceiptFiles: targetReconciliations.files,
    targetReconciliationReceiptSha256s: targetReconciliations.hashes,
    evidence: {
      public: {
        mutableTables,
        audit: digestFields(publicEvidence.audit, ['watermarked_count', 'post_watermark_count']),
        storageLiveBucket: digestFields(publicEvidence.storage_live_bucket, [
          'watermarked_count',
          'post_watermark_count',
        ]),
        appendOnlyTables,
        operationalTables,
      },
      auth: {
        users: userEvidence,
        identities: identityEvidence,
      },
    },
    projectionMode: `policy-defined-immutable-fields-plus-append-only-audit-and-direct-transition-v${policy.schemaVersion}`,
    privacy: 'Private aggregate continuity digests only; no row identifiers, object names, PII, credentials, or secret-derived hashes.',
  };

  validatePublicContinuity(sourcePublicEvidence, publicEvidence, policy, anchor);
  validateAuthContinuity(sourceAuthEvidence, authEvidence, policy, anchor);

  writeExclusiveSecureFile(
    outputPath,
    `${JSON.stringify(anchor, null, 2)}\n`,
    { trustedRoot: repositoryRoot, mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify({ status: 'anchored', watermarkUtc: publicWatermark })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
