import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const helper = resolve('deploy/bin/validate-freeze-anchor-binding.mjs');
const snapshotId = '20260714T184445Z';
const baseline = '2026-07-14T18:47:01Z';
const sourceRef = 'jcwbiulwuwyrnmzjjbgr';
const targetRef = 'sjcsrygkkmersoczpunh';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function write(path, contents, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode });
}

function manifest({ freezeSha256, config = false, extra = '' }) {
  const lines = [
    `source_project_ref=${sourceRef}`,
    ...(config ? [`target_project_ref=${targetRef}`] : []),
    `snapshot_id=${snapshotId}`,
    ...(!config ? [`source_write_frozen_at_utc=${baseline}`] : []),
    `source_freeze_receipt_sha256=${freezeSha256}`,
    ...(extra ? [extra] : []),
    'plaintext_sha256:',
    `${'0'.repeat(64)}  evidence.enc`,
    '',
  ];
  return lines.join('\n');
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'motorist-freeze-binding-')));
  const paths = {
    root,
    policy: join(root, 'deploy/supabase/live-target-continuity-policy.json'),
    anchor: join(root, '.context/migration/continuity/anchor.json'),
    freeze: join(root, '.context/migration/source-freeze', `${snapshotId}.env`),
    snapshotManifest: join(root, '.context/migration/snapshots', snapshotId, 'MANIFEST'),
    configManifest: join(root, '.context/migration/config-snapshots', snapshotId, 'MANIFEST'),
  };
  const freeze = [
    'state=frozen',
    `snapshot_id=${snapshotId}`,
    `source_project_ref=${sourceRef}`,
    `target_project_ref=${targetRef}`,
    `frozen_at_utc=${baseline}`,
    'source_restart_verified=true',
    'external_writers_attested_stopped=true',
    '',
  ].join('\n');
  const freezeSha256 = sha256(freeze);
  const snapshotManifest = manifest({ freezeSha256 });
  const configManifest = manifest({ freezeSha256, config: true });
  const policy = {
    schemaVersion: 12,
    snapshotId,
    sourceProjectRef: sourceRef,
    targetProjectRef: targetRef,
    publicData: {
      operationalContinuity: { operationalBaselineUtc: baseline },
    },
  };
  const anchor = {
    schemaVersion: 1,
    snapshotId,
    sourceProjectRef: sourceRef,
    targetProjectRef: targetRef,
    evidence: {
      sourceFreezeReceiptSha256: freezeSha256,
      snapshotManifestSha256: sha256(snapshotManifest),
      configManifestSha256: sha256(configManifest),
    },
  };
  write(paths.policy, `${JSON.stringify(policy)}\n`, 0o644);
  write(paths.anchor, `${JSON.stringify(anchor)}\n`);
  write(paths.freeze, freeze);
  write(paths.snapshotManifest, snapshotManifest);
  write(paths.configManifest, configManifest);
  return paths;
}

function run(paths, { withConfig = true } = {}) {
  return spawnSync('node', [
    helper,
    paths.root,
    paths.policy,
    paths.anchor,
    paths.freeze,
    paths.snapshotManifest,
    ...(withConfig ? [paths.configManifest] : []),
  ], { encoding: 'utf8' });
}

test('freeze binding accepts the exact receipt and manifests anchored by the continuity trust root', (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { recursive: true, force: true }));
  const result = run(paths);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'pass_freeze_anchor_binding');
  assert.equal(report.operationalBaselineUtc, baseline);
});

test('freeze binding rejects a coordinated receipt and manifest replacement not present in the base anchor', (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { recursive: true, force: true }));
  const replacedFreeze = `${readFileSync(paths.freeze, 'utf8')}replacement_marker=1\n`;
  const replacedFreezeSha256 = sha256(replacedFreeze);
  write(paths.freeze, replacedFreeze);
  write(paths.snapshotManifest, manifest({ freezeSha256: replacedFreezeSha256 }));
  write(paths.configManifest, manifest({ freezeSha256: replacedFreezeSha256, config: true }));

  const result = run(paths);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /differs from the immutable base continuity anchor/);
});

test('freeze binding rejects snapshot or config manifest drift even when the receipt hash is unchanged', (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { recursive: true, force: true }));
  const freezeSha256 = sha256(readFileSync(paths.freeze));
  write(paths.snapshotManifest, manifest({ freezeSha256, extra: 'replacement_marker=1' }));
  let result = run(paths);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /snapshot manifest differs from the immutable base continuity anchor/);

  const originalAnchor = JSON.parse(readFileSync(paths.anchor, 'utf8'));
  originalAnchor.evidence.snapshotManifestSha256 = sha256(readFileSync(paths.snapshotManifest));
  write(paths.anchor, `${JSON.stringify(originalAnchor)}\n`);
  write(paths.configManifest, manifest({ freezeSha256, config: true, extra: 'replacement_marker=1' }));
  result = run(paths);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /config manifest differs from the immutable base continuity anchor/);
});

test('freeze binding fails closed when the operational baseline is missing or differs', (t) => {
  const paths = fixture();
  t.after(() => rmSync(paths.root, { recursive: true, force: true }));
  const policy = JSON.parse(readFileSync(paths.policy, 'utf8'));
  delete policy.publicData.operationalContinuity.operationalBaselineUtc;
  write(paths.policy, `${JSON.stringify(policy)}\n`, 0o644);
  let result = run(paths, { withConfig: false });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /policy operational baseline is not strict UTC/);

  policy.publicData.operationalContinuity.operationalBaselineUtc = '2026-07-14T18:47:02Z';
  write(paths.policy, `${JSON.stringify(policy)}\n`, 0o644);
  result = run(paths, { withConfig: false });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /operational baseline differs from the source freeze timestamp/);
});
