#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  readSecureJsonSnapshot,
  writeExclusiveSecureFile,
} from './secure-file-snapshot.mjs';
import { validateDirectTransitions } from './validate-live-target-continuity.mjs';

const EXPECTED_SOURCE_REF = 'jcwbiulwuwyrnmzjjbgr';
const EXPECTED_TARGET_REF = 'sjcsrygkkmersoczpunh';

function fail(message) {
  throw new Error(`LIVE_TRANSITION_RECEIPT_FAILED: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function strictUtc(value, label) {
  requireCondition(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value),
    `${label} is not a strict UTC timestamp`,
  );
  const timestamp = Date.parse(value);
  requireCondition(Number.isFinite(timestamp), `${label} is invalid`);
  requireCondition(new Date(timestamp).toISOString().replace('.000Z', 'Z') === value, `${label} is not canonical UTC`);
  return timestamp;
}

function normalizedUtc(value, label) {
  const timestamp = Date.parse(value);
  requireCondition(typeof value === 'string' && Number.isFinite(timestamp), `${label} is invalid`);
  return new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function main(argv) {
  requireCondition(
    argv.length === 5,
    'usage: create-live-transition-receipt.mjs SOURCE_JSON TARGET_JSON POLICY PREVIOUS_WATERMARK OUTPUT',
  );
  const [sourceArgument, targetArgument, policyArgument, previousArgument, outputArgument] = argv;
  const sourcePath = resolve(sourceArgument);
  const targetPath = resolve(targetArgument);
  const policyPath = resolve(policyArgument);
  const policyDirectory = realpathSync(dirname(policyPath));
  const repositoryRoot = resolve(dirname(policyPath), '../..');
  const previousPath = resolve(previousArgument);
  const outputPath = resolve(outputArgument);
  requireCondition(
    realpathSync(dirname(outputPath)) === realpathSync(dirname(previousPath)),
    'transition receipt escaped the continuity directory',
  );
  const source = readSecureJsonSnapshot(sourcePath, { trustedRoot: repositoryRoot, privateFile: true }).value;
  const target = readSecureJsonSnapshot(targetPath, { trustedRoot: repositoryRoot, privateFile: true }).value;
  const policySnapshot = readSecureJsonSnapshot(policyPath, { trustedRoot: repositoryRoot });
  const policy = policySnapshot.value;
  const previousSnapshot = readSecureJsonSnapshot(previousPath, {
    trustedRoot: repositoryRoot,
    privateFile: true,
  });
  const previous = previousSnapshot.value;
  requireCondition(
    typeof policy.supersedesPolicyPath === 'string'
      && /^deploy\/supabase\/live-target-continuity-policy-v\d+[.]json$/.test(policy.supersedesPolicyPath),
    'superseded policy path is invalid',
  );
  const supersededPolicyPath = resolve(repositoryRoot, policy.supersedesPolicyPath);
  requireCondition(
    realpathSync(dirname(supersededPolicyPath)) === policyDirectory,
    'superseded policy escaped its directory',
  );

  const supersededPolicySnapshot = readSecureJsonSnapshot(supersededPolicyPath, {
    trustedRoot: repositoryRoot,
  });
  const supersededPolicy = supersededPolicySnapshot.value;
  requireCondition(policy.schemaVersion >= 3, 'current policy must use schema v3 or newer');
  requireCondition(supersededPolicySnapshot.sha256 === policy.supersedesPolicySha256, 'superseded policy hash differs');
  requireCondition(supersededPolicy.schemaVersion === policy.schemaVersion - 1, 'policy chain is not consecutive');
  requireCondition(policy.sourceProjectRef === EXPECTED_SOURCE_REF, 'policy source differs');
  requireCondition(policy.targetProjectRef === EXPECTED_TARGET_REF, 'policy target differs');
  requireCondition(previous.schemaVersion === policy.schemaVersion - 1, 'previous watermark schema is not consecutive');
  requireCondition(previous.snapshotId === policy.snapshotId, 'previous watermark snapshot differs');
  requireCondition(previous.sourceProjectRef === EXPECTED_SOURCE_REF, 'previous watermark source differs');
  requireCondition(previous.targetProjectRef === EXPECTED_TARGET_REF, 'previous watermark target differs');
  requireCondition(
    previous.continuityPolicySha256 === policy.supersedesPolicySha256,
    'previous watermark does not bind the superseded policy',
  );
  const sourceWatermarkUtc = normalizedUtc(source.watermark_utc, 'source transition watermark');
  const targetWatermarkUtc = normalizedUtc(target.watermark_utc, 'target transition watermark');
  requireCondition(sourceWatermarkUtc === targetWatermarkUtc, 'source/target evidence watermark differs');
  requireCondition(
    Date.parse(targetWatermarkUtc) > strictUtc(previous.watermarkUtc, 'v2 watermark'),
    'transition watermark does not advance the chain',
  );

  const transition = validateDirectTransitions(source, target, policy);
  requireCondition(transition.unexplainedDirectChangeCount === 0, 'unexplained direct change exists');
  requireCondition(transition.invalidAuditDiffCount === 0, 'invalid audit diff exists');

  const receipt = {
    schemaVersion: 1,
    snapshotId: policy.snapshotId,
    sourceProjectRef: EXPECTED_SOURCE_REF,
    targetProjectRef: EXPECTED_TARGET_REF,
    watermarkUtc: targetWatermarkUtc,
    capturedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    continuityPolicySha256: policySnapshot.sha256,
    supersedesPolicySha256: policy.supersedesPolicySha256,
    previousWatermarkAnchorSha256: previousSnapshot.sha256,
    transition,
    status: 'pass_transition_coverage',
    privacy: [
      'Aggregate record-scoped transition commitments only;',
      'no row identifiers, field values, PII, credentials, or secret-derived hashes.',
    ].join(' '),
  };

  writeExclusiveSecureFile(
    outputPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
    { trustedRoot: repositoryRoot, mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify({ status: receipt.status, watermarkUtc: receipt.watermarkUtc })}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
