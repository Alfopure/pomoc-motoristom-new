#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const TARGET_REF = 'sjcsrygkkmersoczpunh';
const TARGET_REGION = 'eu-central-1';
const RENTALS_SITE = 'https://pomoc-motoristom-lovat.vercel.app';
const DISPATCH_CALLBACKS = [
  'https://dispecing.linkapomoci.sk/auth/callback',
  'https://dev.dispecing.linkapomoci.sk/auth/callback',
];

function requireCondition(condition, message) {
  if (!condition) throw new Error(`AUTH_REDIRECT_FAILED: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function request(path, token, options = {}) {
  const response = await fetch(`https://api.supabase.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  requireCondition(response.ok && body && typeof body === 'object', `Management API returned HTTP ${response.status}`);
  return body;
}

function redirects(value) {
  requireCondition(typeof value === 'string', 'uri_allow_list is not a string');
  return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
}

async function main(argv) {
  const [receiptPath] = argv;
  const token = process.env.TARGET_SUPABASE_ACCESS_TOKEN;
  requireCondition(Boolean(receiptPath && token), 'receipt path and target access token are required');
  const project = await request(`/v1/projects/${TARGET_REF}`, token);
  requireCondition(project.ref === TARGET_REF && project.region === TARGET_REGION, 'target project identity or region differs');
  const before = await request(`/v1/projects/${TARGET_REF}/config/auth`, token);
  requireCondition(before.site_url === RENTALS_SITE, 'Rentals site_url must remain unchanged');
  const beforeRedirects = redirects(before.uri_allow_list);
  requireCondition(beforeRedirects.includes(RENTALS_SITE), 'Rentals redirect is missing before update');
  requireCondition(beforeRedirects.includes(`${RENTALS_SITE}/**`), 'Rentals wildcard redirect is missing before update');
  requireCondition(beforeRedirects.every((entry) => !entry.includes('jcwbiulwuwyrnmzjjbgr')), 'source project URL is present');
  const afterRedirects = [...new Set([...beforeRedirects, ...DISPATCH_CALLBACKS])];
  if (afterRedirects.length !== beforeRedirects.length) {
    await request(`/v1/projects/${TARGET_REF}/config/auth`, token, {
      method: 'PATCH',
      body: JSON.stringify({ uri_allow_list: afterRedirects.join(',') }),
    });
  }
  const verified = await request(`/v1/projects/${TARGET_REF}/config/auth`, token);
  const verifiedRedirects = redirects(verified.uri_allow_list);
  requireCondition(verified.site_url === RENTALS_SITE, 'Rentals site_url changed during update');
  requireCondition(beforeRedirects.every((entry) => verifiedRedirects.includes(entry)), 'an existing redirect was removed');
  requireCondition(
    DISPATCH_CALLBACKS.every((callback) => verifiedRedirects.includes(callback)),
    'dispatch callbacks were not persisted',
  );
  requireCondition(verifiedRedirects.every((entry) => !entry.includes('jcwbiulwuwyrnmzjjbgr')), 'source project URL is present after update');

  const receipt = {
    schemaVersion: 2,
    performedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    targetProjectRef: TARGET_REF,
    targetRegion: TARGET_REGION,
    changed: afterRedirects.length !== beforeRedirects.length,
    siteUrlPreserved: true,
    existingRedirectsPreserved: true,
    dispatchCallbackPresent: true,
    dispatchCallbacksPresent: true,
    dispatchCallbackCount: DISPATCH_CALLBACKS.length,
    beforeRedirectCount: beforeRedirects.length,
    afterRedirectCount: verifiedRedirects.length,
    beforeRedirectSetSha256: sha256([...beforeRedirects].sort().join('\n')),
    afterRedirectSetSha256: sha256([...verifiedRedirects].sort().join('\n')),
    sourceProjectUrlPresent: false,
  };
  const output = resolve(receiptPath);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const descriptor = openSync(
    output,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  process.stdout.write(`${JSON.stringify({
    status: 'verified',
    changed: receipt.changed,
    existingRedirectsPreserved: true,
    dispatchCallbackPresent: true,
    dispatchCallbacksPresent: true,
    receipt: output,
  })}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
