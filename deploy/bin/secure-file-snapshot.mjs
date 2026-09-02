import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BUFFER = 256 * 1024 * 1024 + 1024 * 1024;
const HELPER = fileURLToPath(new URL('./secure_file_snapshot.py', import.meta.url));

function fail(message) {
  throw new Error(`SECURE_FILE_SNAPSHOT_FAILED: ${message}`);
}

function runHelper(arguments_, { input } = {}) {
  const result = spawnSync('python3', [HELPER, ...arguments_], {
    cwd: dirname(HELPER),
    encoding: null,
    input,
    maxBuffer: MAX_BUFFER,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    const message = result.stderr?.toString('utf8').trim();
    fail(message || 'openat helper failed without an error message');
  }
  return result.stdout;
}

export function readSecureFileSnapshot(
  candidatePath,
  {
    trustedRoot,
    privateFile = false,
    ownerUid = null,
  },
) {
  const output = runHelper([
    'read',
    trustedRoot,
    candidatePath,
    privateFile ? '1' : '0',
    String(ownerUid ?? -1),
  ]);
  if (output.length < 4) fail('openat helper returned a truncated snapshot');
  const metadataLength = output.readUInt32BE(0);
  if (metadataLength < 2 || metadataLength > output.length - 4) {
    fail('openat helper returned invalid snapshot metadata');
  }
  let metadata;
  try {
    metadata = JSON.parse(output.subarray(4, 4 + metadataLength).toString('utf8'));
  } catch {
    fail('openat helper returned malformed snapshot metadata');
  }
  const contents = output.subarray(4 + metadataLength);
  const sha256 = createHash('sha256').update(contents).digest('hex');
  if (metadata.sha256 !== sha256 || !Number.isInteger(metadata.mode)) {
    fail('openat helper snapshot metadata does not match its bytes');
  }
  return { contents, mode: metadata.mode, sha256 };
}

export function readSecureJsonSnapshot(candidatePath, options) {
  const snapshot = readSecureFileSnapshot(candidatePath, options);
  return { ...snapshot, value: JSON.parse(snapshot.contents.toString('utf8')) };
}

export function writeExclusiveSecureFile(candidatePath, contents, { trustedRoot, mode = 0o600 }) {
  const input = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const output = runHelper(
    ['write', trustedRoot, candidatePath, String(mode)],
    { input },
  );
  let metadata;
  try {
    metadata = JSON.parse(output.toString('utf8'));
  } catch {
    fail('openat helper returned malformed write metadata');
  }
  const sha256 = createHash('sha256').update(input).digest('hex');
  if (metadata.sha256 !== sha256) fail('openat helper write checksum differs');
  return { sha256 };
}
