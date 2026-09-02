#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  readSecureFileSnapshot,
  readSecureJsonSnapshot,
} from './secure-file-snapshot.mjs';
import {
  buildStorageTransitionManifest,
  parseStorageTransitionCatalog,
  serializeStorageTransitionCatalog,
  validateStorageObjectName,
  validateStorageTransitionManifest,
  verifyCurrentStorageCatalogContainsAnchored,
} from './storage-transition-evidence.mjs';

const EXPECTED_SOURCE_REF = 'jcwbiulwuwyrnmzjjbgr';
const EXPECTED_TARGET_REF = 'sjcsrygkkmersoczpunh';
const EXPECTED_BUCKETS = [
  'motorist-call-recordings',
  'motorist-case-attachments',
  'rental-photos',
  'signatures',
  'vehicle-damage-photos',
  'vehicle-photos',
];
const EXPECTED_LIVE_GROWTH_BUCKETS = [
  'motorist-call-recordings',
  'rental-photos',
];
const DOWNLOAD_CONCURRENCY = 6;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

function fail(message) {
  throw new Error(`STORAGE_REST_VALIDATION_FAILED: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requirePrivateFile(path, label) {
  const metadata = lstatSync(path);
  requireCondition(metadata.isFile() && !metadata.isSymbolicLink(), `${label} is not a regular file`);
  requireCondition(metadata.nlink === 1, `${label} has multiple links`);
  requireCondition((metadata.mode & 0o077) === 0, `${label} is not private`);
}

function requirePrivateDirectory(path, label) {
  const metadata = lstatSync(path);
  requireCondition(metadata.isDirectory() && !metadata.isSymbolicLink(), `${label} is not a directory`);
  requireCondition((metadata.mode & 0o077) === 0, `${label} is not private`);
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sameStringSet(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function sortedUniqueStrings(value, label) {
  requireCondition(Array.isArray(value) && value.length > 0, `${label} is invalid`);
  requireCondition(value.every((entry) => typeof entry === 'string' && entry.length > 0), `${label} is invalid`);
  const sorted = [...value].sort(byteCompare);
  requireCondition(new Set(sorted).size === sorted.length, `${label} contains duplicates`);
  requireCondition(sorted.every((entry, index) => entry === value[index]), `${label} is not byte-sorted`);
  return sorted;
}

function safeInteger(value, label) {
  const number = typeof value === 'number' ? value : Number(value);
  requireCondition(Number.isSafeInteger(number) && number >= 0, `${label} is not a safe non-negative integer`);
  return number;
}

function safeAdd(left, right, label) {
  const result = left + right;
  requireCondition(Number.isSafeInteger(result), `${label} exceeds the safe integer range`);
  return result;
}

function parseCanonicalUtcSecond(value, label) {
  requireCondition(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value),
    `${label} is invalid`,
  );
  const timestamp = Date.parse(value);
  requireCondition(
    Number.isFinite(timestamp) && new Date(timestamp).toISOString().replace('.000Z', 'Z') === value,
    `${label} is invalid`,
  );
  return timestamp;
}

export function validateOperationalBaselineBinding(operationalBaselineUtc, frozenAtUtc) {
  parseCanonicalUtcSecond(operationalBaselineUtc, 'operational baseline');
  parseCanonicalUtcSecond(frozenAtUtc, 'source freeze timestamp');
  requireCondition(
    operationalBaselineUtc === frozenAtUtc,
    'operational baseline differs from the source freeze receipt',
  );
  return true;
}

export function encodeStorageObjectPath(bucket, name) {
  requireCondition(EXPECTED_BUCKETS.includes(bucket), 'bucket path is invalid');
  validateStorageObjectName(name);
  const segments = name.split('/');
  return [bucket, ...segments].map((segment) => encodeURIComponent(segment)).join('/');
}

export function validateStorageGrowthPolicy(policy, snapshotId) {
  requireCondition(policy.snapshotId === snapshotId, 'continuity policy snapshot differs');
  requireCondition(policy.sourceProjectRef === EXPECTED_SOURCE_REF, 'continuity policy source differs');
  requireCondition(policy.targetProjectRef === EXPECTED_TARGET_REF, 'continuity policy target differs');
  requireCondition(policy.schemaVersion === 12, 'continuity policy schema differs');
  requireCondition(policy.storage?.sourcePayloadsMustRemainAContentExactSubset === true, 'source payload subset guard is disabled');
  requireCondition(policy.guards?.sourceMustRemainFrozen === true, 'source freeze guard is disabled');
  requireCondition(policy.guards?.sourceDeletionForbidden === true, 'source deletion guard is disabled');
  requireCondition(policy.guards?.targetCronMustRemainDisabled === true, 'target cron guard is disabled');
  requireCondition(policy.guards?.targetJobsMustRemainDisabled === true, 'target job guard is disabled');
  requireCondition(policy.guards?.targetRewindForbidden === true, 'target rewind guard is disabled');

  const rootAnchorBucket = policy.storage?.rootAnchorBucket;
  const liveGrowthBuckets = sortedUniqueStrings(policy.storage?.allowedLiveGrowthBuckets, 'live Storage bucket allowlist');
  requireCondition(
    JSON.stringify(liveGrowthBuckets) === JSON.stringify(EXPECTED_LIVE_GROWTH_BUCKETS),
    'live Storage bucket allowlist differs',
  );
  requireCondition(rootAnchorBucket === 'rental-photos', 'root live Storage bucket differs');

  const operationalContinuity = policy.publicData?.operationalContinuity;
  requireCondition(
    operationalContinuity?.boundaryColumn === 'created_at',
    'operational continuity boundary column differs',
  );
  const operationalBaselineUtc = operationalContinuity?.operationalBaselineUtc;
  parseCanonicalUtcSecond(operationalBaselineUtc, 'operational baseline');

  const recordingContract = policy.storage?.recordingGrowthContract;
  requireCondition(recordingContract?.bucket === 'motorist-call-recordings', 'recording Storage bucket contract differs');
  requireCondition(recordingContract.provider === 'viptel', 'recording provider contract differs');
  requireCondition(recordingContract.requiredRecordingStatus === 'available', 'recording status contract differs');
  requireCondition(recordingContract.requiredCallStatus === 'ended', 'recording call status contract differs');
  for (const guard of [
    'requirePostSnapshotObject',
    'requireSizeMatch',
    'requireChecksumMatch',
    'requireAppendOnlyTransitionEvidence',
  ]) {
    requireCondition(recordingContract[guard] === true, `recording ${guard} guard is disabled`);
  }

  return {
    liveGrowthBuckets,
    operationalBaselineUtc,
    recordingContract,
    rootAnchorBucket,
  };
}

export function parsePrivatePathCatalog(text) {
  requireCondition(typeof text === 'string', 'path catalog is invalid');
  const paths = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
  requireCondition(paths.every((path) => path && !/[\r\0]/.test(path)), 'path catalog contains an invalid entry');
  const sorted = [...paths].sort(byteCompare);
  requireCondition(new Set(paths).size === paths.length, 'path catalog contains duplicates');
  requireCondition(sorted.every((path, index) => path === paths[index]), 'path catalog is not byte-sorted');
  return paths;
}

export function parseHashCatalog(text) {
  requireCondition(typeof text === 'string', 'content catalog is invalid');
  const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
  const entries = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    requireCondition(match && !/[\r\0]/.test(match[2]), 'content catalog contains an invalid entry');
    requireCondition(!entries.has(match[2]), 'content catalog contains duplicate paths');
    entries.set(match[2], match[1]);
  }
  return entries;
}

function parseKeyValueText(text) {
  const result = new Map();
  for (const line of text.split('\n')) {
    if (!line || !line.includes('=')) continue;
    const index = line.indexOf('=');
    result.set(line.slice(0, index), line.slice(index + 1));
  }
  return result;
}

function manifestDigest(manifest, fileName, section) {
  const sectionMarker = `${section}:`;
  const sectionStart = manifest.indexOf(sectionMarker);
  requireCondition(sectionStart >= 0, `snapshot manifest has no ${section} section`);
  const sectionText = manifest.slice(sectionStart + sectionMarker.length);
  const nextSection = sectionText.search(/^\S[^\n]*:\s*$/m);
  const scoped = nextSection >= 0 ? sectionText.slice(0, nextSection) : sectionText;
  const match = new RegExp(`^([0-9a-f]{64})  ${fileName.replaceAll('.', '\\.')}$`, 'm').exec(scoped);
  requireCondition(match, `snapshot manifest has no ${fileName} digest`);
  return match[1];
}

function readJsonSnapshot(path, label, { privateFile = true, trustedRoot }) {
  const snapshot = readSecureJsonSnapshot(path, { privateFile, trustedRoot });
  const { value } = snapshot;
  requireCondition(value && typeof value === 'object' && !Array.isArray(value), `${label} is not a JSON object`);
  return snapshot;
}

function resolveWatermarkEvidence(resolverPath, policyPath, continuityAnchorPath, watermarkPaths) {
  const resolution = spawnSync(process.execPath, [
    resolverPath,
    policyPath,
    continuityAnchorPath,
    ...watermarkPaths,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  requireCondition(resolution.status === 0, 'live watermark chain is invalid');
  const resolved = JSON.parse(resolution.stdout);
  requireCondition(resolve(resolved.currentPath) === resolve(watermarkPaths.at(-1)), 'current watermark path differs');
  for (const field of [
    'baseAnchorSha256',
    'currentSha256',
    'policySha256',
    'rootPolicySha256',
    'rootSha256',
    'transitionReceiptSha256',
  ]) {
    requireCondition(typeof resolved[field] === 'string' && /^[0-9a-f]{64}$/.test(resolved[field]), `resolved ${field} is invalid`);
  }
  return resolved;
}

function assertEvidenceStable(stability) {
  const currentResolution = resolveWatermarkEvidence(
    stability.resolverPath,
    stability.policyPath,
    stability.continuityAnchorPath,
    stability.watermarkPaths,
  );
  for (const field of [
    'baseAnchorSha256',
    'currentSha256',
    'policySha256',
    'rootPolicySha256',
    'rootSha256',
    'transitionReceiptSha256',
  ]) {
    requireCondition(currentResolution[field] === stability.resolution[field], 'continuity evidence changed during validation');
  }
  for (const binding of stability.fileBindings) {
    const snapshot = readSecureFileSnapshot(binding.path, {
      privateFile: binding.privateFile,
      trustedRoot: stability.trustedRoot,
    });
    requireCondition(snapshot.sha256 === binding.sha256, 'Storage continuity evidence changed during validation');
  }
}

function discoverEvidence(root, snapshotId, { captureTransition }) {
  const continuityRoot = join(root, '.context/migration/continuity');
  requirePrivateDirectory(continuityRoot, 'continuity directory');
  const names = readdirSync(continuityRoot);
  const anchorNames = names.filter((name) => name.startsWith(`anchor-${snapshotId}-`) && name.endsWith('.json'));
  const watermarkNames = names
    .filter((name) => name.startsWith(`live-watermark-${snapshotId}-`) && name.endsWith('.json'))
    .sort(byteCompare);
  const storageNames = names.filter((name) => name.startsWith(`live-storage-${snapshotId}-`));
  const storageTransitionNames = names
    .filter((name) => name.startsWith(`live-storage-transition-${snapshotId}-`))
    .sort(byteCompare);
  requireCondition(anchorNames.length === 1, 'expected exactly one continuity anchor');
  requireCondition(storageNames.length === 1, 'expected exactly one live Storage anchor');
  requireCondition(
    captureTransition ? storageTransitionNames.length === 0 : storageTransitionNames.length === 1,
    captureTransition
      ? 'a Storage transition already exists'
      : 'expected exactly one append-only Storage transition',
  );

  const policyPath = join(root, 'deploy/supabase/live-target-continuity-policy.json');
  const continuityAnchorPath = join(continuityRoot, anchorNames[0]);
  const watermarkPaths = watermarkNames.map((name) => join(continuityRoot, name));
  const storageAnchorDirectory = join(continuityRoot, storageNames[0]);
  const storageManifestPath = join(storageAnchorDirectory, 'manifest.json');
  const storageNamesPath = join(storageAnchorDirectory, 'target-only.txt');
  const storageContentPath = join(storageAnchorDirectory, 'target-only.sha256');
  requirePrivateFile(continuityAnchorPath, 'continuity anchor');
  requirePrivateDirectory(storageAnchorDirectory, 'live Storage anchor directory');
  for (const [path, label] of [
    [storageManifestPath, 'live Storage manifest'],
    [storageNamesPath, 'live Storage path catalog'],
    [storageContentPath, 'live Storage content catalog'],
  ]) {
    requirePrivateFile(path, label);
  }

  const resolverPath = join(root, 'deploy/bin/resolve-live-watermark-anchor.mjs');
  const resolvedWatermark = resolveWatermarkEvidence(
    resolverPath,
    policyPath,
    continuityAnchorPath,
    watermarkPaths,
  );

  const policySnapshot = readJsonSnapshot(policyPath, 'continuity policy', {
    privateFile: false,
    trustedRoot: root,
  });
  const policy = policySnapshot.value;
  const rootPolicyPath = join(root, 'deploy/supabase/live-target-continuity-policy-v1.json');
  const rootPolicySnapshot = readJsonSnapshot(rootPolicyPath, 'root continuity policy', {
    privateFile: false,
    trustedRoot: root,
  });
  const continuityAnchorSnapshot = readJsonSnapshot(continuityAnchorPath, 'continuity anchor', {
    trustedRoot: root,
  });
  const storageManifestSnapshot = readJsonSnapshot(storageManifestPath, 'live Storage manifest', {
    trustedRoot: root,
  });
  const storageNamesSnapshot = readSecureFileSnapshot(storageNamesPath, { privateFile: true, trustedRoot: root });
  const storageContentSnapshot = readSecureFileSnapshot(storageContentPath, { privateFile: true, trustedRoot: root });
  const currentWatermarkSnapshot = readSecureFileSnapshot(resolvedWatermark.currentPath, {
    privateFile: true,
    trustedRoot: root,
  });
  const rootPolicy = rootPolicySnapshot.value;
  const continuityAnchor = continuityAnchorSnapshot.value;
  const storageManifest = storageManifestSnapshot.value;
  const continuityPolicySha256 = policySnapshot.sha256;
  const continuityAnchorSha256 = continuityAnchorSnapshot.sha256;
  const watermarkAnchorSha256 = currentWatermarkSnapshot.sha256;

  requireCondition(continuityPolicySha256 === resolvedWatermark.policySha256, 'current continuity policy hash differs');
  requireCondition(continuityAnchorSha256 === resolvedWatermark.baseAnchorSha256, 'base continuity anchor hash differs');
  requireCondition(watermarkAnchorSha256 === resolvedWatermark.currentSha256, 'current watermark hash differs');

  const {
    liveGrowthBuckets,
    operationalBaselineUtc,
    recordingContract,
    rootAnchorBucket,
  } = validateStorageGrowthPolicy(policy, snapshotId);
  requireCondition(rootPolicySnapshot.sha256 === resolvedWatermark.rootPolicySha256, 'root continuity policy hash differs');
  requireCondition(
    rootPolicy.storage?.onlyLiveGrowthBucket === rootAnchorBucket,
    'root Storage anchor bucket differs from the immutable policy',
  );

  requireCondition(continuityAnchor.snapshotId === snapshotId, 'continuity anchor snapshot differs');
  requireCondition(continuityAnchor.sourceProjectRef === EXPECTED_SOURCE_REF, 'continuity anchor source differs');
  requireCondition(continuityAnchor.targetProjectRef === EXPECTED_TARGET_REF, 'continuity anchor target differs');
  requireCondition(continuityAnchor.sourceFrozen === true, 'continuity anchor does not freeze source');
  requireCondition(continuityAnchor.sourceDeletionForbidden === true, 'continuity anchor permits source deletion');
  requireCondition(
    typeof continuityAnchor.evidence?.snapshotManifestSha256 === 'string'
      && /^[0-9a-f]{64}$/.test(continuityAnchor.evidence.snapshotManifestSha256),
    'continuity anchor snapshot manifest hash is invalid',
  );
  requireCondition(
    continuityAnchor.evidence?.continuityPolicySha256 === resolvedWatermark.rootPolicySha256,
    'continuity anchor root policy hash differs',
  );

  requireCondition(storageManifest.schemaVersion === 1, 'live Storage manifest schema differs');
  requireCondition(storageManifest.snapshotId === snapshotId, 'live Storage manifest snapshot differs');
  requireCondition(storageManifest.sourceProjectRef === EXPECTED_SOURCE_REF, 'live Storage manifest source differs');
  requireCondition(storageManifest.targetProjectRef === EXPECTED_TARGET_REF, 'live Storage manifest target differs');
  requireCondition(storageManifest.continuityPolicySha256 === resolvedWatermark.rootPolicySha256, 'live Storage policy hash differs');
  requireCondition(storageManifest.baseContinuityAnchorSha256 === continuityAnchorSha256, 'live Storage base anchor hash differs');
  requireCondition(storageManifest.liveWatermarkAnchorSha256 === resolvedWatermark.rootSha256, 'live Storage watermark hash differs');
  requireCondition(storageManifest.targetOnlyNamesSha256 === storageNamesSnapshot.sha256, 'live Storage path hash differs');
  requireCondition(storageManifest.targetOnlyContentCatalogSha256 === storageContentSnapshot.sha256, 'live Storage content hash differs');
  requireCondition(storageManifest.sourceBaselineContentVerified === true, 'source baseline content was not verified');

  const anchoredNames = parsePrivatePathCatalog(storageNamesSnapshot.contents.toString('utf8'));
  const anchoredHashes = parseHashCatalog(storageContentSnapshot.contents.toString('utf8'));
  requireCondition(storageManifest.targetOnlyPayloadCount === anchoredNames.length, 'anchored target-only count differs');
  requireCondition(anchoredHashes.size === anchoredNames.length, 'anchored content count differs');
  requireCondition(
    anchoredNames.every((name) => anchoredHashes.has(name)),
    'anchored path and content catalogs differ',
  );

  let storageTransition = null;
  const fileBindings = [
    { path: storageManifestPath, privateFile: true, sha256: storageManifestSnapshot.sha256 },
    { path: storageNamesPath, privateFile: true, sha256: storageNamesSnapshot.sha256 },
    { path: storageContentPath, privateFile: true, sha256: storageContentSnapshot.sha256 },
  ];
  if (!captureTransition) {
    const directory = join(continuityRoot, storageTransitionNames[0]);
    const manifestPath = join(directory, 'manifest.json');
    const catalogPath = join(directory, 'catalog.jsonl');
    requirePrivateDirectory(directory, 'Storage transition directory');
    requirePrivateFile(manifestPath, 'Storage transition manifest');
    requirePrivateFile(catalogPath, 'Storage transition catalog');
    const manifestSnapshot = readJsonSnapshot(manifestPath, 'Storage transition manifest', { trustedRoot: root });
    const catalogSnapshot = readSecureFileSnapshot(catalogPath, { privateFile: true, trustedRoot: root });
    const manifest = manifestSnapshot.value;
    const catalog = catalogSnapshot.contents;
    validateStorageTransitionManifest(manifest, {
      snapshotId,
      sourceProjectRef: EXPECTED_SOURCE_REF,
      targetProjectRef: EXPECTED_TARGET_REF,
      currentPolicySha256: continuityPolicySha256,
      currentWatermarkSha256: watermarkAnchorSha256,
      rootStorageManifestSha256: storageManifestSnapshot.sha256,
      allowedBuckets: liveGrowthBuckets,
      catalog,
    });
    storageTransition = {
      catalog: parseStorageTransitionCatalog(catalog, { allowedBuckets: liveGrowthBuckets }),
      manifestSha256: manifestSnapshot.sha256,
    };
    fileBindings.push(
      { path: manifestPath, privateFile: true, sha256: manifestSnapshot.sha256 },
      { path: catalogPath, privateFile: true, sha256: catalogSnapshot.sha256 },
    );
  }

  return {
    anchoredHashes,
    anchoredNames,
    continuityAnchorSha256,
    continuityPolicySha256,
    liveGrowthBuckets,
    operationalBaselineUtc,
    recordingContract,
    rootAnchorBucket,
    snapshotManifestSha256: continuityAnchor.evidence.snapshotManifestSha256,
    snapshotCutoffUtc: policy.snapshotCutoffUtc,
    stability: {
      continuityAnchorPath,
      fileBindings,
      policyPath,
      resolution: resolvedWatermark,
      resolverPath,
      trustedRoot: root,
      watermarkPaths,
    },
    storageAnchorSha256: storageManifestSnapshot.sha256,
    storageTransition,
    watermarkAnchorSha256,
  };
}

function readSnapshotBaseline(
  root,
  snapshotId,
  archivePassphrase,
  expectedManifestSha256,
  expectedOperationalBaselineUtc,
) {
  const snapshotDirectory = join(root, '.context/migration/snapshots', snapshotId);
  const manifestPath = join(snapshotDirectory, 'MANIFEST');
  const inventoryPath = join(snapshotDirectory, 'inventory.tsv.enc');
  const freezePath = join(root, '.context/migration/source-freeze', `${snapshotId}.env`);
  for (const [path, label] of [
    [manifestPath, 'snapshot manifest'],
    [inventoryPath, 'encrypted snapshot inventory'],
    [freezePath, 'source freeze receipt'],
  ]) {
    requirePrivateFile(path, label);
  }

  const manifestSnapshot = readSecureFileSnapshot(manifestPath, { privateFile: true, trustedRoot: root });
  const inventorySnapshot = readSecureFileSnapshot(inventoryPath, { privateFile: true, trustedRoot: root });
  const freezeSnapshot = readSecureFileSnapshot(freezePath, { privateFile: true, trustedRoot: root });
  const manifest = manifestSnapshot.contents.toString('utf8');
  requireCondition(manifestSnapshot.sha256 === expectedManifestSha256, 'snapshot manifest differs from the continuity anchor');
  const manifestValues = parseKeyValueText(manifest);
  const freezeValues = parseKeyValueText(freezeSnapshot.contents.toString('utf8'));
  requireCondition(manifestValues.get('source_project_ref') === EXPECTED_SOURCE_REF, 'snapshot source differs');
  requireCondition(manifestValues.get('snapshot_id') === snapshotId, 'snapshot ID differs');
  requireCondition(freezeValues.get('state') === 'frozen', 'source freeze receipt is not frozen');
  requireCondition(freezeValues.get('snapshot_id') === snapshotId, 'source freeze snapshot differs');
  requireCondition(freezeValues.get('source_project_ref') === EXPECTED_SOURCE_REF, 'source freeze project differs');
  requireCondition(freezeValues.get('target_project_ref') === EXPECTED_TARGET_REF, 'source freeze target differs');
  requireCondition(freezeValues.get('source_restart_verified') === 'true', 'source freeze restart is unverified');
  requireCondition(freezeValues.get('external_writers_attested_stopped') === 'true', 'source external writers are not stopped');
  validateOperationalBaselineBinding(
    expectedOperationalBaselineUtc,
    freezeValues.get('frozen_at_utc'),
  );
  requireCondition(
    manifestValues.get('source_freeze_receipt_sha256') === freezeSnapshot.sha256,
    'source freeze receipt changed after the snapshot',
  );
  requireCondition(
    manifestDigest(manifest, 'inventory.tsv.enc', 'encrypted_sha256') === inventorySnapshot.sha256,
    'encrypted snapshot inventory digest differs',
  );

  const decryption = spawnSync('openssl', [
    'enc',
    '-d',
    '-aes-256-cbc',
    '-pbkdf2',
    '-iter',
    '200000',
    '-pass',
    'env:MIGRATION_ARCHIVE_PASSPHRASE',
  ], {
    env: { ...process.env, MIGRATION_ARCHIVE_PASSPHRASE: archivePassphrase },
    encoding: null,
    input: inventorySnapshot.contents,
    maxBuffer: 16 * 1024 * 1024,
  });
  requireCondition(decryption.status === 0 && Buffer.isBuffer(decryption.stdout), 'snapshot inventory decryption failed');
  const expectedPlaintextDigest = manifestDigest(manifest, 'inventory.tsv', 'plaintext_sha256');
  requireCondition(sha256(decryption.stdout) === expectedPlaintextDigest, 'snapshot inventory plaintext digest differs');
  const inventory = decryption.stdout.toString('utf8');
  decryption.stdout.fill(0);
  const storageLines = inventory.split('\n').filter((line) => line.startsWith('storage_buckets='));
  requireCondition(storageLines.length === 1, 'snapshot Storage baseline is missing');
  const baseline = JSON.parse(storageLines[0].slice('storage_buckets='.length));
  requireCondition(baseline && typeof baseline === 'object' && !Array.isArray(baseline), 'snapshot Storage baseline is invalid');
  requireCondition(JSON.stringify(Object.keys(baseline).sort(byteCompare)) === JSON.stringify(EXPECTED_BUCKETS), 'snapshot bucket set differs');
  for (const bucket of EXPECTED_BUCKETS) {
    requireCondition(baseline[bucket] && typeof baseline[bucket] === 'object', 'snapshot bucket baseline is invalid');
    baseline[bucket] = {
      bytes: safeInteger(baseline[bucket].bytes, 'snapshot byte count'),
      objects: safeInteger(baseline[bucket].objects, 'snapshot object count'),
      public: baseline[bucket].public,
    };
    requireCondition(typeof baseline[bucket].public === 'boolean', 'snapshot bucket visibility is invalid');
  }
  return {
    baseline,
    fileBindings: [
      { path: manifestPath, privateFile: true, sha256: manifestSnapshot.sha256 },
      { path: inventoryPath, privateFile: true, sha256: inventorySnapshot.sha256 },
      { path: freezePath, privateFile: true, sha256: freezeSnapshot.sha256 },
    ],
  };
}

async function managementRequest(ref, token, path, options = {}) {
  let response;
  try {
    response = await fetch(`https://api.supabase.com/v1/projects/${ref}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers ?? {}),
      },
      signal: AbortSignal.timeout(120_000),
      redirect: 'error',
    });
  } catch {
    fail('Supabase Management API request failed');
  }
  const body = await response.json().catch(() => null);
  requireCondition(response.ok, `Supabase Management API returned HTTP ${response.status}`);
  return body;
}

async function readOnlyQuery(ref, token, query) {
  const rows = await managementRequest(ref, token, '/database/query', {
    method: 'POST',
    body: JSON.stringify({ query, read_only: true }),
  });
  requireCondition(Array.isArray(rows), 'Supabase read-only query returned invalid data');
  return rows;
}

async function validateDatabaseState(ref, token, source) {
  const rows = await readOnlyQuery(ref, token, `select
    exists (
      select 1
      from pg_catalog.pg_db_role_setting as settings
      join pg_catalog.pg_database as databases
        on databases.oid = settings.setdatabase
      where databases.datname = pg_catalog.current_database()
        and settings.setrole = 0
        and 'default_transaction_read_only=on' = any(settings.setconfig)
    ) as database_default_read_only,
    case when pg_catalog.to_regclass('cron.job') is null then 0
      else (select pg_catalog.count(*) from cron.job where active)
    end as active_cron_jobs,
    (select pg_catalog.count(*) from public.motorist_job_controls where enabled) as enabled_job_controls;`);
  requireCondition(rows.length === 1, 'database state response is invalid');
  requireCondition(safeInteger(rows[0].active_cron_jobs, 'active cron count') === 0, 'database has active cron jobs');
  requireCondition(safeInteger(rows[0].enabled_job_controls, 'enabled job-control count') === 0, 'database has enabled job controls');
  requireCondition(
    rows[0].database_default_read_only === source,
    source ? 'source database is not persistently read-only' : 'target database has a persistent read-only default',
  );
}

async function readServiceKey(ref, token) {
  const keys = await managementRequest(ref, token, '/api-keys?reveal=true');
  requireCondition(Array.isArray(keys), 'Supabase API key response is invalid');
  const matches = keys.filter((key) => key?.type === 'legacy' && key?.name === 'service_role');
  requireCondition(matches.length === 1, 'expected exactly one legacy service role key');
  requireCondition(typeof matches[0].api_key === 'string' && matches[0].api_key.length > 100, 'service role key is invalid');
  return matches[0].api_key;
}

async function readBuckets(ref, token) {
  const rows = await readOnlyQuery(ref, token, 'select id, public from storage.buckets order by id collate "C";');
  return rows.map((row) => {
    requireCondition(typeof row.id === 'string' && EXPECTED_BUCKETS.includes(row.id), 'database contains an unexpected Storage bucket');
    requireCondition(typeof row.public === 'boolean', 'Storage bucket visibility is invalid');
    return { id: row.id, public: row.public };
  });
}

function normalizeObject(row) {
  requireCondition(typeof row.bucket_id === 'string' && EXPECTED_BUCKETS.includes(row.bucket_id), 'Storage object bucket is invalid');
  requireCondition(typeof row.name === 'string' && row.name.length > 0 && !/[\r\n\0]/.test(row.name), 'Storage object path is invalid');
  requireCondition(typeof row.created_at === 'string' && typeof row.updated_at === 'string', 'Storage object timestamp is invalid');
  requireCondition(typeof row.version === 'string' && row.version.length > 0, 'Storage object version is invalid');
  requireCondition(typeof row.metadata_text === 'string' && row.metadata_text.length > 0, 'Storage object metadata is invalid');
  const createdAt = Date.parse(row.created_at);
  const updatedAt = Date.parse(row.updated_at);
  requireCondition(Number.isFinite(createdAt) && Number.isFinite(updatedAt), 'Storage object timestamp is invalid');
  return {
    bucket: row.bucket_id,
    createdAt,
    createdAtRaw: row.created_at,
    metadataText: row.metadata_text,
    name: row.name,
    size: safeInteger(row.size, 'Storage object size'),
    updatedAt,
    updatedAtRaw: row.updated_at,
    version: row.version,
  };
}

async function readObjects(ref, token) {
  const rows = await readOnlyQuery(ref, token, `select
    bucket_id,
    name,
    (metadata ->> 'size')::bigint as size,
    metadata::text as metadata_text,
    version::text as version,
    created_at,
    updated_at
  from storage.objects
  order by bucket_id collate "C", name collate "C";`);
  const objects = rows.map(normalizeObject);
  const keys = new Set(objects.map((object) => objectKey(object)));
  requireCondition(keys.size === objects.length, 'Storage object catalog contains duplicate paths');
  return objects;
}

function normalizeRecordingEvidence(row) {
  requireCondition(row.storage_bucket === 'motorist-call-recordings', 'recording Storage bucket evidence differs');
  requireCondition(
    typeof row.storage_path === 'string' && row.storage_path.length > 0 && !/[\r\n\0]/.test(row.storage_path),
    'recording Storage path evidence is invalid',
  );
  requireCondition(typeof row.status === 'string', 'recording status evidence is invalid');
  requireCondition(typeof row.provider === 'string', 'recording provider evidence is invalid');
  requireCondition(typeof row.checksum === 'string', 'recording checksum evidence is invalid');
  requireCondition(row.size_bytes !== null && row.size_bytes !== undefined, 'recording payload size evidence is invalid');
  requireCondition(typeof row.recording_created_at === 'string', 'recording creation evidence is invalid');
  requireCondition(typeof row.fetched_at === 'string', 'recording fetch evidence is invalid');
  requireCondition(typeof row.call_status === 'string', 'recording call evidence is invalid');
  const recordingCreatedAt = Date.parse(row.recording_created_at);
  const fetchedAt = Date.parse(row.fetched_at);
  requireCondition(Number.isFinite(recordingCreatedAt) && Number.isFinite(fetchedAt), 'recording timestamp evidence is invalid');
  return {
    callStatus: row.call_status,
    checksum: row.checksum,
    fetchedAt,
    hasCall: row.has_call === true,
    path: row.storage_path,
    provider: row.provider,
    recordingCreatedAt,
    size: safeInteger(row.size_bytes, 'recording payload size'),
    status: row.status,
  };
}

async function readRecordingEvidence(ref, token, operationalBaselineUtc) {
  parseCanonicalUtcSecond(operationalBaselineUtc, 'recording evidence baseline');
  const rows = await readOnlyQuery(ref, token, `select
    recordings.storage_bucket,
    recordings.storage_path,
    recordings.status,
    recordings.provider,
    recordings.size_bytes,
    recordings.checksum,
    recordings.created_at as recording_created_at,
    recordings.fetched_at,
    recordings.call_id is not null as has_call,
    calls.status as call_status
  from public.motorist_call_recordings as recordings
  left join public.motorist_calls as calls
    on calls.id = recordings.call_id
   and calls.organization_id = recordings.organization_id
  where recordings.created_at > '${operationalBaselineUtc}'::timestamptz
  order by recordings.storage_path collate "C";`);
  const normalized = rows.map(normalizeRecordingEvidence);
  requireCondition(new Set(normalized.map((row) => row.path)).size === normalized.length, 'recording Storage path evidence is duplicated');
  return normalized;
}

function recordingEvidenceDigest(rows) {
  return sha256(JSON.stringify(rows.map((row) => [
    row.path,
    row.status,
    row.provider,
    row.size,
    row.checksum,
    row.recordingCreatedAt,
    row.fetchedAt,
    row.hasCall,
    row.callStatus,
  ])));
}

export function validateRecordingGrowth({
  targetOnly,
  targetPayloadHashes,
  recordingEvidence,
  recordingContract,
  operationalBaselineUtc,
  snapshotCutoffUtc,
}) {
  const cutoff = Date.parse(snapshotCutoffUtc);
  requireCondition(Number.isFinite(cutoff), 'recording contract cutoff is invalid');
  const operationalBaseline = parseCanonicalUtcSecond(
    operationalBaselineUtc,
    'recording operational baseline',
  );
  requireCondition(operationalBaseline >= cutoff, 'recording operational baseline predates the snapshot cutoff');

  const recordingObjects = targetOnly.filter((object) => object.bucket === recordingContract.bucket);
  const recordingObjectsByPath = new Map(recordingObjects.map((object) => [object.name, object]));
  requireCondition(
    recordingObjectsByPath.size === recordingObjects.length,
    'target-only recording Storage path is duplicated',
  );

  for (const row of recordingEvidence) {
    requireCondition(Number.isFinite(row.recordingCreatedAt), 'recording creation evidence is invalid');
  }
  const liveRecordingEvidence = recordingEvidence.filter(
    (row) => row.recordingCreatedAt > operationalBaseline,
  );
  const evidenceByPath = new Map(liveRecordingEvidence.map((row) => [row.path, row]));
  requireCondition(
    evidenceByPath.size === liveRecordingEvidence.length,
    'post-baseline recording database path is duplicated',
  );

  for (const object of recordingObjects) {
    const row = evidenceByPath.get(object.name);
    requireCondition(row, 'target-only recording has no database evidence');
  }
  for (const row of liveRecordingEvidence) {
    requireCondition(
      recordingObjectsByPath.has(row.path),
      'post-baseline recording database evidence has no target-only Storage object',
    );
  }
  requireCondition(
    recordingObjects.length === liveRecordingEvidence.length,
    'post-baseline recording database and Storage counts differ',
  );

  for (const object of recordingObjects) {
    const row = evidenceByPath.get(object.name);
    requireCondition(
      row.recordingCreatedAt > operationalBaseline,
      'target-only recording database evidence predates the operational baseline',
    );
    requireCondition(row.status === recordingContract.requiredRecordingStatus, 'target-only recording is not available');
    requireCondition(row.provider === recordingContract.provider, 'target-only recording provider differs');
    requireCondition(row.hasCall && row.callStatus === recordingContract.requiredCallStatus, 'target-only recording has no ended call');
    requireCondition(object.createdAt > cutoff && row.fetchedAt > cutoff, 'target-only recording predates the approved live window');
    requireCondition(row.size === object.size, 'target-only recording size differs from database evidence');
    requireCondition(/^[0-9a-f]{64}$/.test(row.checksum), 'target-only recording checksum evidence is invalid');
    requireCondition(
      row.checksum === targetPayloadHashes.get(objectKey(object)),
      'target-only recording payload differs from database checksum evidence',
    );
  }
  return true;
}

function objectKey(object) {
  return JSON.stringify([object.bucket, object.name]);
}

function objectCatalogDigest(objects) {
  const values = [...objects]
    .sort((left, right) => byteCompare(objectKey(left), objectKey(right)))
    .map((object) => [
      object.bucket,
      object.name,
      object.size,
      object.createdAtRaw,
      object.updatedAtRaw,
      object.version,
      object.metadataText,
    ]);
  return sha256(JSON.stringify(values));
}

export function evaluateCatalogContract({
  sourceObjects,
  targetObjects,
  liveGrowthBuckets,
  rootAnchorBucket,
  snapshotCutoffUtc,
  anchoredNames,
}) {
  const allowedGrowth = new Set(liveGrowthBuckets);
  const sourceByKey = new Map(sourceObjects.map((object) => [objectKey(object), object]));
  const targetByKey = new Map(targetObjects.map((object) => [objectKey(object), object]));
  for (const key of sourceByKey.keys()) {
    requireCondition(targetByKey.has(key), 'target is missing a source Storage object');
  }
  const targetOnly = targetObjects.filter((object) => !sourceByKey.has(objectKey(object)));
  requireCondition(targetOnly.every((object) => allowedGrowth.has(object.bucket)), 'target has growth outside the approved live buckets');
  const targetOnlyKeys = new Set(targetOnly.map(objectKey));
  const cutoff = Date.parse(snapshotCutoffUtc);
  requireCondition(Number.isFinite(cutoff), 'snapshot cutoff is invalid');
  const databaseLiveKeys = new Set(
    targetObjects
      .filter((object) => allowedGrowth.has(object.bucket) && object.createdAt > cutoff)
      .map(objectKey),
  );
  const targetOnlyKeysetMatchesDatabase = sameStringSet(targetOnlyKeys, databaseLiveKeys);
  requireCondition(targetOnlyKeysetMatchesDatabase, 'target-only Storage keyset differs from live database metadata');
  const rootTargetOnlyNames = new Set(
    targetOnly.filter((object) => object.bucket === rootAnchorBucket).map((object) => object.name),
  );
  requireCondition(
    anchoredNames.every((name) => rootTargetOnlyNames.has(name)),
    'an anchored root-bucket Storage object is missing',
  );
  return { targetByKey, targetOnly, targetOnlyKeysetMatchesDatabase };
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function hashStorageObject(ref, serviceKey, object, side) {
  const path = encodeStorageObjectPath(object.bucket, object.name);
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(`https://${ref}.supabase.co/storage/v1/object/authenticated/${path}`, {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      if (attempt < DOWNLOAD_ATTEMPTS) {
        await sleep(250 * (2 ** (attempt - 1)));
        continue;
      }
      fail(`${side} Storage REST download failed after retries`);
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      if (attempt < DOWNLOAD_ATTEMPTS) {
        await sleep(250 * (2 ** (attempt - 1)));
        continue;
      }
    }
    requireCondition(response.ok && response.body, `${side} Storage REST returned HTTP ${response.status}`);
    const digest = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes = safeAdd(bytes, chunk.byteLength, `${side} streamed byte count`);
        digest.update(chunk);
      }
    } catch {
      if (attempt < DOWNLOAD_ATTEMPTS) {
        await sleep(250 * (2 ** (attempt - 1)));
        continue;
      }
      fail(`${side} Storage REST stream failed after retries`);
    }
    return { bytes, sha256: digest.digest('hex') };
  }
  fail(`${side} Storage REST download did not complete`);
}

async function runPool(items, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function emptyTotals() {
  return Object.fromEntries(EXPECTED_BUCKETS.map((bucket) => [bucket, { bytes: 0, count: 0 }]));
}

function addToTotals(totals, bucket, bytes) {
  totals[bucket].count += 1;
  totals[bucket].bytes = safeAdd(totals[bucket].bytes, bytes, 'bucket byte count');
}

function requireBucketContract(rows, baseline, side) {
  const map = new Map(rows.map((row) => [row.id, row.public]));
  requireCondition(map.size === EXPECTED_BUCKETS.length, `${side} Storage bucket count differs`);
  for (const bucket of EXPECTED_BUCKETS) {
    requireCondition(map.has(bucket), `${side} Storage bucket set differs`);
    requireCondition(map.get(bucket) === baseline[bucket].public, `${side} Storage bucket visibility differs`);
  }
}

export function evaluateBucketReports({
  baseline,
  sourceTotals,
  targetTotals,
  liveGrowthBuckets,
  rootAnchorBucket,
  recordingBucket,
  targetOnlyCounts,
  targetOnlyKeysetMatchesDatabase,
  anchoredLiveContentMatches,
  transitionAnchoredContentMatches,
  recordingMetadataContractMatches,
}) {
  const allowedGrowth = new Set(liveGrowthBuckets);
  const buckets = {};
  let status = 'pass';
  for (const bucket of EXPECTED_BUCKETS) {
    const liveGrowthAllowed = allowedGrowth.has(bucket);
    const targetExtraCount = targetTotals[bucket].count - sourceTotals[bucket].count;
    const targetExtraBytes = targetTotals[bucket].bytes - sourceTotals[bucket].bytes;
    const bucketAnchorMatches = bucket === rootAnchorBucket
      ? anchoredLiveContentMatches
      : bucket === recordingBucket
        ? transitionAnchoredContentMatches
        : true;
    const bucketSemanticContractMatches = bucket === recordingBucket
      ? recordingMetadataContractMatches
      : true;
    const baselineValue = { count: baseline[bucket].objects, bytes: baseline[bucket].bytes };
    const baselineMatches = baselineValue.count === sourceTotals[bucket].count
      && baselineValue.bytes === sourceTotals[bucket].bytes;
    const targetMatches = liveGrowthAllowed
      ? targetTotals[bucket].count >= sourceTotals[bucket].count
        && targetTotals[bucket].bytes >= sourceTotals[bucket].bytes
        && targetExtraCount === (targetOnlyCounts[bucket] ?? 0)
        && targetOnlyKeysetMatchesDatabase
        && bucketAnchorMatches
        && bucketSemanticContractMatches
      : targetTotals[bucket].count === sourceTotals[bucket].count
        && targetTotals[bucket].bytes === sourceTotals[bucket].bytes
        && targetExtraCount === 0
        && targetExtraBytes === 0;
    const matches = baselineMatches && targetMatches;
    if (!matches) status = 'fail';
    buckets[bucket] = {
      baseline: baselineValue,
      source: sourceTotals[bucket],
      target: targetTotals[bucket],
      target_extra_count: targetExtraCount,
      target_extra_bytes: targetExtraBytes,
      live_growth_allowed: liveGrowthAllowed,
      target_only_keyset_matches_database: liveGrowthAllowed ? targetOnlyKeysetMatchesDatabase : null,
      anchored_live_content_matches: liveGrowthAllowed ? bucketAnchorMatches : null,
      recording_metadata_contract_matches: bucket === recordingBucket ? bucketSemanticContractMatches : null,
      matches,
    };
  }
  return { buckets, status };
}

function writePrivateJson(path, value) {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  requirePrivateDirectory(parent, 'Storage validation report directory');
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function writeExclusivePrivateFile(path, value) {
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, value);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function captureStorageTransition({
  root,
  snapshotId,
  evidence,
  targetOnly,
  targetPayloadHashes,
  recordingMetadataContractMatches,
}) {
  const catalogEntries = targetOnly.map((object) => ({
    bucket: object.bucket,
    name: object.name,
    size: object.size,
    sha256: targetPayloadHashes.get(objectKey(object)),
  }));
  requireCondition(
    catalogEntries.some((entry) => entry.bucket === evidence.recordingContract.bucket),
    'Storage transition has no reviewed recording growth',
  );
  const capturedAtUtc = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const catalog = serializeStorageTransitionCatalog(catalogEntries, {
    allowedBuckets: evidence.liveGrowthBuckets,
  });
  const manifest = buildStorageTransitionManifest({
    snapshotId,
    sourceProjectRef: EXPECTED_SOURCE_REF,
    targetProjectRef: EXPECTED_TARGET_REF,
    currentPolicySha256: evidence.continuityPolicySha256,
    currentWatermarkSha256: evidence.watermarkAnchorSha256,
    rootStorageManifestSha256: evidence.storageAnchorSha256,
    allowedBuckets: evidence.liveGrowthBuckets,
    capturedAtUtc,
    catalogEntries,
    sourceExactSubset: true,
    recordingContractVerified: recordingMetadataContractMatches,
  });
  validateStorageTransitionManifest(manifest, {
    snapshotId,
    sourceProjectRef: EXPECTED_SOURCE_REF,
    targetProjectRef: EXPECTED_TARGET_REF,
    currentPolicySha256: evidence.continuityPolicySha256,
    currentWatermarkSha256: evidence.watermarkAnchorSha256,
    rootStorageManifestSha256: evidence.storageAnchorSha256,
    allowedBuckets: evidence.liveGrowthBuckets,
    catalog,
    capturedAtUtc,
  });

  const continuityRoot = join(root, '.context/migration/continuity');
  requirePrivateDirectory(continuityRoot, 'continuity directory');
  const captureId = capturedAtUtc.replaceAll('-', '').replaceAll(':', '');
  const destination = join(continuityRoot, `live-storage-transition-${snapshotId}-${captureId}`);
  const temporary = join(continuityRoot, `.live-storage-transition-${process.pid}-${Date.now()}`);
  requireCondition(!existsSync(destination) && !existsSync(temporary), 'Storage transition destination already exists');
  mkdirSync(temporary, { mode: 0o700 });
  try {
    writeExclusivePrivateFile(join(temporary, 'catalog.jsonl'), catalog);
    writeExclusivePrivateFile(join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  const manifestPath = join(destination, 'manifest.json');
  const catalogPath = join(destination, 'catalog.jsonl');
  const manifestSnapshot = readSecureFileSnapshot(manifestPath, { privateFile: true, trustedRoot: root });
  const catalogSnapshot = readSecureFileSnapshot(catalogPath, { privateFile: true, trustedRoot: root });
  return {
    fileBindings: [
      { path: manifestPath, privateFile: true, sha256: manifestSnapshot.sha256 },
      { path: catalogPath, privateFile: true, sha256: catalogSnapshot.sha256 },
    ],
    manifestSha256: manifestSnapshot.sha256,
  };
}

async function main(argv) {
  requireCondition(
    (argv.length === 1 || (argv.length === 2 && argv[1] === '--capture-transition'))
      && /^\d{8}T\d{6}Z$/.test(argv[0]),
    'usage: validate-storage-rest.mjs SNAPSHOT_ID [--capture-transition]',
  );
  const [snapshotId] = argv;
  const captureTransition = argv[1] === '--capture-transition';
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const sourceRef = process.env.STORAGE_VALIDATOR_SOURCE_REF;
  const targetRef = process.env.STORAGE_VALIDATOR_TARGET_REF;
  const sourceToken = process.env.STORAGE_VALIDATOR_SOURCE_PAT;
  const targetToken = process.env.STORAGE_VALIDATOR_TARGET_PAT;
  const archivePassphrase = process.env.MIGRATION_ARCHIVE_PASSPHRASE;
  delete process.env.STORAGE_VALIDATOR_SOURCE_PAT;
  delete process.env.STORAGE_VALIDATOR_TARGET_PAT;
  delete process.env.MIGRATION_ARCHIVE_PASSPHRASE;
  requireCondition(sourceRef === EXPECTED_SOURCE_REF, 'source project ref differs');
  requireCondition(targetRef === EXPECTED_TARGET_REF, 'target project ref differs');
  requireCondition(typeof sourceToken === 'string' && sourceToken.length > 20, 'source Management API token is missing');
  requireCondition(typeof targetToken === 'string' && targetToken.length > 20, 'target Management API token is missing');
  requireCondition(typeof archivePassphrase === 'string' && archivePassphrase.length > 0, 'snapshot archive passphrase is missing');

  const evidence = discoverEvidence(root, snapshotId, { captureTransition });
  const baselineEvidence = readSnapshotBaseline(
    root,
    snapshotId,
    archivePassphrase,
    evidence.snapshotManifestSha256,
    evidence.operationalBaselineUtc,
  );
  const { baseline } = baselineEvidence;
  evidence.stability.fileBindings.push(...baselineEvidence.fileBindings);
  await Promise.all([
    validateDatabaseState(EXPECTED_SOURCE_REF, sourceToken, true),
    validateDatabaseState(EXPECTED_TARGET_REF, targetToken, false),
  ]);
  const [
    sourceServiceKey,
    targetServiceKey,
    sourceBuckets,
    targetBuckets,
    sourceObjects,
    targetObjects,
    recordingEvidence,
  ] = await Promise.all([
    readServiceKey(EXPECTED_SOURCE_REF, sourceToken),
    readServiceKey(EXPECTED_TARGET_REF, targetToken),
    readBuckets(EXPECTED_SOURCE_REF, sourceToken),
    readBuckets(EXPECTED_TARGET_REF, targetToken),
    readObjects(EXPECTED_SOURCE_REF, sourceToken),
    readObjects(EXPECTED_TARGET_REF, targetToken),
    readRecordingEvidence(EXPECTED_TARGET_REF, targetToken, evidence.operationalBaselineUtc),
  ]);
  requireBucketContract(sourceBuckets, baseline, 'source');
  requireBucketContract(targetBuckets, baseline, 'target');

  const {
    targetByKey,
    targetOnly,
    targetOnlyKeysetMatchesDatabase,
  } = evaluateCatalogContract({
    sourceObjects,
    targetObjects,
    liveGrowthBuckets: evidence.liveGrowthBuckets,
    rootAnchorBucket: evidence.rootAnchorBucket,
    snapshotCutoffUtc: evidence.snapshotCutoffUtc,
    anchoredNames: evidence.anchoredNames,
  });

  const sourceTotals = emptyTotals();
  const targetTotals = emptyTotals();
  const targetPayloadHashes = new Map();
  let validatedPayloads = 0;
  const initialPayloadChecks = sourceObjects.length + targetObjects.length;
  const totalPayloadChecks = initialPayloadChecks + targetObjects.length;
  process.stdout.write(`Overujem ${totalPayloadChecks} read-only Storage payloadov bez vypisovania názvov...\n`);
  await runPool(sourceObjects, async (sourceObject) => {
    const targetObject = targetByKey.get(objectKey(sourceObject));
    const sourcePayload = await hashStorageObject(EXPECTED_SOURCE_REF, sourceServiceKey, sourceObject, 'source');
    const targetPayload = await hashStorageObject(EXPECTED_TARGET_REF, targetServiceKey, targetObject, 'target');
    requireCondition(sourcePayload.bytes === sourceObject.size, 'source Storage payload size differs from metadata');
    requireCondition(targetPayload.bytes === targetObject.size, 'target Storage payload size differs from metadata');
    requireCondition(sourcePayload.bytes === targetPayload.bytes, 'source and target Storage payload sizes differ');
    requireCondition(sourcePayload.sha256 === targetPayload.sha256, 'source and target Storage payload hashes differ');
    targetPayloadHashes.set(objectKey(targetObject), targetPayload.sha256);
    addToTotals(sourceTotals, sourceObject.bucket, sourcePayload.bytes);
    addToTotals(targetTotals, targetObject.bucket, targetPayload.bytes);
    validatedPayloads += 2;
    if (validatedPayloads % 250 === 0) process.stdout.write(`Storage payload progress: ${validatedPayloads}/${totalPayloadChecks}\n`);
  });

  let anchoredLiveContentMatches = true;
  await runPool(targetOnly, async (targetObject) => {
    const payload = await hashStorageObject(EXPECTED_TARGET_REF, targetServiceKey, targetObject, 'target');
    requireCondition(payload.bytes === targetObject.size, 'target-only Storage payload size differs from metadata');
    addToTotals(targetTotals, targetObject.bucket, payload.bytes);
    const anchoredHash = targetObject.bucket === evidence.rootAnchorBucket
      ? evidence.anchoredHashes.get(targetObject.name)
      : undefined;
    if (anchoredHash && anchoredHash !== payload.sha256) anchoredLiveContentMatches = false;
    targetPayloadHashes.set(objectKey(targetObject), payload.sha256);
    validatedPayloads += 1;
    if (validatedPayloads % 250 === 0) process.stdout.write(`Storage payload progress: ${validatedPayloads}/${totalPayloadChecks}\n`);
  });
  requireCondition(anchoredLiveContentMatches, 'anchored live Storage content differs');
  const recordingMetadataContractMatches = validateRecordingGrowth({
    targetOnly,
    targetPayloadHashes,
    recordingEvidence,
    recordingContract: evidence.recordingContract,
    operationalBaselineUtc: evidence.operationalBaselineUtc,
    snapshotCutoffUtc: evidence.snapshotCutoffUtc,
  });
  const currentTransitionCatalog = targetOnly.map((object) => ({
    bucket: object.bucket,
    name: object.name,
    size: object.size,
    sha256: targetPayloadHashes.get(objectKey(object)),
  }));
  const transitionAnchoredContentMatches = captureTransition
    ? true
    : verifyCurrentStorageCatalogContainsAnchored({
      anchoredCatalog: evidence.storageTransition.catalog,
      currentCatalog: currentTransitionCatalog,
      allowedBuckets: evidence.liveGrowthBuckets,
    }).verified;
  requireCondition(validatedPayloads === initialPayloadChecks, 'Storage payload validation count differs');

  const [
    sourceObjectsAfter,
    targetObjectsAfter,
    recordingEvidenceAfter,
    sourceBucketsAfter,
    targetBucketsAfter,
  ] = await Promise.all([
    readObjects(EXPECTED_SOURCE_REF, sourceToken),
    readObjects(EXPECTED_TARGET_REF, targetToken),
    readRecordingEvidence(EXPECTED_TARGET_REF, targetToken, evidence.operationalBaselineUtc),
    readBuckets(EXPECTED_SOURCE_REF, sourceToken),
    readBuckets(EXPECTED_TARGET_REF, targetToken),
  ]);
  await Promise.all([
    validateDatabaseState(EXPECTED_SOURCE_REF, sourceToken, true),
    validateDatabaseState(EXPECTED_TARGET_REF, targetToken, false),
  ]);
  requireBucketContract(sourceBucketsAfter, baseline, 'closing source');
  requireBucketContract(targetBucketsAfter, baseline, 'closing target');
  requireCondition(objectCatalogDigest(sourceObjectsAfter) === objectCatalogDigest(sourceObjects), 'source Storage catalog changed during validation');
  requireCondition(objectCatalogDigest(targetObjectsAfter) === objectCatalogDigest(targetObjects), 'target Storage catalog changed during validation');
  requireCondition(recordingEvidenceDigest(recordingEvidenceAfter) === recordingEvidenceDigest(recordingEvidence), 'recording database evidence changed during validation');

  process.stdout.write('Opakujem záverečnú obsahovú kontrolu targetu...\n');
  await runPool(targetObjects, async (targetObject) => {
    const payload = await hashStorageObject(EXPECTED_TARGET_REF, targetServiceKey, targetObject, 'target');
    requireCondition(payload.bytes === targetObject.size, 'closing target Storage payload size differs from metadata');
    requireCondition(payload.sha256 === targetPayloadHashes.get(objectKey(targetObject)), 'target Storage payload changed during validation');
    validatedPayloads += 1;
    if (validatedPayloads % 250 === 0) process.stdout.write(`Storage payload progress: ${validatedPayloads}/${totalPayloadChecks}\n`);
  });
  const [
    sourceObjectsFinal,
    targetObjectsFinal,
    recordingEvidenceFinal,
    sourceBucketsFinal,
    targetBucketsFinal,
  ] = await Promise.all([
    readObjects(EXPECTED_SOURCE_REF, sourceToken),
    readObjects(EXPECTED_TARGET_REF, targetToken),
    readRecordingEvidence(EXPECTED_TARGET_REF, targetToken, evidence.operationalBaselineUtc),
    readBuckets(EXPECTED_SOURCE_REF, sourceToken),
    readBuckets(EXPECTED_TARGET_REF, targetToken),
  ]);
  await Promise.all([
    validateDatabaseState(EXPECTED_SOURCE_REF, sourceToken, true),
    validateDatabaseState(EXPECTED_TARGET_REF, targetToken, false),
  ]);
  requireBucketContract(sourceBucketsFinal, baseline, 'final source');
  requireBucketContract(targetBucketsFinal, baseline, 'final target');
  requireCondition(objectCatalogDigest(sourceObjectsFinal) === objectCatalogDigest(sourceObjects), 'source Storage catalog changed during closing validation');
  requireCondition(objectCatalogDigest(targetObjectsFinal) === objectCatalogDigest(targetObjects), 'target Storage catalog changed during closing validation');
  requireCondition(recordingEvidenceDigest(recordingEvidenceFinal) === recordingEvidenceDigest(recordingEvidence), 'recording database evidence changed during closing validation');
  requireCondition(validatedPayloads === totalPayloadChecks, 'closing Storage payload validation count differs');
  assertEvidenceStable(evidence.stability);

  const targetOnlyCounts = Object.fromEntries(EXPECTED_BUCKETS.map((bucket) => [bucket, 0]));
  for (const targetObject of targetOnly) targetOnlyCounts[targetObject.bucket] += 1;
  const { buckets, status } = evaluateBucketReports({
    baseline,
    sourceTotals,
    targetTotals,
    liveGrowthBuckets: evidence.liveGrowthBuckets,
    rootAnchorBucket: evidence.rootAnchorBucket,
    recordingBucket: evidence.recordingContract.bucket,
    targetOnlyCounts,
    targetOnlyKeysetMatchesDatabase,
    anchoredLiveContentMatches,
    transitionAnchoredContentMatches,
    recordingMetadataContractMatches,
  });
  requireCondition(status === 'pass', 'Storage aggregate contract differs');
  const capturedTransition = captureTransition
    ? captureStorageTransition({
      root,
      snapshotId,
      evidence,
      targetOnly,
      targetPayloadHashes,
      recordingMetadataContractMatches,
    })
    : null;
  if (capturedTransition) {
    evidence.stability.fileBindings.push(...capturedTransition.fileBindings);
  }
  assertEvidenceStable(evidence.stability);
  const storageTransitionManifestSha256 = capturedTransition?.manifestSha256
    ?? evidence.storageTransition.manifestSha256;

  const report = {
    snapshot_id: snapshotId,
    source_project_ref: EXPECTED_SOURCE_REF,
    target_project_ref: EXPECTED_TARGET_REF,
    validated_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source_validation_mode: 'management_api_read_only_storage_rest',
    storage_operation: captureTransition ? 'capture_transition' : 'validate',
    privacy: 'Aggregate bucket counts and bytes only; no object names, content hashes, PII, or credentials.',
    storage_payload_status: status,
    continuity_status: status === 'pass' ? 'pass_continuity' : 'fail',
    live_growth_buckets: evidence.liveGrowthBuckets,
    root_anchor_bucket: evidence.rootAnchorBucket,
    continuity_policy_sha256: evidence.continuityPolicySha256,
    continuity_anchor_sha256: evidence.continuityAnchorSha256,
    live_watermark_anchor_sha256: evidence.watermarkAnchorSha256,
    live_storage_anchor_sha256: evidence.storageAnchorSha256,
    live_storage_transition_manifest_sha256: storageTransitionManifestSha256,
    live_storage_transition_status: 'pass_append_only_transition',
    target_only_keyset_matches_database: targetOnlyKeysetMatchesDatabase,
    anchored_live_content_matches: anchoredLiveContentMatches,
    transition_anchored_content_matches: transitionAnchoredContentMatches,
    recording_metadata_contract_matches: recordingMetadataContractMatches,
    target_only_payload_count: targetOnly.length,
    buckets,
    source_deleted: false,
    source_write_freeze_active: true,
    cutover_status: 'blocked_pending_config_and_application_validation',
  };
  const reportPath = join(root, '.context/migration/validation', `storage-${snapshotId}.json`);
  writePrivateJson(reportPath, report);
  process.stdout.write(
    captureTransition
      ? 'Read-only Storage transition bola vytvorená append-only. Source ani target neboli zmenené.\n'
      : 'Read-only Storage REST obsahová validácia prešla. Source ani target neboli zmenené.\n',
  );
  process.stdout.write(`Report: .context/migration/validation/storage-${snapshotId}.json\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
