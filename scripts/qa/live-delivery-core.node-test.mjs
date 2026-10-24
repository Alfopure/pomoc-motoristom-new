import assert from 'node:assert/strict';
import test from 'node:test';
import { assertOwnAccessToken, assertOwnedFields, cleanupFixtures, deriveFixtureId, fixturePlan, fixtureProvenance, provisionFixtures, validateQaEnv } from './live-delivery-core.mjs';

const RUN = '2a65537e-48ae-4d2c-8307-103c53082abe';
const SHA = 'a'.repeat(40);
const environment = () => ({
  LIVE_DELIVERY_QA: '1', LIVE_DELIVERY_QA_RUN_ID: RUN, LIVE_DELIVERY_QA_EXPECTED_SHA: SHA,
  VERCEL_PROJECT_ID: 'prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk', VERCEL_ENV: 'production',
  VERCEL_TARGET_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'dev', VERCEL_GIT_COMMIT_SHA: SHA,
  MOTORIST_APP_ENV: 'test', MOTORIST_ORGANIZATION_ID: '64091e63-0092-42ea-96f9-152dc3476013',
  SUPABASE_PROJECT_REF: 'nzpnqdstvkfncflgqlny', EXPECTED_SUPABASE_PROJECT_REF: 'nzpnqdstvkfncflgqlny',
  SUPABASE_URL: 'https://nzpnqdstvkfncflgqlny.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_SECRET_KEY: 'sb_secret_test', APP_BASE_URL: 'https://test.dispecing.linkapomoci.sk',
});

test('explicit isolated TEST build produces immutable run or cleanup configuration', () => {
  const config = validateQaEnv(environment());
  assert.equal(config.mode, 'run');
  assert.equal(config.runId, RUN);
  assert.equal(config.expectedSha, SHA);
  assert.equal(config.fixtureSha, SHA);
  assert.ok(Object.isFrozen(config));
  assert.equal(validateQaEnv({ ...environment(), LIVE_DELIVERY_QA_MODE: 'cleanup', LIVE_DELIVERY_QA_FIXTURE_SHA: SHA }).mode, 'cleanup');
});

test('every deployment identity and explicit opt-in is mandatory', () => {
  for (const field of ['LIVE_DELIVERY_QA', 'LIVE_DELIVERY_QA_RUN_ID', 'LIVE_DELIVERY_QA_EXPECTED_SHA',
    'VERCEL_PROJECT_ID', 'VERCEL_ENV', 'VERCEL_TARGET_ENV', 'VERCEL_GIT_COMMIT_REF', 'VERCEL_GIT_COMMIT_SHA',
    'MOTORIST_APP_ENV', 'MOTORIST_ORGANIZATION_ID', 'SUPABASE_PROJECT_REF', 'EXPECTED_SUPABASE_PROJECT_REF', 'APP_BASE_URL']) {
    const env = environment();
    delete env[field];
    assert.throws(() => validateQaEnv(env), /guard refused/, field);
  }
  for (const [field, value] of Object.entries({ VERCEL_PROJECT_ID: 'production-project',
    VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'main', MOTORIST_APP_ENV: 'production',
    LIVE_DELIVERY_QA_RUN_ID: 'not-a-uuid', LIVE_DELIVERY_QA_EXPECTED_SHA: 'deadbeef',
    VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40), LIVE_DELIVERY_QA_MODE: 'anything',
    APP_BASE_URL: 'https://dispecing.linkapomoci.sk' })) {
    assert.throws(() => validateQaEnv({ ...environment(), [field]: value }), /guard refused/, field);
  }
});

test('production database, conflicting URL aliases, and foreign JWT keys are rejected', () => {
  for (const field of ['SUPABASE_PROJECT_REF', 'EXPECTED_SUPABASE_PROJECT_REF']) {
    assert.throws(() => validateQaEnv({ ...environment(), [field]: 'ifpaeegaesdmljfkdvcn' }), /guard refused/);
  }
  assert.throws(() => validateQaEnv({ ...environment(), SUPABASE_URL: 'https://ifpaeegaesdmljfkdvcn.supabase.co' }), /guard refused/);
  assert.throws(() => validateQaEnv({ ...environment(), NEXT_PUBLIC_SUPABASE_URL: 'https://ifpaeegaesdmljfkdvcn.supabase.co' }), /guard refused/);
  const foreignJwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ ref: 'ifpaeegaesdmljfkdvcn' })).toString('base64url')}.signature`;
  assert.throws(() => validateQaEnv({ ...environment(), SUPABASE_SERVICE_ROLE_KEY: foreignJwt }), /JWT project ref/);
});

test('fixture identities are reproducible across cleanup and isolated across runs and kinds', () => {
  const config = validateQaEnv(environment());
  const run = fixturePlan(config);
  const cleanup = fixturePlan(validateQaEnv({ ...environment(), LIVE_DELIVERY_QA_MODE: 'cleanup', LIVE_DELIVERY_QA_FIXTURE_SHA: SHA }));
  assert.deepEqual(cleanup, run);
  const ids = [run.dispatcher.userId, run.dispatcher.profileId, run.recipient.userId, run.recipient.memberId,
    run.outsider.userId, run.outsider.memberId, run.contact.id, run.vehicle.id, run.case.id];
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(deriveFixtureId(RUN, 'recipient-user'), deriveFixtureId('3a65537e-48ae-4d2c-8307-103c53082abe', 'recipient-user'));
  assert.equal(deriveFixtureId(RUN.toUpperCase(), 'recipient-user'), run.recipient.userId);
  assert.match(run.contact.phone, /^\+421900\d{6}$/);
  assert.match(run.vehicle.plate, /^QA[A-F0-9]{12}$/);
  assert.equal(run.case.caseNumber, `QA-DELIVERY-${RUN}`);
  assert.ok(!('password' in run.dispatcher));
});

test('newer validated source can recover original fixtures without altering their provenance', () => {
  const original = validateQaEnv(environment());
  const newerSha = 'b'.repeat(40);
  const recovery = validateQaEnv({ ...environment(), VERCEL_GIT_COMMIT_SHA: newerSha,
    LIVE_DELIVERY_QA_EXPECTED_SHA: newerSha, LIVE_DELIVERY_QA_MODE: 'cleanup', LIVE_DELIVERY_QA_FIXTURE_SHA: SHA });
  assert.equal(recovery.expectedSha, newerSha);
  assert.equal(recovery.fixtureSha, SHA);
  assert.deepEqual(fixturePlan(recovery), fixturePlan(original));
  for (const kind of ['dispatcher', 'recipient', 'outsider']) {
    assert.deepEqual(fixtureProvenance(recovery, kind), fixtureProvenance(original, kind));
    assert.equal(fixtureProvenance(recovery, kind).qa_deployment_sha, SHA);
  }
  // Recovery still requires the currently executing source to match its explicit SHA.
  assert.throws(() => validateQaEnv({ ...environment(), VERCEL_GIT_COMMIT_SHA: newerSha,
    LIVE_DELIVERY_QA_MODE: 'cleanup', LIVE_DELIVERY_QA_FIXTURE_SHA: SHA }), /commit mismatch/);
});

test('cleanup requires an explicit valid original fixture SHA; run cannot claim another deployment', () => {
  for (const fixtureSha of [undefined, '', 'deadbeef', 'z'.repeat(40)]) {
    assert.throws(() => validateQaEnv({ ...environment(), LIVE_DELIVERY_QA_MODE: 'cleanup',
      LIVE_DELIVERY_QA_FIXTURE_SHA: fixtureSha }), /LIVE_DELIVERY_QA_FIXTURE_SHA/);
  }
  assert.throws(() => validateQaEnv({ ...environment(), LIVE_DELIVERY_QA_FIXTURE_SHA: 'b'.repeat(40) }), /fixture SHA must match/);
  assert.equal(validateQaEnv({ ...environment(), LIVE_DELIVERY_QA_FIXTURE_SHA: SHA }).fixtureSha, SHA);
});

test('ownership checks reject matching IDs with foreign organization or provenance', () => {
  const owned = { id: 'owned-id', organization_id: 'own-org', qa_run_id: RUN, qa_deployment_sha: SHA, roles: ['delivery'] };
  assert.doesNotThrow(() => assertOwnedFields({ ...owned, harmless: true }, owned, 'fixture'));
  for (const field of Object.keys(owned)) {
    assert.throws(() => assertOwnedFields({ ...owned, [field]: 'foreign' }, owned, 'fixture'), /foreign fixture/);
  }
  assert.throws(() => assertOwnedFields(null, owned, 'fixture'), /foreign fixture/);
});

test('cleanup refuses to revoke a foreign user or foreign project session', () => {
  const url = 'https://nzpnqdstvkfncflgqlny.supabase.co';
  const token = payload => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
  const payload = { sub: RUN, iss: `${url}/auth/v1` };
  assert.doesNotThrow(() => assertOwnAccessToken(token(payload), RUN, url));
  assert.throws(() => assertOwnAccessToken(token({ ...payload, sub: 'foreign' }), RUN, url), /foreign fixture/);
  assert.throws(() => assertOwnAccessToken(token({ ...payload, iss: 'https://production.supabase.co/auth/v1' }), RUN, url), /foreign fixture/);
  assert.throws(() => assertOwnAccessToken('malformed', RUN, url), /invalid session token/);
});

test('stop during an Auth write waits for its outcome and prevents later setup mutations before caller cleanup', async t => {
  const config = validateQaEnv(environment());
  const controller = new AbortController();
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  let finishWrite;
  const pendingWrite = new Promise(resolve => { finishWrite = resolve; });
  let storedUser;
  let setupSettled = false;
  const mutations = [];
  const respond = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    assert.ok(init.signal instanceof AbortSignal, 'SDK request has bounded signal');
    if (method === 'POST' && url.pathname === '/auth/v1/admin/users') {
      mutations.push('auth-create');
      notifyStarted();
      await pendingWrite;
      // Stopping setup must not abort the currently committing request.
      assert.equal(init.signal.aborted, false);
      storedUser = JSON.parse(init.body);
      delete storedUser.password;
      return respond(storedUser);
    }
    if (method === 'DELETE' && url.pathname.startsWith('/auth/v1/admin/users/')) {
      assert.equal(setupSettled, true, 'caller cleanup runs only after setup settles');
      mutations.push('auth-delete');
      const deleted = storedUser;
      storedUser = undefined;
      return respond(deleted);
    }
    assert.equal(method, 'GET', 'no later Auth creates or table inserts occur');
    if (url.pathname.startsWith('/auth/v1/admin/users/')) {
      return storedUser?.id === url.pathname.split('/').at(-1) ? respond(storedUser)
        : respond({ code: 'user_not_found', msg: 'User not found' }, 404);
    }
    assert.ok(url.pathname.startsWith('/rest/v1/'));
    return respond([]);
  });
  const setup = provisionFixtures(config, { signal: controller.signal });
  const rejection = assert.rejects(setup, /setup stopped/).finally(() => { setupSettled = true; });
  await started;
  controller.abort();
  assert.equal(setupSettled, false);
  assert.deepEqual(mutations, ['auth-create']);
  finishWrite();
  await rejection;
  assert.deepEqual(mutations, ['auth-create']);
  await cleanupFixtures(config);
  assert.deepEqual(mutations, ['auth-create', 'auth-delete']);
  assert.equal(storedUser, undefined);
});
