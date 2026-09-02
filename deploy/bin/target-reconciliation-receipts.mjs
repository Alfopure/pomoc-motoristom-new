import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { readSecureFileSnapshot } from './secure-file-snapshot.mjs';

const SOURCE_REF = 'jcwbiulwuwyrnmzjjbgr';
const TARGET_REF = 'sjcsrygkkmersoczpunh';
const RECEIPT_PATH_PATTERN = /^deploy\/supabase\/reconciliation-receipts\/[a-z0-9-]+-\d{8}T\d{6}Z[.]json$/;
const COMMON_KEYS = [
  'action',
  'capturedAtUtc',
  'privacy',
  'quarantineFile',
  'quarantineSha256',
  'schemaVersion',
  'sourceDeleted',
  'sourceFrozen',
  'sourceProjectRef',
  'targetEnabledJobsAfter',
  'targetProjectRef',
];
const ACTIONS = {
  delete_unreferenced_target_rental_photo_after_encrypted_quarantine: {
    fields: [
      'reconciledObjectCount',
      'sourceMatchCount',
      'targetMissingMetadataCountAfter',
      'targetOrphanCountAfter',
    ],
    privacy: 'Aggregate reconciliation evidence only; no object path, row identifier, PII, credentials, or payload hash.',
  },
  delete_redundant_target_rental_photo_row_after_encrypted_quarantine: {
    fields: [
      'reconciledRowCount',
      'storageObjectsChanged',
      'targetDuplicateGroupsAfter',
      'targetMissingObjectsAfter',
      'targetStorageOrphansAfter',
    ],
    privacy: 'Aggregate reconciliation evidence only; no path, row identifier, PII, credentials, or row hash.',
  },
};

function fail(message) {
  throw new Error(`TARGET_RECONCILIATION_RECEIPT_FAILED: ${message}`);
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function strictUtc(value, label) {
  requireCondition(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value),
    `${label} is not strict UTC`,
  );
  const timestamp = Date.parse(value);
  requireCondition(Number.isFinite(timestamp), `${label} is invalid`);
  requireCondition(
    new Date(timestamp).toISOString().replace('.000Z', 'Z') === value,
    `${label} is not canonical UTC`,
  );
  return timestamp;
}

function validateCommonReceipt(receipt) {
  const actionContract = ACTIONS[receipt?.action];
  requireCondition(actionContract, 'receipt action is not approved');
  requireCondition(
    same(Object.keys(receipt).sort(), [...COMMON_KEYS, ...actionContract.fields].sort()),
    'receipt fields differ from the privacy contract',
  );
  requireCondition(receipt.privacy === actionContract.privacy, 'receipt privacy marker differs');
  requireCondition(receipt.schemaVersion === 1, 'receipt schema differs');
  requireCondition(receipt.sourceProjectRef === SOURCE_REF, 'receipt source differs');
  requireCondition(receipt.targetProjectRef === TARGET_REF, 'receipt target differs');
  requireCondition(receipt.sourceFrozen === true, 'receipt did not preserve the source freeze');
  requireCondition(receipt.sourceDeleted === false, 'receipt permits source deletion');
  requireCondition(receipt.targetEnabledJobsAfter === 0, 'receipt left a target job enabled');
  requireCondition(/^[0-9a-f]{64}$/.test(receipt.quarantineSha256 ?? ''), 'quarantine checksum is invalid');
  requireCondition(
    typeof receipt.quarantineFile === 'string'
      && /^\.context\/migration\/quarantine\/[a-z0-9-]+-\d{8}T\d{6}Z[.]json[.]enc$/.test(receipt.quarantineFile),
    'quarantine path is invalid',
  );
}

function validateActionReceipt(receipt) {
  if (receipt.action === 'delete_unreferenced_target_rental_photo_after_encrypted_quarantine') {
    requireCondition(receipt.sourceMatchCount === 0, 'orphan receipt matched the source');
    requireCondition(receipt.reconciledObjectCount === 1, 'orphan receipt object count differs');
    requireCondition(receipt.targetOrphanCountAfter === 0, 'orphan receipt left a live orphan');
    requireCondition(receipt.targetMissingMetadataCountAfter === 0, 'orphan receipt left missing metadata');
    return;
  }
  requireCondition(receipt.reconciledRowCount === 1, 'duplicate receipt row count differs');
  requireCondition(receipt.storageObjectsChanged === 0, 'duplicate receipt changed Storage payloads');
  requireCondition(receipt.targetDuplicateGroupsAfter === 1, 'duplicate receipt changed the inherited duplicate baseline');
  requireCondition(receipt.targetStorageOrphansAfter === 32, 'duplicate receipt changed the inherited orphan baseline');
  requireCondition(receipt.targetMissingObjectsAfter === 0, 'duplicate receipt left a missing object');
}

function requireExactKeys(value, expected, label) {
  requireCondition(
    value && typeof value === 'object' && !Array.isArray(value)
      && same(Object.keys(value).sort(), [...expected].sort()),
    `${label} schema differs`,
  );
}

function validateDecryptedQuarantine(receipt, encryptedContents) {
  requireCondition(
    typeof process.env.MIGRATION_ARCHIVE_PASSPHRASE === 'string'
      && process.env.MIGRATION_ARCHIVE_PASSPHRASE.length > 0,
    'archive passphrase is unavailable for quarantine verification',
  );
  const decrypted = spawnSync(
    'openssl',
    [
      'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000',
      '-pass', 'env:MIGRATION_ARCHIVE_PASSPHRASE',
    ],
    {
      input: encryptedContents,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 128 * 1024 * 1024,
    },
  );
  requireCondition(decrypted.status === 0, 'quarantine could not be decrypted');
  let value;
  try {
    value = JSON.parse(decrypted.stdout);
  } catch {
    fail('quarantine plaintext is not JSON');
  }
  requireCondition(value.schemaVersion === 1, 'quarantine schema version differs');
  requireCondition(value.projectRef === TARGET_REF, 'quarantine target differs');

  if (receipt.action === 'delete_redundant_target_rental_photo_row_after_encrypted_quarantine') {
    requireExactKeys(value, ['projectRef', 'rows', 'schemaVersion', 'table'], 'row quarantine');
    requireCondition(value.table === 'public.rental_photos', 'row quarantine table differs');
    requireCondition(Array.isArray(value.rows) && value.rows.length === 2, 'row quarantine record count differs');
    for (const row of value.rows) {
      requireExactKeys(
        row,
        ['file_name', 'id', 'photo_type', 'rental_id', 'storage_path', 'uploaded_at'],
        'row quarantine record',
      );
      requireCondition(Object.values(row).every((item) => typeof item === 'string'), 'row quarantine field type differs');
      requireCondition(Number.isFinite(Date.parse(row.uploaded_at)), 'row quarantine timestamp is invalid');
    }
    return;
  }

  requireExactKeys(
    value,
    [
      'bucket', 'createdAt', 'mimetype', 'name', 'payloadBase64', 'payloadSha256',
      'projectRef', 'schemaVersion', 'updatedAt', 'version',
    ],
    'object quarantine',
  );
  requireCondition(value.bucket === 'rental-photos', 'object quarantine bucket differs');
  for (const field of ['createdAt', 'mimetype', 'name', 'payloadBase64', 'payloadSha256', 'updatedAt', 'version']) {
    requireCondition(typeof value[field] === 'string' && value[field].length > 0, `object quarantine ${field} is invalid`);
  }
  requireCondition(Number.isFinite(Date.parse(value.createdAt)), 'object quarantine creation time is invalid');
  requireCondition(Number.isFinite(Date.parse(value.updatedAt)), 'object quarantine update time is invalid');
  requireCondition(/^[0-9a-f]{64}$/.test(value.payloadSha256), 'object quarantine payload checksum is invalid');
  const payload = Buffer.from(value.payloadBase64, 'base64');
  requireCondition(payload.toString('base64') === value.payloadBase64, 'object quarantine payload encoding is invalid');
  requireCondition(sha256(payload) === value.payloadSha256, 'object quarantine payload checksum differs');
}

function verifyPrivateQuarantine(receipt, repositoryRoot) {
  const quarantineDirectory = resolve(repositoryRoot, '.context/migration/quarantine');
  const quarantinePath = resolve(repositoryRoot, receipt.quarantineFile);
  let realDirectory;
  try {
    realDirectory = realpathSync(dirname(quarantinePath));
  } catch {
    fail('quarantine directory is unavailable');
  }
  requireCondition(realDirectory === realpathSync(quarantineDirectory), 'quarantine escaped its private directory');
  const snapshot = readSecureFileSnapshot(quarantinePath, {
    trustedRoot: repositoryRoot,
    privateFile: true,
    ownerUid: typeof process.getuid === 'function' ? process.getuid() : null,
  });
  requireCondition(snapshot.sha256 === receipt.quarantineSha256, 'quarantine checksum differs');
  validateDecryptedQuarantine(receipt, snapshot.contents);
}

export function validateTargetReconciliationReceipts(
  policy,
  policyPath,
  watermarkUtc,
  { requirePrivateQuarantine = false } = {},
) {
  const entries = policy.publicData?.approvedTargetReconciliations ?? [];
  requireCondition(Array.isArray(entries), 'approved reconciliation list is invalid');
  if (entries.length === 0) return { files: [], hashes: [] };
  requireCondition(entries.length === 2, 'expected exactly two target reconciliation receipts');
  const repositoryRoot = resolve(dirname(policyPath), '../..');
  const receiptDirectory = resolve(repositoryRoot, 'deploy/supabase/reconciliation-receipts');
  const watermarkTime = strictUtc(watermarkUtc, 'watermark');
  const seenActions = new Set();
  const files = [];
  const hashes = [];
  for (const entry of entries) {
    requireCondition(RECEIPT_PATH_PATTERN.test(entry?.receiptPath ?? ''), 'receipt path is invalid');
    requireCondition(/^[0-9a-f]{64}$/.test(entry?.receiptSha256 ?? ''), 'policy receipt checksum is invalid');
    const path = resolve(repositoryRoot, entry.receiptPath);
    requireCondition(realpathSync(dirname(path)) === realpathSync(receiptDirectory), 'receipt escaped its directory');
    const snapshot = readSecureFileSnapshot(path, { trustedRoot: repositoryRoot });
    requireCondition(snapshot.sha256 === entry.receiptSha256, 'receipt checksum differs');
    const receipt = JSON.parse(snapshot.contents.toString('utf8'));
    validateCommonReceipt(receipt);
    validateActionReceipt(receipt);
    requireCondition(!seenActions.has(receipt.action), 'receipt action is duplicated');
    seenActions.add(receipt.action);
    requireCondition(strictUtc(receipt.capturedAtUtc, 'receipt capture time') <= watermarkTime, 'receipt is newer than the watermark');
    if (requirePrivateQuarantine) verifyPrivateQuarantine(receipt, repositoryRoot);
    files.push(basename(path));
    hashes.push(entry.receiptSha256);
  }
  requireCondition(seenActions.size === 2, 'approved reconciliation action set differs');
  return { files, hashes };
}
