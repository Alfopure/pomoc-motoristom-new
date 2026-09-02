import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  OPERATIONAL_BASELINE_UTC,
  OPERATIONAL_CONTINUITY_TABLES,
  validateOperationalContinuity,
  validatePreviousOperationalBoundedEvidence,
} from '../deploy/bin/validate-live-target-continuity.mjs';

const policy = JSON.parse(readFileSync('deploy/supabase/live-target-continuity-policy.json', 'utf8'));

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function evidence(table, { baseline = 2, live = 0 } = {}) {
  const total = baseline + live;
  return {
    total_count: total,
    baseline_count: baseline,
    baseline_key_digest: digest(`${table}:baseline-keys`),
    baseline_immutable_digest: digest(`${table}:baseline-content`),
    live_count: live,
    invalid_boundary_count: 0,
    watermarked_count: total,
    watermarked_key_digest: digest(`${table}:watermarked-keys:${total}`),
    watermarked_content_digest: digest(`${table}:watermarked-content:${total}`),
    post_watermark_count: 0,
    invalid_live_contract_count: 0,
  };
}

function operationalFixture() {
  const sourceTables = Object.fromEntries(
    OPERATIONAL_CONTINUITY_TABLES.map((table) => [table, evidence(table)]),
  );
  const growth = {
    motorist_call_events: 6,
    motorist_call_recordings: 1,
    motorist_calls: 55,
    motorist_integration_raw_events: 14,
  };
  const targetTables = Object.fromEntries(
    OPERATIONAL_CONTINUITY_TABLES.map((table) => [
      table,
      evidence(table, { live: growth[table] }),
    ]),
  );
  const anchorTables = Object.fromEntries(
    OPERATIONAL_CONTINUITY_TABLES.map((table) => [table, {
      watermarked_count: targetTables[table].watermarked_count,
      watermarked_key_digest: targetTables[table].watermarked_key_digest,
      watermarked_content_digest: targetTables[table].watermarked_content_digest,
    }]),
  );
  return {
    source: {
      operational_contract: structuredClone(policy.publicData.operationalContinuity),
      operational_tables: sourceTables,
    },
    target: {
      operational_contract: structuredClone(policy.publicData.operationalContinuity),
      operational_tables: targetTables,
    },
    anchor: { schemaVersion: 12, evidence: { public: { operationalTables: anchorTables } } },
    growth,
  };
}

test('v12 operational continuity accepts only policy-bound baseline-preserving growth', () => {
  const fixture = operationalFixture();
  assert.deepEqual(
    validateOperationalContinuity(fixture.source, fixture.target, policy, fixture.anchor),
    fixture.growth,
  );
});

test('v12 operational continuity fails closed on policy, table, or baseline drift', () => {
  const mutations = [
    ({ source }) => { source.operational_contract.operationalBaselineUtc = '2026-07-14T18:45:01Z'; },
    ({ source }) => { source.operational_contract.tables.motorist_calls.providers = ['other']; },
    ({ target }) => { target.operational_contract.tables.motorist_calls.statuses.push('answered'); },
    ({ source }) => { delete source.operational_tables.motorist_call_events; },
    ({ target }) => { delete target.operational_tables.motorist_call_recordings; },
    ({ source }) => {
      source.operational_tables.motorist_calls.live_count = 1;
      source.operational_tables.motorist_calls.total_count += 1;
    },
    ({ target }) => { target.operational_tables.motorist_calls.baseline_count += 1; },
    ({ target }) => { target.operational_tables.motorist_call_events.baseline_key_digest = digest('changed'); },
    ({ target }) => {
      target.operational_tables.motorist_call_recordings.baseline_immutable_digest = digest('changed');
    },
    ({ target }) => { target.operational_tables.motorist_integration_raw_events.invalid_boundary_count = 1; },
    ({ target }) => { target.operational_tables.motorist_call_events.invalid_live_contract_count = 1; },
  ];

  for (const mutate of mutations) {
    const fixture = operationalFixture();
    mutate(fixture);
    assert.throws(
      () => validateOperationalContinuity(fixture.source, fixture.target, policy, fixture.anchor),
      /LIVE_CONTINUITY_FAILED/,
    );
  }
});

test('v12 operational continuity fails closed on watermark loss, mutation, or late writes', () => {
  const mutations = [
    ({ target }) => { target.operational_tables.motorist_calls.watermarked_count -= 1; },
    ({ target }) => { target.operational_tables.motorist_call_events.watermarked_key_digest = digest('changed'); },
    ({ target }) => {
      target.operational_tables.motorist_call_recordings.watermarked_content_digest = digest('changed');
    },
    ({ target }) => { target.operational_tables.motorist_integration_raw_events.post_watermark_count = 1; },
    ({ anchor }) => { delete anchor.evidence.public.operationalTables.motorist_calls; },
  ];

  for (const mutate of mutations) {
    const fixture = operationalFixture();
    mutate(fixture);
    assert.throws(
      () => validateOperationalContinuity(fixture.source, fixture.target, policy, fixture.anchor),
      /LIVE_CONTINUITY_FAILED/,
    );
  }
});

test('later revisions replay every v12 operational bounded digest while v11 remains archival', () => {
  const fixture = operationalFixture();
  const previousEvidence = {
    operational_tables: structuredClone(fixture.target.operational_tables),
  };
  previousEvidence.operational_tables.motorist_calls.post_watermark_count = 3;
  const previousWatermark = {
    schemaVersion: 12,
    evidence: { public: { operationalTables: structuredClone(fixture.anchor.evidence.public.operationalTables) } },
  };

  assert.doesNotThrow(() => validatePreviousOperationalBoundedEvidence(previousEvidence, previousWatermark));
  previousEvidence.operational_tables.motorist_calls.watermarked_content_digest = digest('changed');
  assert.throws(
    () => validatePreviousOperationalBoundedEvidence(previousEvidence, previousWatermark),
    /LIVE_CONTINUITY_FAILED/,
  );
  assert.doesNotThrow(() => validatePreviousOperationalBoundedEvidence({}, { schemaVersion: 11 }));

  for (const mutate of [
    (value) => { delete value.evidence.public.operationalTables.motorist_calls; },
    (value) => { value.evidence.public.operationalTables.extra_table = {}; },
  ]) {
    const changedWatermark = structuredClone(previousWatermark);
    changedWatermark.schemaVersion = 12;
    mutate(changedWatermark);
    assert.throws(
      () => validatePreviousOperationalBoundedEvidence(
        fixture.target,
        changedWatermark,
      ),
      /LIVE_CONTINUITY_FAILED/,
    );
  }

  const missingEvidence = structuredClone(fixture.target);
  delete missingEvidence.operational_tables.motorist_call_events;
  assert.throws(
    () => validatePreviousOperationalBoundedEvidence(
      missingEvidence,
      { ...previousWatermark, schemaVersion: 12 },
    ),
    /LIVE_CONTINUITY_FAILED/,
  );
});

test('read-only SQL emits aggregate operational evidence and enforces all structural relations', () => {
  const sql = readFileSync('deploy/supabase/public-live-continuity-readonly.sql', 'utf8');
  const anchorWriter = readFileSync('deploy/bin/create-live-watermark-anchor.mjs', 'utf8');

  for (const table of OPERATIONAL_CONTINUITY_TABLES) {
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.ok([...sql.matchAll(/'operational_contract'/g)].length >= 2);
  assert.ok([...sql.matchAll(/'operational_tables'/g)].length >= 2);
  assert.match(sql, /baseline_immutable_digest/);
  assert.match(sql, new RegExp(`operationalBaselineUtc', '${OPERATIONAL_BASELINE_UTC}`));
  assert.match(sql, new RegExp(`select timestamptz '${OPERATIONAL_BASELINE_UTC}' as value`));
  assert.match(sql, /invalid_live_contract_count/);
  assert.match(sql, /linked_calls\.organization_id = events\.organization_id/);
  assert.match(sql, /linked_calls\.status = 'ended'/);
  assert.match(sql, /recording_objects\.name = recordings\.storage_path/);
  assert.match(sql, /recordings\.checksum !~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /raw_events\.provider = 'commander'/);
  assert.match(sql, /raw_events\.provider = 'viptel'/);
  assert.match(sql, /raw_events\.provider = 'webdispecink'/);
  assert.match(sql, /pg_catalog\.to_jsonb\(calls\) - array\[/);
  assert.match(anchorWriter, /operationalTables/);
  assert.match(anchorWriter, /operational evidence contract differs from policy/);
});
