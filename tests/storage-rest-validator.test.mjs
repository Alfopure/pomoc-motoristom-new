import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  encodeStorageObjectPath,
  evaluateBucketReports,
  evaluateCatalogContract,
  parseHashCatalog,
  parsePrivatePathCatalog,
  validateOperationalBaselineBinding,
  validateRecordingGrowth,
  validateStorageGrowthPolicy,
} from '../deploy/bin/validate-storage-rest.mjs';

const BUCKETS = [
  'motorist-call-recordings',
  'motorist-case-attachments',
  'rental-photos',
  'signatures',
  'vehicle-damage-photos',
  'vehicle-photos',
];

function storageObject(bucket, name, createdAt, size = 10) {
  return { bucket, name, createdAt: Date.parse(createdAt), size };
}

function aggregateFixture() {
  return Object.fromEntries(BUCKETS.map((bucket) => [bucket, { count: 0, bytes: 0 }]));
}

test('Storage REST paths encode each bucket and object segment', () => {
  assert.equal(
    encodeStorageObjectPath('rental-photos', 'folder/a b+#.jpg'),
    'rental-photos/folder/a%20b%2B%23.jpg',
  );
  assert.throws(() => encodeStorageObjectPath('rental-photos', 'folder//file.jpg'));
  assert.throws(() => encodeStorageObjectPath('rental-photos', 'folder/../file.jpg'));
  assert.throws(() => encodeStorageObjectPath('rental-photos', 'folder/./file.jpg'));
  assert.throws(() => encodeStorageObjectPath('rental-photos', 'folder/%2e%2e/file.jpg'));
  assert.throws(() => encodeStorageObjectPath('unknown-bucket', 'file.jpg'));
});

test('Storage growth policy accepts exactly the reviewed v12 bucket contract', () => {
  const policy = {
    schemaVersion: 12,
    snapshotId: '20260714T184445Z',
    sourceProjectRef: 'jcwbiulwuwyrnmzjjbgr',
    targetProjectRef: 'sjcsrygkkmersoczpunh',
    guards: {
      sourceDeletionForbidden: true,
      sourceMustRemainFrozen: true,
      targetCronMustRemainDisabled: true,
      targetJobsMustRemainDisabled: true,
      targetRewindForbidden: true,
    },
    publicData: {
      operationalContinuity: {
        boundaryColumn: 'created_at',
        operationalBaselineUtc: '2026-07-14T18:47:01Z',
      },
    },
    storage: {
      allowedLiveGrowthBuckets: ['motorist-call-recordings', 'rental-photos'],
      rootAnchorBucket: 'rental-photos',
      sourcePayloadsMustRemainAContentExactSubset: true,
      recordingGrowthContract: {
        bucket: 'motorist-call-recordings',
        provider: 'viptel',
        requiredCallStatus: 'ended',
        requiredRecordingStatus: 'available',
        requireAppendOnlyTransitionEvidence: true,
        requireChecksumMatch: true,
        requirePostSnapshotObject: true,
        requireSizeMatch: true,
      },
    },
  };
  assert.deepEqual(validateStorageGrowthPolicy(policy, policy.snapshotId).liveGrowthBuckets, [
    'motorist-call-recordings',
    'rental-photos',
  ]);
  assert.equal(
    validateStorageGrowthPolicy(policy, policy.snapshotId).operationalBaselineUtc,
    '2026-07-14T18:47:01Z',
  );
  assert.throws(() => validateStorageGrowthPolicy({ ...policy, schemaVersion: 13 }, policy.snapshotId));
  assert.throws(() => validateStorageGrowthPolicy({
    ...policy,
    guards: { ...policy.guards, targetCronMustRemainDisabled: false },
  }, policy.snapshotId));
  assert.throws(() => validateStorageGrowthPolicy({
    ...policy,
    guards: { ...policy.guards, targetRewindForbidden: false },
  }, policy.snapshotId));
  assert.throws(() => validateStorageGrowthPolicy({
    ...policy,
    storage: {
      ...policy.storage,
      allowedLiveGrowthBuckets: [
        'motorist-call-recordings',
        'rental-photos',
        'vehicle-photos',
      ],
    },
  }, policy.snapshotId));
  assert.throws(() => validateStorageGrowthPolicy({
    ...policy,
    publicData: {
      operationalContinuity: {
        ...policy.publicData.operationalContinuity,
        operationalBaselineUtc: '2026-07-14T18:47:01.000Z',
      },
    },
  }, policy.snapshotId), /operational baseline is invalid/);
});

test('recording operational baseline must match the immutable source freeze timestamp', () => {
  assert.equal(validateOperationalBaselineBinding(
    '2026-07-14T18:47:01Z',
    '2026-07-14T18:47:01Z',
  ), true);
  assert.throws(() => validateOperationalBaselineBinding(
    '2026-07-14T18:47:02Z',
    '2026-07-14T18:47:01Z',
  ), /differs from the source freeze receipt/);
});

test('private Storage catalogs fail closed on ambiguity', () => {
  assert.deepEqual(parsePrivatePathCatalog('a/one.jpg\nb/two.jpg\n'), ['a/one.jpg', 'b/two.jpg']);
  assert.throws(() => parsePrivatePathCatalog('b/two.jpg\na/one.jpg\n'));
  assert.throws(() => parsePrivatePathCatalog('a/one.jpg\na/one.jpg\n'));

  const digestA = 'a'.repeat(64);
  const digestB = 'b'.repeat(64);
  const hashes = parseHashCatalog(`${digestA}  a/one.jpg\n${digestB}  b/two.jpg\n`);
  assert.equal(hashes.get('a/one.jpg'), digestA);
  assert.throws(() => parseHashCatalog(`${digestA} a/one.jpg\n`));
  assert.throws(() => parseHashCatalog(`${digestA}  a/one.jpg\n${digestB}  a/one.jpg\n`));
});

test('catalog contract permits only post-cutoff growth in explicitly allowed buckets', () => {
  const source = [storageObject('rental-photos', 'base.jpg', '2026-07-14T10:00:00Z')];
  const live = storageObject('rental-photos', 'live.jpg', '2026-07-15T10:00:00Z');
  const recording = storageObject('motorist-call-recordings', 'call.wav', '2026-07-15T11:00:00Z');
  const accepted = evaluateCatalogContract({
    sourceObjects: source,
    targetObjects: [...source, live, recording],
    liveGrowthBuckets: ['motorist-call-recordings', 'rental-photos'],
    rootAnchorBucket: 'rental-photos',
    snapshotCutoffUtc: '2026-07-14T18:44:45Z',
    anchoredNames: ['live.jpg'],
  });
  assert.equal(accepted.targetOnly.length, 2);
  assert.equal(accepted.targetOnlyKeysetMatchesDatabase, true);

  assert.throws(() => evaluateCatalogContract({
    sourceObjects: source,
    targetObjects: [],
    liveGrowthBuckets: ['motorist-call-recordings', 'rental-photos'],
    rootAnchorBucket: 'rental-photos',
    snapshotCutoffUtc: '2026-07-14T18:44:45Z',
    anchoredNames: [],
  }), /missing a source Storage object/);
  assert.throws(() => evaluateCatalogContract({
    sourceObjects: source,
    targetObjects: [...source, storageObject('vehicle-photos', 'extra.jpg', '2026-07-15T10:00:00Z')],
    liveGrowthBuckets: ['motorist-call-recordings', 'rental-photos'],
    rootAnchorBucket: 'rental-photos',
    snapshotCutoffUtc: '2026-07-14T18:44:45Z',
    anchoredNames: [],
  }), /growth outside/);
  assert.throws(() => evaluateCatalogContract({
    sourceObjects: source,
    targetObjects: [...source, storageObject('rental-photos', 'old-extra.jpg', '2026-07-14T10:00:00Z')],
    liveGrowthBuckets: ['motorist-call-recordings', 'rental-photos'],
    rootAnchorBucket: 'rental-photos',
    snapshotCutoffUtc: '2026-07-14T18:44:45Z',
    anchoredNames: [],
  }), /keyset differs/);
  assert.throws(() => evaluateCatalogContract({
    sourceObjects: source,
    targetObjects: [...source, live],
    liveGrowthBuckets: ['motorist-call-recordings', 'rental-photos'],
    rootAnchorBucket: 'rental-photos',
    snapshotCutoffUtc: '2026-07-14T18:44:45Z',
    anchoredNames: ['missing.jpg'],
  }), /anchored root-bucket Storage object is missing/);

  assert.throws(() => evaluateCatalogContract({
    sourceObjects: source,
    targetObjects: [...source, recording],
    liveGrowthBuckets: ['motorist-call-recordings', 'rental-photos'],
    rootAnchorBucket: 'rental-photos',
    snapshotCutoffUtc: '2026-07-14T18:44:45Z',
    anchoredNames: ['call.wav'],
  }), /anchored root-bucket Storage object is missing/);
});

test('target-only recordings require exact database, call, size, and checksum evidence', () => {
  const object = storageObject('motorist-call-recordings', 'call.wav', '2026-07-15T11:00:00Z', 10);
  const checksum = 'a'.repeat(64);
  const evidence = [{
    callStatus: 'ended',
    checksum,
    fetchedAt: Date.parse('2026-07-15T11:01:00Z'),
    hasCall: true,
    path: 'call.wav',
    provider: 'viptel',
    recordingCreatedAt: Date.parse('2026-07-15T10:59:00Z'),
    size: 10,
    status: 'available',
  }];
  const contract = {
    bucket: 'motorist-call-recordings',
    provider: 'viptel',
    requiredRecordingStatus: 'available',
    requiredCallStatus: 'ended',
  };
  const args = {
    targetOnly: [object],
    targetPayloadHashes: new Map([[JSON.stringify([object.bucket, object.name]), checksum]]),
    recordingEvidence: evidence,
    recordingContract: contract,
    operationalBaselineUtc: '2026-07-14T18:47:01Z',
    snapshotCutoffUtc: '2026-07-14T18:44:45Z',
  };
  assert.equal(validateRecordingGrowth(args), true);
  assert.throws(() => validateRecordingGrowth({ ...args, recordingEvidence: [] }), /no database evidence/);
  assert.throws(() => validateRecordingGrowth({
    ...args,
    recordingEvidence: [
      ...evidence,
      {
        ...evidence[0],
        checksum: 'b'.repeat(64),
        path: 'old-source.wav',
        recordingCreatedAt: Date.parse('2026-07-16T10:59:00Z'),
      },
    ],
  }), /database evidence has no target-only Storage object/);
  assert.throws(() => validateRecordingGrowth({
    ...args,
    recordingEvidence: [{ ...evidence[0], callStatus: 'ringing' }],
  }), /no ended call/);
  assert.throws(() => validateRecordingGrowth({
    ...args,
    recordingEvidence: [{ ...evidence[0], checksum: 'b'.repeat(64) }],
  }), /payload differs/);
  assert.throws(() => validateRecordingGrowth({
    ...args,
    recordingEvidence: [{ ...evidence[0], size: 9 }],
  }), /size differs/);
  const rejected = [
    {
      args: { ...args, recordingEvidence: [{ ...evidence[0], provider: 'other' }] },
      message: /provider differs/,
    },
    {
      args: { ...args, recordingEvidence: [{ ...evidence[0], status: 'pending' }] },
      message: /not available/,
    },
    {
      args: { ...args, recordingEvidence: [{ ...evidence[0], fetchedAt: Date.parse('2026-07-14T10:00:00Z') }] },
      message: /predates/,
    },
    {
      args: {
        ...args,
        targetOnly: [{ ...object, createdAt: Date.parse('2026-07-14T10:00:00Z') }],
      },
      message: /predates/,
    },
    {
      args: { ...args, recordingEvidence: [{ ...evidence[0], checksum: 'invalid' }] },
      message: /checksum evidence is invalid/,
    },
    {
      args: { ...args, targetPayloadHashes: new Map() },
      message: /payload differs/,
    },
  ];
  for (const candidate of rejected) {
    assert.throws(() => validateRecordingGrowth(candidate.args), candidate.message);
  }
});

test('bucket report fails closed on baseline drift and preserves gate schema', () => {
  const baseline = Object.fromEntries(BUCKETS.map((bucket) => [bucket, { objects: 0, bytes: 0 }]));
  const sourceTotals = aggregateFixture();
  const targetTotals = aggregateFixture();
  targetTotals['rental-photos'] = { count: 1, bytes: 10 };
  const accepted = evaluateBucketReports({
    baseline,
    sourceTotals,
    targetTotals,
    liveGrowthBuckets: ['motorist-call-recordings', 'rental-photos'],
    rootAnchorBucket: 'rental-photos',
    recordingBucket: 'motorist-call-recordings',
    targetOnlyCounts: { 'motorist-call-recordings': 0, 'rental-photos': 1 },
    targetOnlyKeysetMatchesDatabase: true,
    anchoredLiveContentMatches: true,
    transitionAnchoredContentMatches: true,
    recordingMetadataContractMatches: true,
  });
  assert.equal(accepted.status, 'pass');
  assert.deepEqual(Object.keys(accepted.buckets), BUCKETS);
  assert.equal(accepted.buckets['rental-photos'].target_extra_count, 1);
  assert.equal(accepted.buckets['vehicle-photos'].matches, true);

  const changedBaseline = structuredClone(baseline);
  changedBaseline['vehicle-photos'].objects = 1;
  assert.equal(evaluateBucketReports({
    baseline: changedBaseline,
    sourceTotals,
    targetTotals,
    liveGrowthBuckets: ['motorist-call-recordings', 'rental-photos'],
    rootAnchorBucket: 'rental-photos',
    recordingBucket: 'motorist-call-recordings',
    targetOnlyCounts: { 'motorist-call-recordings': 0, 'rental-photos': 1 },
    targetOnlyKeysetMatchesDatabase: true,
    anchoredLiveContentMatches: true,
    transitionAnchoredContentMatches: true,
    recordingMetadataContractMatches: true,
  }).status, 'fail');
});

test('cutover gate uses read-only Storage REST and never requires source S3 credentials', () => {
  const gate = readFileSync('deploy/supabase/validate-cutover-gate.zsh', 'utf8');
  const wrapper = readFileSync('deploy/supabase/validate-storage-rest.zsh', 'utf8');
  const validator = readFileSync('deploy/bin/validate-storage-rest.mjs', 'utf8');
  const managementHelper = readFileSync('deploy/supabase/management-api-readonly.zsh', 'utf8');

  assert.match(gate, /validate-storage-rest\.zsh/);
  assert.doesNotMatch(gate, /copy-storage-snapshot\.zsh/);
  assert.doesNotMatch(wrapper, /SOURCE_STORAGE_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)/);
  assert.match(wrapper, /SOURCE_DB_VALIDATION_MODE:-database_url.*management_api_read_only/s);
  assert.match(validator, /read_only: true/);
  assert.match(validator, /storage\/v1\/object\/authenticated/);
  assert.match(validator, /DOWNLOAD_CONCURRENCY = 6/);
  assert.ok([...validator.matchAll(/redirect: 'error'/g)].length >= 2);
  assert.match(validator, /pg_db_role_setting/);
  assert.match(validator, /snapshot manifest differs from the continuity anchor/);
  assert.match(validator, /snapshotManifestSha256: continuityAnchor\.evidence\.snapshotManifestSha256/);
  assert.match(validator, /metadata::text as metadata_text/);
  assert.match(validator, /Opakujem záverečnú obsahovú kontrolu targetu/);
  assert.match(managementHelper, /pg_db_role_setting/);
  assert.doesNotMatch(managementHelper, /current_setting\('default_transaction_read_only'\)/);
  assert.doesNotMatch(validator, /bootstrap-runtime\.mjs/);
  assert.match(wrapper, /! -L "\$\{SECRET_FILE\}"/);
  assert.match(wrapper, /stat -f '%l'/);
  assert.match(wrapper, /stat -f '%u'/);
  assert.ok(wrapper.indexOf('set +x') < wrapper.indexOf('source "${SECRET_FILE}"'));
  assert.ok(wrapper.indexOf('set +v') < wrapper.indexOf('source "${SECRET_FILE}"'));
  assert.match(validator, /parseKeyValueText\(manifest\)/);
  assert.doesNotMatch(validator, /parseKeyValueFile/);
});
