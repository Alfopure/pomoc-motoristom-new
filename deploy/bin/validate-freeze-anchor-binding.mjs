#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readSecureFileSnapshot,
  readSecureJsonSnapshot,
} from './secure-file-snapshot.mjs';

const SOURCE_REF = 'jcwbiulwuwyrnmzjjbgr';
const TARGET_REF = 'sjcsrygkkmersoczpunh';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function requireCondition(condition, message) {
  if (!condition) throw new Error(`FREEZE_ANCHOR_BINDING_FAILED: ${message}`);
}

function parseKeyValues(contents, label, { manifest = false } = {}) {
  const values = {};
  for (const [index, line] of contents.toString('utf8').split('\n').entries()) {
    if (!line) continue;
    if (manifest && /^[a-z0-9_]+:$/.test(line)) break;
    const separator = line.indexOf('=');
    requireCondition(separator > 0, `${label}:${index + 1} is not KEY=value`);
    const key = line.slice(0, separator);
    requireCondition(/^[a-z0-9_]+$/.test(key), `${label}:${index + 1} has an invalid key`);
    requireCondition(!Object.hasOwn(values, key), `${label} contains duplicate ${key}`);
    values[key] = line.slice(separator + 1);
  }
  return values;
}

function strictUtc(value, label) {
  requireCondition(typeof value === 'string' && UTC_PATTERN.test(value), `${label} is not strict UTC`);
  const timestamp = Date.parse(value);
  requireCondition(Number.isFinite(timestamp), `${label} is invalid`);
  requireCondition(
    new Date(timestamp).toISOString().replace('.000Z', 'Z') === value,
    `${label} is not canonical UTC`,
  );
  return value;
}

function requiredSha256(value, label) {
  requireCondition(typeof value === 'string' && SHA256_PATTERN.test(value), `${label} is invalid`);
  return value;
}

export function validateFreezeAnchorBinding({
  root: rootArgument,
  policyPath: policyArgument,
  anchorPath: anchorArgument,
  freezeReceiptPath: freezeReceiptArgument,
  snapshotManifestPath: snapshotManifestArgument,
  configManifestPath: configManifestArgument = null,
}) {
  const root = realpathSync(resolve(rootArgument));
  const policySnapshot = readSecureJsonSnapshot(resolve(policyArgument), { trustedRoot: root });
  const anchorSnapshot = readSecureJsonSnapshot(resolve(anchorArgument), {
    trustedRoot: root,
    privateFile: true,
  });
  const freezeSnapshot = readSecureFileSnapshot(resolve(freezeReceiptArgument), {
    trustedRoot: root,
    privateFile: true,
  });
  const snapshotManifestSnapshot = readSecureFileSnapshot(resolve(snapshotManifestArgument), {
    trustedRoot: root,
    privateFile: true,
  });
  const configManifestSnapshot = configManifestArgument === null
    ? null
    : readSecureFileSnapshot(resolve(configManifestArgument), {
      trustedRoot: root,
      privateFile: true,
    });

  const policy = policySnapshot.value;
  const anchor = anchorSnapshot.value;
  const freeze = parseKeyValues(freezeSnapshot.contents, 'freeze receipt');
  const snapshotManifest = parseKeyValues(
    snapshotManifestSnapshot.contents,
    'snapshot manifest',
    { manifest: true },
  );
  const configManifest = configManifestSnapshot === null
    ? null
    : parseKeyValues(configManifestSnapshot.contents, 'config manifest', { manifest: true });

  requireCondition(Number.isInteger(policy.schemaVersion) && policy.schemaVersion >= 12, 'policy schema is older than v12');
  requireCondition(typeof policy.snapshotId === 'string' && /^\d{8}T\d{6}Z$/.test(policy.snapshotId), 'policy snapshot id is invalid');
  requireCondition(policy.sourceProjectRef === SOURCE_REF, 'policy source differs');
  requireCondition(policy.targetProjectRef === TARGET_REF, 'policy target differs');
  const operationalBaselineUtc = strictUtc(
    policy.publicData?.operationalContinuity?.operationalBaselineUtc,
    'policy operational baseline',
  );

  requireCondition(anchor.schemaVersion === 1, 'base continuity anchor schema differs');
  requireCondition(anchor.snapshotId === policy.snapshotId, 'base continuity anchor snapshot differs');
  requireCondition(anchor.sourceProjectRef === SOURCE_REF, 'base continuity anchor source differs');
  requireCondition(anchor.targetProjectRef === TARGET_REF, 'base continuity anchor target differs');
  const anchoredFreezeSha256 = requiredSha256(
    anchor.evidence?.sourceFreezeReceiptSha256,
    'base continuity anchor freeze receipt hash',
  );
  const anchoredSnapshotManifestSha256 = requiredSha256(
    anchor.evidence?.snapshotManifestSha256,
    'base continuity anchor snapshot manifest hash',
  );

  requireCondition(freeze.state === 'frozen', 'source freeze receipt is not frozen');
  requireCondition(freeze.snapshot_id === policy.snapshotId, 'source freeze receipt snapshot differs');
  requireCondition(freeze.source_project_ref === SOURCE_REF, 'source freeze receipt source differs');
  requireCondition(freeze.target_project_ref === TARGET_REF, 'source freeze receipt target differs');
  requireCondition(freeze.source_restart_verified === 'true', 'source restart was not verified');
  requireCondition(
    freeze.external_writers_attested_stopped === 'true',
    'external writers were not attested stopped',
  );
  requireCondition(
    strictUtc(freeze.frozen_at_utc, 'source freeze timestamp') === operationalBaselineUtc,
    'operational baseline differs from the source freeze timestamp',
  );

  requireCondition(snapshotManifest.snapshot_id === policy.snapshotId, 'snapshot manifest id differs');
  requireCondition(snapshotManifest.source_project_ref === SOURCE_REF, 'snapshot manifest source differs');
  requireCondition(
    strictUtc(snapshotManifest.source_write_frozen_at_utc, 'snapshot manifest freeze timestamp')
      === operationalBaselineUtc,
    'snapshot manifest freeze timestamp differs from the operational baseline',
  );
  requireCondition(
    snapshotManifest.source_freeze_receipt_sha256 === freezeSnapshot.sha256,
    'snapshot manifest does not bind the source freeze receipt',
  );
  requireCondition(
    freezeSnapshot.sha256 === anchoredFreezeSha256,
    'source freeze receipt differs from the immutable base continuity anchor',
  );
  requireCondition(
    snapshotManifestSnapshot.sha256 === anchoredSnapshotManifestSha256,
    'snapshot manifest differs from the immutable base continuity anchor',
  );

  let configManifestSha256 = null;
  if (configManifest !== null && configManifestSnapshot !== null) {
    const anchoredConfigManifestSha256 = requiredSha256(
      anchor.evidence?.configManifestSha256,
      'base continuity anchor config manifest hash',
    );
    requireCondition(configManifest.snapshot_id === policy.snapshotId, 'config manifest id differs');
    requireCondition(configManifest.source_project_ref === SOURCE_REF, 'config manifest source differs');
    requireCondition(configManifest.target_project_ref === TARGET_REF, 'config manifest target differs');
    requireCondition(
      configManifest.source_freeze_receipt_sha256 === freezeSnapshot.sha256,
      'config manifest does not bind the source freeze receipt',
    );
    requireCondition(
      configManifestSnapshot.sha256 === anchoredConfigManifestSha256,
      'config manifest differs from the immutable base continuity anchor',
    );
    configManifestSha256 = configManifestSnapshot.sha256;
  }

  return {
    status: 'pass_freeze_anchor_binding',
    snapshotId: policy.snapshotId,
    operationalBaselineUtc,
    sourceFreezeReceiptSha256: freezeSnapshot.sha256,
    snapshotManifestSha256: snapshotManifestSnapshot.sha256,
    configManifestSha256,
  };
}

function main(argv) {
  requireCondition(
    argv.length === 5 || argv.length === 6,
    'usage: validate-freeze-anchor-binding.mjs ROOT POLICY BASE_ANCHOR FREEZE_RECEIPT SNAPSHOT_MANIFEST [CONFIG_MANIFEST]',
  );
  const [
    root,
    policyPath,
    anchorPath,
    freezeReceiptPath,
    snapshotManifestPath,
    configManifestPath = null,
  ] = argv;
  const result = validateFreezeAnchorBinding({
    root,
    policyPath,
    anchorPath,
    freezeReceiptPath,
    snapshotManifestPath,
    configManifestPath,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
