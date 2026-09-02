#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readSecureFileSnapshot } from './secure-file-snapshot.mjs';
import { validateTargetReconciliationReceipts } from './target-reconciliation-receipts.mjs';

function fail(message) {
  throw new Error(`WATERMARK_CHAIN_FAILED: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

const snapshots = new Map();
let trustedRoot;

function readSnapshot(path, { privateFile = false } = {}) {
  let snapshot = snapshots.get(path);
  if (!snapshot) {
    snapshot = readSecureFileSnapshot(path, { trustedRoot });
    snapshots.set(path, snapshot);
  }
  if (privateFile) requireCondition((snapshot.mode & 0o077) === 0, `${path} is not private`);
  return snapshot;
}

function sha256(path) {
  return readSnapshot(path).sha256;
}

function readPrivateJson(path) {
  return JSON.parse(readSnapshot(path, { privateFile: true }).contents.toString('utf8'));
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

function main(argv) {
  requireCondition(argv.length >= 3, 'usage: resolve-live-watermark-anchor.mjs POLICY BASE_ANCHOR WATERMARK...');
  const [policyArgument, baseAnchorArgument, ...watermarkArguments] = argv;
  const policyPath = resolve(policyArgument);
  const policyDirectory = realpathSync(dirname(policyPath));
  trustedRoot = resolve(dirname(policyPath), '../..');
  const baseAnchorPath = resolve(baseAnchorArgument);
  const watermarkPaths = watermarkArguments.map((path) => resolve(path));
  const continuityDirectory = realpathSync(dirname(baseAnchorPath));
  requireCondition(
    watermarkPaths.every((path) => realpathSync(dirname(path)) === continuityDirectory),
    'watermark escaped the continuity directory',
  );
  const policy = JSON.parse(readSnapshot(policyPath).contents.toString('utf8'));
  requireCondition(
    Number.isInteger(policy.schemaVersion) && policy.schemaVersion >= 3,
    'current policy must use schema v3 or newer',
  );
  requireCondition(argv.length === policy.schemaVersion + 2, 'watermark count does not match policy schema');
  const baseAnchor = readPrivateJson(baseAnchorPath);
  const watermarks = watermarkPaths.map((path) => ({ path, value: readPrivateJson(path) }));
  const policySha256 = sha256(policyPath);
  const baseAnchorSha256 = sha256(baseAnchorPath);
  const repositoryRoot = trustedRoot;
  const policies = new Map();
  let policyCursorPath = policyPath;
  let expectedPolicyVersion = policy.schemaVersion;
  while (expectedPolicyVersion >= 1) {
    const value = JSON.parse(readSnapshot(policyCursorPath).contents.toString('utf8'));
    requireCondition(value.schemaVersion === expectedPolicyVersion, 'policy chain is not consecutive');
    policies.set(expectedPolicyVersion, { path: policyCursorPath, value, sha256: sha256(policyCursorPath) });
    if (expectedPolicyVersion === 1) break;
    requireCondition(
      typeof value.supersedesPolicyPath === 'string'
        && /^deploy\/supabase\/live-target-continuity-policy-v\d+[.]json$/.test(value.supersedesPolicyPath),
      'superseded policy path is invalid',
    );
    const nextPath = resolve(repositoryRoot, value.supersedesPolicyPath);
    requireCondition(realpathSync(dirname(nextPath)) === policyDirectory, 'superseded policy escaped its directory');
    requireCondition(sha256(nextPath) === value.supersedesPolicySha256, 'policy chain hash differs');
    policyCursorPath = nextPath;
    expectedPolicyVersion -= 1;
  }
  const rootPolicySha256 = policies.get(1).sha256;
  requireCondition(baseAnchor.schemaVersion === 1, 'base continuity anchor schema differs');
  requireCondition(baseAnchor.snapshotId === policy.snapshotId, 'base anchor snapshot differs');
  requireCondition(baseAnchor.sourceProjectRef === policy.sourceProjectRef, 'base anchor source differs');
  requireCondition(baseAnchor.targetProjectRef === policy.targetProjectRef, 'base anchor target differs');
  requireCondition(
    baseAnchor.evidence?.continuityPolicySha256 === rootPolicySha256,
    'base anchor does not bind the root policy',
  );

  const watermarkByVersion = new Map();
  for (const watermark of watermarks) {
    const version = watermark.value.schemaVersion;
    requireCondition(Number.isInteger(version) && version >= 1 && version <= policy.schemaVersion, 'watermark schema is invalid');
    requireCondition(!watermarkByVersion.has(version), `watermark v${version} is duplicated`);
    watermarkByVersion.set(version, watermark);
  }
  requireCondition(watermarkByVersion.size === policy.schemaVersion, 'watermark chain is incomplete');
  const transitionReceipts = new Map();
  let previousWatermarkTime = null;
  for (let version = 1; version <= policy.schemaVersion; version += 1) {
    const watermark = watermarkByVersion.get(version);
    const versionPolicy = policies.get(version);
    const value = watermark.value;
    requireCondition(value.snapshotId === policy.snapshotId, 'watermark snapshot differs');
    requireCondition(value.sourceProjectRef === policy.sourceProjectRef, 'watermark source differs');
    requireCondition(value.targetProjectRef === policy.targetProjectRef, 'watermark target differs');
    requireCondition(value.baseContinuityAnchorSha256 === baseAnchorSha256, 'watermark base anchor differs');
    requireCondition(value.continuityPolicySha256 === versionPolicy.sha256, `watermark v${version} policy differs`);
    const watermarkTime = strictUtc(value.watermarkUtc, `watermark v${version}`);
    const targetReconciliations = validateTargetReconciliationReceipts(
      versionPolicy.value,
      versionPolicy.path,
      value.watermarkUtc,
    );
    requireCondition(
      JSON.stringify(value.targetReconciliationReceiptFiles ?? [])
        === JSON.stringify(targetReconciliations.files),
      `watermark v${version} reconciliation receipt files differ`,
    );
    requireCondition(
      JSON.stringify(value.targetReconciliationReceiptSha256s ?? [])
        === JSON.stringify(targetReconciliations.hashes),
      `watermark v${version} reconciliation receipt hashes differ`,
    );
    if (version > 1) {
      const previous = watermarkByVersion.get(version - 1);
      requireCondition(
        value.supersedesPolicySha256 === policies.get(version - 1).sha256,
        `watermark v${version} superseded policy differs`,
      );
      requireCondition(value.previousWatermarkAnchorSha256 === sha256(previous.path), `watermark v${version} previous link differs`);
      requireCondition(watermarkTime > previousWatermarkTime, `watermark v${version} does not advance the chain`);
    }
    if (version === 2) {
      requireCondition(
        value.projectionMode === 'policy-defined-immutable-fields-plus-append-only-audit',
        'watermark v2 projection mode differs',
      );
    }
    if (version >= 3) {
      requireCondition(value.rootPolicySha256 === rootPolicySha256, `watermark v${version} root policy differs`);
      requireCondition(
        value.projectionMode === `policy-defined-immutable-fields-plus-append-only-audit-and-direct-transition-v${version}`,
        `watermark v${version} projection mode differs`,
      );
      requireCondition(
        typeof value.transitionReceiptFile === 'string'
          && /^live-transition-\d{8}T\d{6}Z-\d{8}T\d{6}Z\.json$/.test(value.transitionReceiptFile),
        `watermark v${version} transition receipt file is invalid`,
      );
      const receiptPath = resolve(dirname(watermark.path), value.transitionReceiptFile);
      requireCondition(
        realpathSync(dirname(receiptPath)) === realpathSync(dirname(watermark.path)),
        `watermark v${version} transition receipt escaped its directory`,
      );
      const receipt = readPrivateJson(receiptPath);
      requireCondition(value.transitionReceiptSha256 === sha256(receiptPath), `watermark v${version} transition receipt hash differs`);
      requireCondition(receipt.schemaVersion === 1, 'transition receipt schema differs');
      requireCondition(receipt.snapshotId === policy.snapshotId, 'transition receipt snapshot differs');
      requireCondition(receipt.sourceProjectRef === policy.sourceProjectRef, 'transition receipt source differs');
      requireCondition(receipt.targetProjectRef === policy.targetProjectRef, 'transition receipt target differs');
      requireCondition(receipt.continuityPolicySha256 === versionPolicy.sha256, 'transition receipt policy differs');
      requireCondition(
        receipt.previousWatermarkAnchorSha256 === sha256(watermarkByVersion.get(version - 1).path),
        'transition receipt previous watermark differs',
      );
      requireCondition(receipt.status === 'pass_transition_coverage', 'transition receipt did not pass');
      if (versionPolicy.value.publicData?.reviewedLiveEvolution?.requiresIncrementalAuditReplay === true) {
        requireCondition(
          receipt.transition?.status === 'pass_transition_replay',
          'transition receipt did not complete incremental replay',
        );
      }
      requireCondition(
        receipt.transition?.unexplainedDirectChangeCount === 0
          && receipt.transition?.invalidAuditDiffCount === 0,
        'transition receipt contains an unsafe transition',
      );
      requireCondition(
        strictUtc(receipt.watermarkUtc, 'transition receipt') === watermarkTime,
        `watermark v${version} transition receipt time differs`,
      );
      transitionReceipts.set(version, { path: receiptPath, sha256: sha256(receiptPath) });
    }
    previousWatermarkTime = watermarkTime;
  }

  const root = watermarkByVersion.get(1);
  const current = watermarkByVersion.get(policy.schemaVersion);
  const previous = watermarkByVersion.get(policy.schemaVersion - 1);
  const currentTransitionReceipt = transitionReceipts.get(policy.schemaVersion);

  process.stdout.write(`${JSON.stringify({
    currentPath: current.path,
    currentSha256: sha256(current.path),
    previousPath: previous.path,
    previousSha256: sha256(previous.path),
    rootPath: root.path,
    rootSha256: sha256(root.path),
    policySha256,
    supersededPolicySha256: policy.supersedesPolicySha256,
    rootPolicySha256,
    baseAnchorSha256,
    transitionReceiptPath: currentTransitionReceipt.path,
    transitionReceiptSha256: currentTransitionReceipt.sha256,
  })}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
