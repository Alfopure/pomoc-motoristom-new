#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SOURCE_REF = 'jcwbiulwuwyrnmzjjbgr';
const TARGET_REF = 'sjcsrygkkmersoczpunh';
const SNAPSHOT_PATTERN = /^\d{8}T\d{6}Z$/;
const RUN_PATTERN = /^\d{8}T\d{6}Z$/;

function requireCondition(condition, message) {
  if (!condition) throw new Error(`CONTINUITY_ANCHOR_FAILED: ${message}`);
}

function readPrivateFile(path) {
  const metadata = lstatSync(path);
  requireCondition(metadata.isFile() && !metadata.isSymbolicLink(), `${path} is not a regular file`);
  requireCondition((metadata.mode & 0o077) === 0, `${path} is not private`);
  requireCondition(metadata.nlink === 1, `${path} has multiple hard links`);
  return readFileSync(path);
}

function parseEnv(buffer, label) {
  const parsed = {};
  for (const [index, raw] of buffer.toString('utf8').split('\n').entries()) {
    if (!raw) continue;
    const separator = raw.indexOf('=');
    requireCondition(separator > 0, `${label}:${index + 1} is not KEY=value`);
    const key = raw.slice(0, separator);
    requireCondition(!Object.hasOwn(parsed, key), `${label} contains duplicate ${key}`);
    parsed[key] = raw.slice(separator + 1);
  }
  return parsed;
}

function parseManifest(buffer, label) {
  const header = [];
  for (const line of buffer.toString('utf8').split('\n')) {
    if (/^[a-z0-9_]+:$/.test(line)) break;
    header.push(line);
  }
  return parseEnv(Buffer.from(header.join('\n')), label);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function verifyEncryptedChecksums(directory, manifestBuffer, sectionNames) {
  const lines = manifestBuffer.toString('utf8').split('\n');
  let active = false;
  let count = 0;
  for (const line of lines) {
    if (/^[a-z0-9_]+:$/.test(line)) {
      active = sectionNames.includes(line.slice(0, -1));
      continue;
    }
    if (!active || !line) continue;
    const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9._-]+\.enc)$/);
    if (!match) {
      active = false;
      continue;
    }
    const path = join(directory, match[2]);
    const contents = readPrivateFile(path);
    requireCondition(sha256(contents) === match[1], `${match[2]} checksum differs from its manifest`);
    count += 1;
  }
  requireCondition(count > 0, `no encrypted files were verified in ${basename(directory)}`);
  return count;
}

function hashEvidence(path, privateFile = true) {
  const contents = privateFile ? readPrivateFile(path) : readFileSync(path);
  return sha256(contents);
}

export function createContinuityAnchor(repoRoot, snapshotId, runId, outputDirectory) {
  requireCondition(SNAPSHOT_PATTERN.test(snapshotId), 'snapshot id is invalid');
  requireCondition(RUN_PATTERN.test(runId), 'run id is invalid');
  const root = realpathSync(resolve(repoRoot));
  const snapshotDirectory = join(root, '.context/migration/snapshots', snapshotId);
  const configDirectory = join(root, '.context/migration/config-snapshots', snapshotId);
  const snapshotManifestPath = join(snapshotDirectory, 'MANIFEST');
  const configManifestPath = join(configDirectory, 'MANIFEST');
  const freezePath = join(root, '.context/migration/source-freeze', `${snapshotId}.env`);
  const restorePath = join(root, '.context/migration/restore-receipts', `${snapshotId}.env`);
  const configReceiptPath = join(root, '.context/migration/config-application', `${snapshotId}.env`);
  const policyPath = join(root, 'deploy/supabase/live-target-continuity-policy.json');
  const reconciliationPath = join(root, 'deploy/supabase/post-restore-reconciliation.sql');

  const snapshotManifest = readPrivateFile(snapshotManifestPath);
  const configManifest = readPrivateFile(configManifestPath);
  const freezeBuffer = readPrivateFile(freezePath);
  const restoreBuffer = readPrivateFile(restorePath);
  const configReceiptBuffer = readPrivateFile(configReceiptPath);
  const freeze = parseEnv(freezeBuffer, 'freeze receipt');
  const restore = parseEnv(restoreBuffer, 'restore receipt');
  const configReceipt = parseEnv(configReceiptBuffer, 'config receipt');
  const snapshot = parseManifest(snapshotManifest, 'snapshot manifest');
  const config = parseManifest(configManifest, 'config manifest');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));

  requireCondition(snapshot.snapshot_id === snapshotId, 'snapshot manifest id mismatch');
  requireCondition(snapshot.source_project_ref === SOURCE_REF, 'snapshot manifest source mismatch');
  requireCondition(config.snapshot_id === snapshotId, 'config manifest id mismatch');
  requireCondition(config.source_project_ref === SOURCE_REF, 'config manifest source mismatch');
  requireCondition(config.target_project_ref === TARGET_REF, 'config manifest target mismatch');
  requireCondition(freeze.state === 'frozen', 'source freeze receipt is not frozen');
  requireCondition(freeze.snapshot_id === snapshotId, 'freeze receipt id mismatch');
  requireCondition(freeze.source_project_ref === SOURCE_REF && freeze.target_project_ref === TARGET_REF, 'freeze project mismatch');
  requireCondition(freeze.source_restart_verified === 'true', 'source restart was not verified');
  requireCondition(freeze.external_writers_attested_stopped === 'true', 'external writers were not attested stopped');
  requireCondition(restore.snapshot_id === snapshotId, 'restore receipt id mismatch');
  requireCondition(restore.target_project_ref === TARGET_REF, 'restore receipt target mismatch');
  requireCondition(restore.outcome === 'committed_client_confirmed', 'restore is not committed and confirmed');
  requireCondition(configReceipt.state === 'applied', 'config receipt is not applied');
  requireCondition(configReceipt.snapshot_id === snapshotId, 'config receipt id mismatch');
  requireCondition(configReceipt.source_config_drift === 'false', 'source config drift was recorded');
  requireCondition(configReceipt.target_config_drift === 'false', 'target config drift was recorded');
  requireCondition(configReceipt.source_unfrozen === 'false', 'source was unfrozen');
  const freezeHash = sha256(freezeBuffer);
  requireCondition(snapshot.source_freeze_receipt_sha256 === freezeHash, 'snapshot manifest freeze hash mismatch');
  requireCondition(config.source_freeze_receipt_sha256 === freezeHash, 'config manifest freeze hash mismatch');
  requireCondition(policy.snapshotId === snapshotId, 'policy snapshot id mismatch');
  requireCondition(policy.sourceProjectRef === SOURCE_REF, 'policy source mismatch');
  requireCondition(policy.targetProjectRef === TARGET_REF, 'policy target mismatch');
  requireCondition(policy.guards.sourceDeletionForbidden === true, 'policy allows source deletion');
  requireCondition(policy.guards.targetRewindForbidden === true, 'policy allows target rewind');
  requireCondition(policy.guards.targetJobsMustRemainDisabled === true, 'policy allows target jobs');
  requireCondition(
    policy.publicData.approvedRestoreTransformations.vehiclePhotoProjectUrlRehome.reconciliationSql
      === 'deploy/supabase/post-restore-reconciliation.sql',
    'policy reconciliation path mismatch',
  );

  const encryptedSnapshotFiles = verifyEncryptedChecksums(snapshotDirectory, snapshotManifest, ['encrypted_sha256']);
  const encryptedConfigFiles = verifyEncryptedChecksums(
    configDirectory,
    configManifest,
    ['encrypted_sha256', 'target_refresh_encrypted_sha256'],
  );
  const evidence = {
    snapshotManifestSha256: sha256(snapshotManifest),
    sourceFreezeReceiptSha256: freezeHash,
    restoreReceiptSha256: sha256(restoreBuffer),
    configManifestSha256: sha256(configManifest),
    configApplicationReceiptSha256: sha256(configReceiptBuffer),
    reconciliationSqlSha256: hashEvidence(reconciliationPath, false),
    continuityPolicySha256: hashEvidence(policyPath, false),
  };
  const anchor = {
    schemaVersion: 1,
    anchorId: `continuity-${snapshotId}-${runId}`,
    createdAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    snapshotId,
    snapshotCutoffUtc: policy.snapshotCutoffUtc,
    sourceProjectRef: SOURCE_REF,
    targetProjectRef: TARGET_REF,
    mode: policy.mode,
    historicalGateUsedAsTrustRoot: false,
    sourceFrozen: true,
    sourceDeletionForbidden: true,
    targetRewindForbidden: true,
    targetJobsMustRemainDisabled: true,
    encryptedSnapshotFilesVerified: encryptedSnapshotFiles,
    encryptedConfigFilesVerified: encryptedConfigFiles,
    evidence,
  };

  const directory = resolve(outputDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const outputPath = join(directory, `anchor-${snapshotId}-${runId}.json`);
  requireCondition(!existsSync(outputPath), 'anchor already exists');
  const descriptor = openSync(
    outputPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(anchor, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const directoryDescriptor = openSync(dirname(outputPath), constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
  return { outputPath, anchor };
}

function main(argv) {
  const [repoRoot, snapshotId, runId, outputDirectory] = argv;
  requireCondition(Boolean(repoRoot && snapshotId && runId && outputDirectory), 'four arguments are required');
  const result = createContinuityAnchor(repoRoot, snapshotId, runId, outputDirectory);
  process.stdout.write(`${JSON.stringify({
    status: 'created',
    path: result.outputPath,
    anchorId: result.anchor.anchorId,
    evidenceCount: Object.keys(result.anchor.evidence).length,
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
