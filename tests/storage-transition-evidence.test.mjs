import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildStorageTransitionManifest,
  canonicalizeStorageCatalogEntries,
  parseStorageTransitionCatalog,
  serializeStorageTransitionCatalog,
  validateStorageTransitionManifest,
  verifyCurrentStorageCatalogContainsAnchored,
} from '../deploy/bin/storage-transition-evidence.mjs';

const ALLOWED_BUCKETS = ['rental-photos', 'motorist-call-recordings'];
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const BASE = {
  snapshotId: '20260714T184445Z',
  sourceProjectRef: 'jcwbiulwuwyrnmzjjbgr',
  targetProjectRef: 'sjcsrygkkmersoczpunh',
  currentPolicySha256: '1'.repeat(64),
  currentWatermarkSha256: '2'.repeat(64),
  rootStorageManifestSha256: '3'.repeat(64),
  allowedBuckets: ALLOWED_BUCKETS,
  capturedAtUtc: '2026-07-17T11:30:00Z',
  sourceExactSubset: true,
  recordingContractVerified: true,
};

function entry(bucket, name, size, sha256) {
  return { bucket, name, size, sha256 };
}

function fixtureEntries() {
  return [
    entry('rental-photos', 'z/photo.jpg', 20, HASH_B),
    entry('motorist-call-recordings', 'org/call/recording.wav', 10, HASH_A),
  ];
}

test('Storage transition catalog is bucket-qualified, byte-sorted, and byte-stable', () => {
  const canonical = canonicalizeStorageCatalogEntries(fixtureEntries(), { allowedBuckets: ALLOWED_BUCKETS });
  assert.deepEqual(canonical.map(({ bucket, name }) => [bucket, name]), [
    ['motorist-call-recordings', 'org/call/recording.wav'],
    ['rental-photos', 'z/photo.jpg'],
  ]);

  const serialized = serializeStorageTransitionCatalog(fixtureEntries(), { allowedBuckets: ALLOWED_BUCKETS });
  assert.equal(serialized, [
    `{"bucket":"motorist-call-recordings","name":"org/call/recording.wav","size":10,"sha256":"${HASH_A}"}`,
    `{"bucket":"rental-photos","name":"z/photo.jpg","size":20,"sha256":"${HASH_B}"}`,
    '',
  ].join('\n'));
  assert.deepEqual(parseStorageTransitionCatalog(Buffer.from(serialized), {
    allowedBuckets: ALLOWED_BUCKETS,
  }), canonical);
  assert.equal(serializeStorageTransitionCatalog(canonical, { allowedBuckets: ALLOWED_BUCKETS }), serialized);
});

test('Storage transition catalog rejects ambiguous or untrusted entries', () => {
  const valid = entry('motorist-call-recordings', 'org/call/recording.wav', 10, HASH_A);
  const invalidEntries = [
    [valid, { ...valid }],
    [{ ...valid, bucket: 'unknown-bucket' }],
    [{ ...valid, sha256: HASH_A.toUpperCase() }],
    [{ ...valid, sha256: 'a'.repeat(63) }],
    [{ ...valid, size: -1 }],
    [{ ...valid, size: 1.5 }],
    [{ ...valid, name: '../recording.wav' }],
    [{ ...valid, name: 'org/../recording.wav' }],
    [{ ...valid, name: '/org/recording.wav' }],
    [{ ...valid, name: 'org//recording.wav' }],
    [{ ...valid, name: 'org\\recording.wav' }],
    [{ ...valid, name: 'org/%2e%2e/recording.wav' }],
    [{ ...valid, name: 'org/%252e%252e/recording.wav' }],
    [{ ...valid, name: 'org%2Fcall/recording.wav' }],
    [{ ...valid, name: 'org/recording\n.wav' }],
    [{ ...valid, name: 'org/recording\0.wav' }],
    [{ ...valid, name: 'org/cafe\u0301.wav' }],
    [{ ...valid, name: 'org/invalid-\uD800.wav' }],
    [{ ...valid, unexpected: true }],
  ];
  for (const entries of invalidEntries) {
    assert.throws(() => serializeStorageTransitionCatalog(entries, { allowedBuckets: ALLOWED_BUCKETS }));
  }
  assert.throws(() => serializeStorageTransitionCatalog([valid], {
    allowedBuckets: ['motorist-call-recordings', 'not-a-bucket'],
  }));
});

test('strict catalog parser rejects non-canonical encodings without leaking paths', () => {
  const sensitiveName = 'private/sensitive-recording.wav';
  const valid = serializeStorageTransitionCatalog([
    entry('motorist-call-recordings', sensitiveName, 10, HASH_A),
  ], { allowedBuckets: ALLOWED_BUCKETS });
  const cases = [
    valid.trimEnd(),
    ` ${valid}`,
    valid.replace('{"bucket"', '{ "bucket"'),
    valid.replace('"size":10', '"size":10,"extra":true'),
    `${valid}\n`,
    `${valid}${valid}`,
    Buffer.from([0xff]),
  ];
  for (const value of cases) {
    let error;
    try {
      parseStorageTransitionCatalog(value, { allowedBuckets: ALLOWED_BUCKETS });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /sensitive-recording/);
  }
});

test('schema v2 manifest binds identities, policy, watermark, root manifest, and aggregate catalog', () => {
  const catalogEntries = fixtureEntries();
  const manifest = buildStorageTransitionManifest({ ...BASE, catalogEntries });
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.allowedBuckets, ['motorist-call-recordings', 'rental-photos']);
  assert.equal(manifest.catalog.count, 2);
  assert.equal(manifest.catalog.bytes, 30);
  assert.deepEqual(
    Object.fromEntries(Object.entries(manifest.catalog.byBucket).map(([bucket, value]) => [bucket, {
      count: value.count,
      bytes: value.bytes,
    }])),
    {
      'motorist-call-recordings': { count: 1, bytes: 10 },
      'rental-photos': { count: 1, bytes: 20 },
    },
  );
  assert.match(manifest.catalog.byBucket['motorist-call-recordings'].sha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.catalog.byBucket['rental-photos'].sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.sourceExactSubset, true);
  assert.equal(manifest.recordingContractVerified, true);
  assert.match(manifest.catalog.sha256, /^[0-9a-f]{64}$/);

  const result = validateStorageTransitionManifest(manifest, {
    ...BASE,
    catalog: serializeStorageTransitionCatalog(catalogEntries, { allowedBuckets: ALLOWED_BUCKETS }),
  });
  assert.deepEqual(result, {
    verified: true,
    catalogSha256: manifest.catalog.sha256,
    catalogCount: 2,
    catalogBytes: 30,
    byBucket: manifest.catalog.byBucket,
  });
});

test('manifest validation fails closed on every protected binding and aggregate', () => {
  const catalogEntries = fixtureEntries();
  const manifest = buildStorageTransitionManifest({ ...BASE, catalogEntries });
  const validation = {
    ...BASE,
    catalog: serializeStorageTransitionCatalog(catalogEntries, { allowedBuckets: ALLOWED_BUCKETS }),
  };
  const mutations = [
    (value) => { value.schemaVersion = 1; },
    (value) => { value.snapshotId = '20260714T184446Z'; },
    (value) => { value.sourceProjectRef = 'aaaaaaaaaaaaaaaaaaaa'; },
    (value) => { value.targetProjectRef = 'bbbbbbbbbbbbbbbbbbbb'; },
    (value) => { value.currentPolicySha256 = '4'.repeat(64); },
    (value) => { value.currentWatermarkSha256 = '5'.repeat(64); },
    (value) => { value.rootStorageManifestSha256 = '6'.repeat(64); },
    (value) => { value.allowedBuckets = ['motorist-call-recordings']; },
    (value) => { value.capturedAtUtc = '2026-07-17T11:30:00.000Z'; },
    (value) => { value.sourceExactSubset = false; },
    (value) => { value.recordingContractVerified = false; },
    (value) => { value.catalog.sha256 = '7'.repeat(64); },
    (value) => { value.catalog.count += 1; },
    (value) => { value.catalog.bytes += 1; },
    (value) => { value.catalog.byBucket['motorist-call-recordings'].sha256 = '8'.repeat(64); },
    (value) => { value.catalog.byBucket['motorist-call-recordings'].count += 1; },
    (value) => { value.extra = true; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(manifest);
    mutate(changed);
    assert.throws(() => validateStorageTransitionManifest(changed, validation));
  }

  assert.throws(() => buildStorageTransitionManifest({
    ...BASE,
    catalogEntries,
    sourceExactSubset: false,
  }));
  assert.throws(() => buildStorageTransitionManifest({
    ...BASE,
    catalogEntries,
    recordingContractVerified: false,
  }));
  assert.throws(() => buildStorageTransitionManifest({
    ...BASE,
    catalogEntries: [entry('rental-photos', 'z/photo.jpg', 20, HASH_B)],
  }), /no reviewed recording/);

  const noRecording = structuredClone(manifest);
  noRecording.catalog.byBucket['motorist-call-recordings'].count = 0;
  assert.throws(() => validateStorageTransitionManifest(noRecording, validation));
});

test('anchored entries must remain an exact size-and-hash subset of current Storage', () => {
  const anchored = fixtureEntries();
  const current = [
    ...anchored,
    entry('rental-photos', 'z/new-photo.jpg', 30, HASH_C),
  ];
  const result = verifyCurrentStorageCatalogContainsAnchored({
    anchoredCatalog: serializeStorageTransitionCatalog(anchored, { allowedBuckets: ALLOWED_BUCKETS }),
    currentCatalog: current,
    allowedBuckets: ALLOWED_BUCKETS,
  });
  assert.equal(result.verified, true);
  assert.equal(result.anchoredCount, 2);
  assert.equal(result.anchoredBytes, 30);
  assert.equal('name' in result, false);

  assert.throws(() => verifyCurrentStorageCatalogContainsAnchored({
    anchoredCatalog: anchored,
    currentCatalog: current.slice(1),
    allowedBuckets: ALLOWED_BUCKETS,
  }), /missing anchored evidence/);
  assert.throws(() => verifyCurrentStorageCatalogContainsAnchored({
    anchoredCatalog: anchored,
    currentCatalog: current.map((value, index) => index === 0 ? { ...value, sha256: HASH_C } : value),
    allowedBuckets: ALLOWED_BUCKETS,
  }), /differs from anchored evidence/);
  assert.throws(() => verifyCurrentStorageCatalogContainsAnchored({
    anchoredCatalog: anchored,
    currentCatalog: [...current, { ...current[0] }],
    allowedBuckets: ALLOWED_BUCKETS,
  }), /duplicate/);
});

test('pure evidence helper has no network, credential, or output side effects', () => {
  const source = readFileSync('deploy/bin/storage-transition-evidence.mjs', 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /process\.(stdout|stderr)/);
  assert.doesNotMatch(source, /console\./);
  assert.doesNotMatch(source, /access[_-]?token|service[_-]?role|password|credential/i);
});
