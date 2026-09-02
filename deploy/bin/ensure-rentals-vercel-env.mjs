#!/usr/bin/env node

import { closeSync, constants, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const PROJECT_ID = 'prj_MzZcra1J8C2vyLJBwVvptPvl0aMD';
const PROJECT_NAME = 'pomoc-motoristom';
const TEAM_ID = 'team_56GjBnBw6zGSG83LJAnQCB8T';
const TARGET_REF = 'sjcsrygkkmersoczpunh';
const TARGET_URL = `https://${TARGET_REF}.supabase.co`;

function requireCondition(condition, message) {
  if (!condition) throw new Error(`RENTALS_VERCEL_ENV_FAILED: ${message}`);
}

async function request(path, token, options = {}) {
  const response = await fetch(`https://api.vercel.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  requireCondition(response.ok && body, `Vercel API returned HTTP ${response.status}`);
  return body;
}

async function probeTarget(publishableKey, serviceRoleKey) {
  const checks = [
    fetch(`${TARGET_URL}/auth/v1/settings`, {
      headers: { apikey: publishableKey },
      signal: AbortSignal.timeout(15_000),
    }),
    fetch(`${TARGET_URL}/rest/v1/motorist_profiles?select=id`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Range: '0-0',
        Prefer: 'count=exact',
      },
      signal: AbortSignal.timeout(15_000),
    }),
    fetch(`${TARGET_URL}/storage/v1/bucket`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      signal: AbortSignal.timeout(15_000),
    }),
  ];
  const responses = await Promise.all(checks);
  requireCondition(responses[0].status === 200, 'publishable key does not authenticate against target Auth');
  requireCondition(responses[1].status === 206, 'service key does not authenticate against target Data API');
  requireCondition(responses[2].status === 200, 'service key does not authenticate against target Storage');
}

function writeReceipt(descriptor, receipt) {
  writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  fsyncSync(descriptor);
}

async function main(argv) {
  const [receiptPath] = argv;
  const token = process.env.VERCEL_TOKEN;
  const publishableKey = process.env.RENTALS_SUPABASE_PUBLISHABLE_KEY;
  const serviceRoleKey = process.env.RENTALS_SUPABASE_SERVICE_ROLE_KEY;
  requireCondition(Boolean(receiptPath && token && publishableKey && serviceRoleKey), 'receipt path and credentials are required');
  requireCondition(!publishableKey.includes('jcwbiulwuwyrnmzjjbgr'), 'publishable value references source');
  requireCondition(!serviceRoleKey.includes('jcwbiulwuwyrnmzjjbgr'), 'service value references source');
  requireCondition(publishableKey !== serviceRoleKey, 'publishable and service keys must differ');

  const project = await request(`/v9/projects/${PROJECT_ID}?teamId=${TEAM_ID}`, token);
  requireCondition(project.id === PROJECT_ID && project.name === PROJECT_NAME && project.accountId === TEAM_ID, 'Vercel project identity differs');
  const listing = await request(`/v9/projects/${PROJECT_ID}/env?teamId=${TEAM_ID}`, token);
  requireCondition(Array.isArray(listing.envs), 'Vercel env listing is invalid');
  const desired = new Map([
    ['SUPABASE_URL', TARGET_URL],
    ['VITE_SUPABASE_URL', TARGET_URL],
    ['SUPABASE_ANON_KEY', publishableKey],
    ['VITE_SUPABASE_ANON_KEY', publishableKey],
    ['SUPABASE_SERVICE_ROLE_KEY', serviceRoleKey],
  ]);
  const updates = [];
  for (const [key, value] of desired) {
    const records = listing.envs.filter((entry) => entry.key === key && entry.target?.includes('production'));
    requireCondition(records.length === 1, `${key} must have exactly one production record`);
    const record = records[0];
    const target = Array.isArray(record.target) ? [...record.target] : [record.target];
    requireCondition(target.every((item) => typeof item === 'string') && target.includes('production'), `${key} has invalid target scope`);
    updates.push({ key, value, record, target });
  }
  await probeTarget(publishableKey, serviceRoleKey);

  const output = resolve(receiptPath);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const descriptor = openSync(
    output,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  const verifiedKeys = [];
  let mutationError;
  try {
    try {
      for (const { key, value, record, target } of updates) {
        const result = await request(
          `/v9/projects/${PROJECT_ID}/env/${encodeURIComponent(record.id)}?teamId=${TEAM_ID}`,
          token,
          {
            method: 'PATCH',
            body: JSON.stringify({
              target,
              type: 'sensitive',
              value,
              comment: 'Frankfurt Supabase continuity; verified 2026-07-15',
            }),
          },
        );
        requireCondition(result.key === key, `${key} update identity differs`);
        requireCondition(result.type === 'sensitive', `${key} is not sensitive after update`);
        const resultTarget = Array.isArray(result.target) ? result.target : [result.target];
        requireCondition(target.every((scope) => resultTarget.includes(scope)), `${key} target scope changed`);
        verifiedKeys.push(key);
      }
    } catch (error) {
      mutationError = error;
    }
    writeReceipt(descriptor, {
      schemaVersion: 2,
      status: mutationError ? 'partial_failure' : 'verified',
      performedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      projectId: PROJECT_ID,
      projectName: PROJECT_NAME,
      teamId: TEAM_ID,
      supabaseProjectRef: TARGET_REF,
      environment: 'production',
      targetCredentialProbesPassed: true,
      valuesDisplayed: false,
      redeployTriggered: false,
      updatedKeys: verifiedKeys.sort(),
      allRecordsSensitive: !mutationError,
      existingDeploymentChanged: false,
      requiresReconciliation: Boolean(mutationError),
    });
  } finally {
    closeSync(descriptor);
  }
  if (mutationError) throw mutationError;
  process.stdout.write(`${JSON.stringify({
    status: 'verified',
    project: PROJECT_NAME,
    updatedKeyCount: verifiedKeys.length,
    allRecordsSensitive: true,
    redeployTriggered: false,
    receipt: output,
  })}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
