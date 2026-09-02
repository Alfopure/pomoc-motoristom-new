import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

export const KNOWN_STORAGE_BUCKETS = Object.freeze([
  'motorist-call-recordings',
  'motorist-case-attachments',
  'rental-photos',
  'signatures',
  'vehicle-damage-photos',
  'vehicle-photos',
]);

const RECORDINGS_BUCKET = 'motorist-call-recordings';
const PRIVACY = 'Aggregate counts, bytes, and evidence hashes only; object names remain in the private companion catalog.';
const ENTRY_KEYS = ['bucket', 'name', 'sha256', 'size'];
const MANIFEST_KEYS = [
  'allowedBuckets',
  'capturedAtUtc',
  'catalog',
  'currentPolicySha256',
  'currentWatermarkSha256',
  'privacy',
  'recordingContractVerified',
  'rootStorageManifestSha256',
  'schemaVersion',
  'snapshotId',
  'sourceExactSubset',
  'sourceProjectRef',
  'targetProjectRef',
];
const CATALOG_SUMMARY_KEYS = ['byBucket', 'bytes', 'count', 'sha256'];
const BUCKET_SUMMARY_KEYS = ['bytes', 'count', 'sha256'];
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function fail(message) {
  throw new Error(`STORAGE_TRANSITION_EVIDENCE_FAILED: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value, expected, label) {
  requireCondition(isPlainObject(value), `${label} is not an object`);
  const actual = Object.keys(value).sort(byteCompare);
  requireCondition(sameArray(actual, [...expected].sort(byteCompare)), `${label} fields differ`);
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function safeInteger(value, label) {
  requireCondition(Number.isSafeInteger(value) && value >= 0, `${label} is not a safe non-negative integer`);
  return value;
}

function safeAdd(left, right, label) {
  const value = left + right;
  requireCondition(Number.isSafeInteger(value), `${label} exceeds the safe integer range`);
  return value;
}

function requireSha256(value, label) {
  requireCondition(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), `${label} is invalid`);
  return value;
}

function requireIdentity(value, label) {
  requireCondition(typeof value === 'string' && /^[a-z0-9]{20}$/.test(value), `${label} is invalid`);
  return value;
}

function requireSnapshotId(value) {
  requireCondition(typeof value === 'string' && /^\d{8}T\d{6}Z$/.test(value), 'snapshot ID is invalid');
  return value;
}

function requireUtcSeconds(value) {
  requireCondition(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value),
    'capture timestamp is invalid',
  );
  const parsed = new Date(value);
  requireCondition(
    Number.isFinite(parsed.valueOf()) && parsed.toISOString().replace('.000Z', 'Z') === value,
    'capture timestamp is invalid',
  );
  return value;
}

function normalizeAllowedBuckets(allowedBuckets) {
  requireCondition(Array.isArray(allowedBuckets) && allowedBuckets.length > 0, 'allowed bucket list is invalid');
  requireCondition(allowedBuckets.every((bucket) => typeof bucket === 'string'), 'allowed bucket list is invalid');
  const unique = new Set(allowedBuckets);
  requireCondition(unique.size === allowedBuckets.length, 'allowed bucket list contains duplicates');
  requireCondition(
    allowedBuckets.every((bucket) => KNOWN_STORAGE_BUCKETS.includes(bucket)),
    'allowed bucket list contains an unknown bucket',
  );
  return [...allowedBuckets].sort(byteCompare);
}

export function validateStorageObjectName(name) {
  requireCondition(typeof name === 'string' && name.length > 0, 'catalog object path is invalid');
  requireCondition(!/[\uD800-\uDFFF]/u.test(name), 'catalog object path contains invalid Unicode');
  requireCondition(name.normalize('NFC') === name, 'catalog object path is not canonically normalized');

  let candidate = name;
  for (let pass = 0; pass < 4; pass += 1) {
    requireCondition(!/[\u0000-\u001f\u007f\u2028\u2029]/u.test(candidate), 'catalog object path contains control characters');
    requireCondition(!candidate.includes('\\'), 'catalog object path contains an ambiguous separator');
    requireCondition(!candidate.startsWith('/') && !candidate.endsWith('/'), 'catalog object path is absolute or incomplete');
    const segments = candidate.split('/');
    requireCondition(
      segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
      'catalog object path contains an ambiguous segment',
    );
    requireCondition(candidate.normalize('NFC') === candidate, 'catalog object path is not canonically normalized');
    if (!candidate.includes('%')) break;

    let decoded;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      fail('catalog object path contains invalid percent encoding');
    }
    if (decoded === candidate) break;
    requireCondition(
      decoded.split('/').length === candidate.split('/').length,
      'catalog object path contains an encoded separator',
    );
    candidate = decoded;
  }
  requireCondition(!/%(?:25){3,}/i.test(name), 'catalog object path encoding is too deeply nested');
  return name;
}

function normalizeEntry(entry, allowedBucketSet) {
  requireExactKeys(entry, ENTRY_KEYS, 'catalog entry');
  requireCondition(
    typeof entry.bucket === 'string' && allowedBucketSet.has(entry.bucket),
    'catalog entry bucket is not allowed',
  );
  return {
    bucket: entry.bucket,
    name: validateStorageObjectName(entry.name),
    size: safeInteger(entry.size, 'catalog entry size'),
    sha256: requireSha256(entry.sha256, 'catalog entry hash'),
  };
}

function entryKey(entry) {
  return JSON.stringify([entry.bucket, entry.name]);
}

function compareEntries(left, right) {
  return byteCompare(left.bucket, right.bucket) || byteCompare(left.name, right.name);
}

function canonicalEntryLine(entry) {
  return JSON.stringify({
    bucket: entry.bucket,
    name: entry.name,
    size: entry.size,
    sha256: entry.sha256,
  });
}

function serializedText(value) {
  if (typeof value === 'string') return value;
  requireCondition(Buffer.isBuffer(value) || value instanceof Uint8Array, 'catalog serialization is invalid');
  try {
    return UTF8_DECODER.decode(value);
  } catch {
    fail('catalog serialization is not valid UTF-8');
  }
}

function catalogInputEntries(catalog, allowedBuckets) {
  if (Array.isArray(catalog)) return canonicalizeStorageCatalogEntries(catalog, { allowedBuckets });
  return parseStorageTransitionCatalog(catalog, { allowedBuckets });
}

function catalogSummary(entries, allowedBuckets) {
  const serialized = serializeStorageTransitionCatalog(entries, { allowedBuckets });
  const bucketEntries = Object.fromEntries(allowedBuckets.map((bucket) => [bucket, []]));
  const byBucket = Object.fromEntries(allowedBuckets.map((bucket) => [bucket, {
    sha256: '',
    count: 0,
    bytes: 0,
  }]));
  let bytes = 0;
  for (const entry of entries) {
    bucketEntries[entry.bucket].push(entry);
    byBucket[entry.bucket].count = safeAdd(byBucket[entry.bucket].count, 1, 'bucket object count');
    byBucket[entry.bucket].bytes = safeAdd(byBucket[entry.bucket].bytes, entry.size, 'bucket payload byte total');
    bytes = safeAdd(bytes, entry.size, 'catalog payload byte total');
  }
  for (const bucket of allowedBuckets) {
    const bucketSerialized = bucketEntries[bucket].length === 0
      ? ''
      : `${bucketEntries[bucket].map(canonicalEntryLine).join('\n')}\n`;
    byBucket[bucket].sha256 = createHash('sha256').update(bucketSerialized, 'utf8').digest('hex');
  }
  return {
    sha256: createHash('sha256').update(serialized, 'utf8').digest('hex'),
    count: entries.length,
    bytes,
    byBucket,
  };
}

function sameSummary(left, right, allowedBuckets) {
  if (left.sha256 !== right.sha256 || left.count !== right.count || left.bytes !== right.bytes) return false;
  return allowedBuckets.every((bucket) => (
    left.byBucket[bucket].sha256 === right.byBucket[bucket].sha256
      && left.byBucket[bucket].count === right.byBucket[bucket].count
      && left.byBucket[bucket].bytes === right.byBucket[bucket].bytes
  ));
}

export function canonicalizeStorageCatalogEntries(entries, { allowedBuckets }) {
  requireCondition(Array.isArray(entries), 'catalog entries are invalid');
  const canonicalBuckets = normalizeAllowedBuckets(allowedBuckets);
  const allowedBucketSet = new Set(canonicalBuckets);
  const normalized = entries.map((entry) => normalizeEntry(entry, allowedBucketSet)).sort(compareEntries);
  const keys = normalized.map(entryKey);
  requireCondition(new Set(keys).size === keys.length, 'catalog contains duplicate bucket-qualified paths');
  return normalized;
}

export function serializeStorageTransitionCatalog(entries, { allowedBuckets }) {
  const normalized = canonicalizeStorageCatalogEntries(entries, { allowedBuckets });
  return normalized.length === 0 ? '' : `${normalized.map(canonicalEntryLine).join('\n')}\n`;
}

export function parseStorageTransitionCatalog(value, { allowedBuckets }) {
  const text = serializedText(value);
  if (text === '') return [];
  requireCondition(text.endsWith('\n'), 'catalog serialization has no final newline');
  const lines = text.slice(0, -1).split('\n');
  requireCondition(lines.every((line) => line.length > 0), 'catalog serialization contains an empty line');
  let parsed;
  try {
    parsed = lines.map((line) => JSON.parse(line));
  } catch {
    fail('catalog serialization contains invalid JSON');
  }
  const normalized = canonicalizeStorageCatalogEntries(parsed, { allowedBuckets });
  requireCondition(
    serializeStorageTransitionCatalog(normalized, { allowedBuckets }) === text,
    'catalog serialization is not canonical',
  );
  return normalized;
}

export function buildStorageTransitionManifest({
  snapshotId,
  sourceProjectRef,
  targetProjectRef,
  currentPolicySha256,
  currentWatermarkSha256,
  rootStorageManifestSha256,
  allowedBuckets,
  capturedAtUtc,
  catalogEntries,
  sourceExactSubset,
  recordingContractVerified,
}) {
  const canonicalBuckets = normalizeAllowedBuckets(allowedBuckets);
  requireCondition(canonicalBuckets.includes(RECORDINGS_BUCKET), 'recording bucket is not included in transition evidence');
  requireCondition(sourceExactSubset === true, 'source exact-subset verification is required');
  requireCondition(recordingContractVerified === true, 'recording contract verification is required');
  const entries = canonicalizeStorageCatalogEntries(catalogEntries, { allowedBuckets: canonicalBuckets });
  const summary = catalogSummary(entries, canonicalBuckets);
  requireCondition(summary.byBucket[RECORDINGS_BUCKET].count >= 1, 'transition evidence has no reviewed recording');
  return {
    schemaVersion: 2,
    snapshotId: requireSnapshotId(snapshotId),
    sourceProjectRef: requireIdentity(sourceProjectRef, 'source project reference'),
    targetProjectRef: requireIdentity(targetProjectRef, 'target project reference'),
    currentPolicySha256: requireSha256(currentPolicySha256, 'current policy hash'),
    currentWatermarkSha256: requireSha256(currentWatermarkSha256, 'current watermark hash'),
    rootStorageManifestSha256: requireSha256(rootStorageManifestSha256, 'root Storage manifest hash'),
    allowedBuckets: canonicalBuckets,
    capturedAtUtc: requireUtcSeconds(capturedAtUtc),
    catalog: summary,
    sourceExactSubset: true,
    recordingContractVerified: true,
    privacy: PRIVACY,
  };
}

export function validateStorageTransitionManifest(manifest, {
  snapshotId,
  sourceProjectRef,
  targetProjectRef,
  currentPolicySha256,
  currentWatermarkSha256,
  rootStorageManifestSha256,
  allowedBuckets,
  catalog,
  capturedAtUtc,
} = {}) {
  requireExactKeys(manifest, MANIFEST_KEYS, 'Storage transition manifest');
  requireCondition(manifest.schemaVersion === 2, 'Storage transition manifest schema differs');
  const canonicalBuckets = normalizeAllowedBuckets(allowedBuckets);
  requireCondition(canonicalBuckets.includes(RECORDINGS_BUCKET), 'recording bucket is not included in transition evidence');
  const manifestBuckets = normalizeAllowedBuckets(manifest.allowedBuckets);
  requireCondition(
    sameArray(manifest.allowedBuckets, manifestBuckets) && sameArray(manifestBuckets, canonicalBuckets),
    'allowed bucket binding differs',
  );
  requireCondition(manifest.snapshotId === requireSnapshotId(snapshotId), 'snapshot binding differs');
  requireCondition(
    manifest.sourceProjectRef === requireIdentity(sourceProjectRef, 'source project reference'),
    'source project binding differs',
  );
  requireCondition(
    manifest.targetProjectRef === requireIdentity(targetProjectRef, 'target project reference'),
    'target project binding differs',
  );
  requireCondition(
    manifest.currentPolicySha256 === requireSha256(currentPolicySha256, 'current policy hash'),
    'current policy binding differs',
  );
  requireCondition(
    manifest.currentWatermarkSha256 === requireSha256(currentWatermarkSha256, 'current watermark hash'),
    'current watermark binding differs',
  );
  requireCondition(
    manifest.rootStorageManifestSha256 === requireSha256(rootStorageManifestSha256, 'root Storage manifest hash'),
    'root Storage manifest binding differs',
  );
  requireUtcSeconds(manifest.capturedAtUtc);
  if (capturedAtUtc !== undefined) {
    requireCondition(manifest.capturedAtUtc === requireUtcSeconds(capturedAtUtc), 'capture timestamp binding differs');
  }
  requireCondition(manifest.sourceExactSubset === true, 'source exact-subset verification is absent');
  requireCondition(manifest.recordingContractVerified === true, 'recording contract verification is absent');
  requireCondition(manifest.privacy === PRIVACY, 'manifest privacy contract differs');

  requireExactKeys(manifest.catalog, CATALOG_SUMMARY_KEYS, 'catalog summary');
  requireSha256(manifest.catalog.sha256, 'catalog hash');
  safeInteger(manifest.catalog.count, 'catalog count');
  safeInteger(manifest.catalog.bytes, 'catalog byte total');
  requireExactKeys(manifest.catalog.byBucket, canonicalBuckets, 'per-bucket catalog summary');
  for (const bucket of canonicalBuckets) {
    requireExactKeys(manifest.catalog.byBucket[bucket], BUCKET_SUMMARY_KEYS, 'bucket catalog summary');
    requireSha256(manifest.catalog.byBucket[bucket].sha256, 'bucket catalog hash');
    safeInteger(manifest.catalog.byBucket[bucket].count, 'bucket catalog count');
    safeInteger(manifest.catalog.byBucket[bucket].bytes, 'bucket catalog byte total');
  }

  const entries = catalogInputEntries(catalog, canonicalBuckets);
  const expectedSummary = catalogSummary(entries, canonicalBuckets);
  requireCondition(expectedSummary.byBucket[RECORDINGS_BUCKET].count >= 1, 'transition evidence has no reviewed recording');
  requireCondition(sameSummary(manifest.catalog, expectedSummary, canonicalBuckets), 'catalog summary binding differs');
  return {
    verified: true,
    catalogSha256: expectedSummary.sha256,
    catalogCount: expectedSummary.count,
    catalogBytes: expectedSummary.bytes,
    byBucket: expectedSummary.byBucket,
  };
}

export function verifyCurrentStorageCatalogContainsAnchored({
  anchoredCatalog,
  currentCatalog,
  allowedBuckets,
}) {
  const canonicalBuckets = normalizeAllowedBuckets(allowedBuckets);
  const anchored = catalogInputEntries(anchoredCatalog, canonicalBuckets);
  const current = catalogInputEntries(currentCatalog, canonicalBuckets);
  const currentByKey = new Map(current.map((entry) => [entryKey(entry), entry]));
  for (const entry of anchored) {
    const candidate = currentByKey.get(entryKey(entry));
    requireCondition(candidate !== undefined, 'current Storage catalog is missing anchored evidence');
    requireCondition(
      candidate.size === entry.size && candidate.sha256 === entry.sha256,
      'current Storage catalog differs from anchored evidence',
    );
  }
  const summary = catalogSummary(anchored, canonicalBuckets);
  return {
    verified: true,
    anchoredCount: summary.count,
    anchoredBytes: summary.bytes,
    byBucket: summary.byBucket,
  };
}
