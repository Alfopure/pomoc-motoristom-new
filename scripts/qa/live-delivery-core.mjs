import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const TEST_REF = 'nzpnqdstvkfncflgqlny';
const ORIGIN = 'https://test.dispecing.linkapomoci.sk';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validated = new WeakSet();
const first = (...values) => values.find(value => value?.trim());

/** Keep browser same-origin protections enabled so authenticated POSTs carry Origin. */
export function qaBrowserArgs(args) {
  return args.filter(arg => arg !== '--disable-web-security' && !arg.startsWith('--disable-web-security='));
}

/** The case-live POST is a read: its manifest contains only revision numbers. */
export function isCaseLiveReadBody(value) {
  const plainObject = object => object !== null && typeof object === 'object' && !Array.isArray(object)
    && [Object.prototype, null].includes(Object.getPrototypeOf(object));
  if (!plainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== 'versions' || !plainObject(value.versions)) return false;
  return Reflect.ownKeys(value.versions).every(key => typeof key === 'string' && UUID.test(key)
    && Number.isSafeInteger(value.versions[key]) && value.versions[key] > 0);
}

function requireValue(condition, label) {
  if (!condition) throw new Error(`Delivery QA guard refused: ${label}`);
}

export function validateQaEnv(env) {
  const exact = {
    LIVE_DELIVERY_QA: '1', VERCEL_PROJECT_ID: 'prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk',
    VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'dev',
    MOTORIST_APP_ENV: 'test', APP_BASE_URL: ORIGIN,
    SUPABASE_PROJECT_REF: TEST_REF, EXPECTED_SUPABASE_PROJECT_REF: TEST_REF,
  };
  for (const [key, value] of Object.entries(exact)) requireValue(env[key] === value, key);
  const runId = env.LIVE_DELIVERY_QA_RUN_ID;
  const expectedSha = env.LIVE_DELIVERY_QA_EXPECTED_SHA;
  requireValue(UUID.test(runId ?? ''), 'LIVE_DELIVERY_QA_RUN_ID');
  requireValue(/^[0-9a-f]{40}$/.test(expectedSha ?? ''), 'LIVE_DELIVERY_QA_EXPECTED_SHA');
  requireValue(env.VERCEL_GIT_COMMIT_SHA === expectedSha, 'commit mismatch');
  requireValue(UUID.test(env.MOTORIST_ORGANIZATION_ID ?? ''), 'MOTORIST_ORGANIZATION_ID');
  const mode = env.LIVE_DELIVERY_QA_MODE ?? 'run';
  requireValue(['run', 'cleanup'].includes(mode), 'LIVE_DELIVERY_QA_MODE');
  const fixtureSha = env.LIVE_DELIVERY_QA_FIXTURE_SHA ?? (mode === 'run' ? expectedSha : undefined);
  requireValue(/^[0-9a-f]{40}$/.test(fixtureSha ?? ''), 'LIVE_DELIVERY_QA_FIXTURE_SHA');
  if (mode === 'run') requireValue(fixtureSha === expectedSha, 'fixture SHA must match run deployment');
  const supabaseUrl = first(env.SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_URL);
  requireValue(supabaseUrl === `https://${TEST_REF}.supabase.co`, 'Supabase URL');
  for (const key of ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL']) {
    if (env[key]) requireValue(env[key] === supabaseUrl, key);
  }
  const publicKey = first(env.SUPABASE_PUBLISHABLE_KEY, env.SUPABASE_ANON_KEY,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const legacy = first(env.SUPABASE_SERVICE_ROLE_KEY);
  const secret = first(env.SUPABASE_SECRET_KEY);
  const serviceKey = env.SUPABASE_PREFER_SECRET_KEY === 'true' ? first(secret, legacy)
    : legacy?.trim().startsWith('eyJ') ? legacy : first(secret, legacy);
  requireValue(Boolean(publicKey && serviceKey), 'Supabase credentials missing');
  for (const key of [publicKey, serviceKey]) {
    if (key.startsWith('eyJ')) {
      let payload;
      try { payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()); }
      catch { throw new Error('Delivery QA guard refused: invalid JWT key'); }
      requireValue(payload.ref === TEST_REF, 'JWT project ref');
    }
  }
  const config = Object.freeze({ runId: runId.toLowerCase(), expectedSha, fixtureSha,
    organizationId: env.MOTORIST_ORGANIZATION_ID.toLowerCase(), supabaseUrl, publicKey, serviceKey,
    origin: ORIGIN, mode });
  validated.add(config);
  return config;
}

export function deriveFixtureId(runId, kind) {
  requireValue(UUID.test(runId ?? ''), 'fixture run ID');
  requireValue(typeof kind === 'string' && kind.length > 0, 'fixture kind');
  const bytes = createHash('sha256').update(`motorist-live-delivery-qa:v1:${runId.toLowerCase()}:${kind}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function fixturePlan(config) {
  const id = kind => deriveFixtureId(config.runId, kind);
  const marker = `delivery-qa:${config.runId}:${config.fixtureSha}`;
  const actor = kind => ({ userId: id(`${kind}-user`), email: `delivery-qa-${config.runId}-${kind}@example.invalid`,
    ...(kind === 'dispatcher' ? { profileId: id('dispatcher-profile') } : { memberId: id(`${kind}-member`) }) });
  return { organizationId: config.organizationId, marker,
    dispatcher: actor('dispatcher'), recipient: actor('recipient'), outsider: actor('outsider'),
    case: { id: id('case'), caseNumber: `QA-DELIVERY-${config.runId}` },
    contact: { id: id('contact'), phone: `+421900${String(parseInt(id('phone').replaceAll('-', '').slice(0, 10), 16) % 1000000).padStart(6, '0')}` },
    vehicle: { id: id('vehicle'), plate: `QA${id('plate').replaceAll('-', '').slice(0, 12).toUpperCase()}` } };
}

export function fixtureProvenance(config, kind) {
  return { motorist_module: 'towing', towing_only: true,
    qa_kind: 'live-delivery', qa_run_id: config.runId, qa_organization_id: config.organizationId,
    qa_deployment_sha: config.fixtureSha, qa_actor_kind: kind };
}

export function assertOwnedFields(actual, expected, label) {
  requireValue(actual && Object.entries(expected).every(([key, value]) =>
    JSON.stringify(actual[key]) === JSON.stringify(value)), `foreign fixture: ${label}`);
}

export function assertOwnAccessToken(token, userId, supabaseUrl) {
  let payload;
  try { payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); }
  catch { throw new Error('Delivery QA guard refused: invalid session token'); }
  assertOwnedFields(payload, { sub: userId, iss: `${supabaseUrl}/auth/v1` }, 'session token');
}

function adminClient(config) {
  requireValue(validated.has(config), 'configuration must come from validateQaEnv');
  return createClient(config.supabaseUrl, config.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init = {}) => fetch(input, { ...init,
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) }) },
  });
}

function journal(action, kind, id) {
  console.log(JSON.stringify({ deliveryQa: action, kind, id }));
}

async function checked(query, label) {
  const result = await query;
  // Do not print SDK errors: HTTP bodies can contain credentials or personal data.
  if (result.error) throw new Error(`Delivery QA ${label} failed (${result.error.code ?? result.error.status ?? 'unknown'})`);
  return result.data;
}

function rowSpecs(config, fixtures) {
  const common = { organization_id: config.organizationId };
  return [
    ['motorist_profiles', { ...common, id: fixtures.dispatcher.profileId, user_id: fixtures.dispatcher.userId,
      display_name: fixtures.marker, email: fixtures.dispatcher.email, role: 'dispatcher', kind: 'human' },
    { active: true, access_status: 'active' }],
    ...['recipient', 'outsider'].map(kind => ['motorist_towing_memberships', { ...common,
      id: fixtures[kind].memberId, auth_user_id: fixtures[kind].userId, display_name: fixtures.marker,
      email: fixtures[kind].email, roles: ['delivery'], capabilities: ['deliver'], office_profile_id: null }, { active: true }]),
    ['motorist_contacts', { ...common, id: fixtures.contact.id, name: fixtures.marker,
      phone: fixtures.contact.phone, email: fixtures.dispatcher.email, role: 'client', notes: fixtures.marker }, {}],
    ['motorist_vehicles', { ...common, id: fixtures.vehicle.id, license_plate: fixtures.vehicle.plate, notes: fixtures.marker }, {}],
    ['motorist_cases', { ...common, id: fixtures.case.id, case_number: fixtures.case.caseNumber,
      owner_id: fixtures.dispatcher.profileId, contact_id: fixtures.contact.id, vehicle_id: fixtures.vehicle.id,
      summary: fixtures.marker, main_note: fixtures.marker }, {
      status: 'new', priority: 'normal', source_type: 'internal', case_type: 'Pristavenie vozidla – QA',
      customer_details: { contacts: [{ id: fixtures.contact.id, name: fixtures.marker, phone: fixtures.contact.phone,
        email: fixtures.dispatcher.email, role: 'primary_customer', isPrimary: true }] },
      vehicle_details: { jobTypes: ['replacement_vehicle'], conditionFlags: ['driveable'] },
      location_details: { manualPickupAddress: 'QA – Bratislava, testovacie prevzatie',
        manualDestinationAddress: 'QA – Bratislava, testovacie odovzdanie' },
      replacement_vehicle_details: { needed: true, provisionStatus: 'not_provided' },
    }],
  ];
}

async function ownRow(admin, table, fields) {
  const row = await checked(admin.from(table).select('*').eq('id', fields.id).maybeSingle(), `${table} lookup`);
  if (row) assertOwnedFields(row, fields, table);
  return row;
}

async function ownUser(admin, config, actor, kind) {
  const { data, error } = await admin.auth.admin.getUserById(actor.userId);
  if (error && (error.status === 404 || error.code === 'user_not_found')) return null;
  if (error) throw new Error(`Delivery QA Auth lookup failed (${error.code ?? error.status ?? 'unknown'})`);
  if (data.user) {
    assertOwnedFields(data.user, { id: actor.userId, email: actor.email }, `${kind} Auth`);
    assertOwnedFields(data.user.app_metadata, fixtureProvenance(config, kind), `${kind} Auth provenance`);
  }
  return data.user;
}

export async function provisionFixtures(config, { signal } = {}) {
  const admin = adminClient(config);
  requireValue(config.mode === 'run', 'provision requires run mode');
  const fixtures = { ...fixturePlan(config), admin };
  // Refuse a reused run or any ID collision before creating the first identity.
  for (const kind of ['dispatcher', 'recipient', 'outsider']) {
    requireValue(!(await ownUser(admin, config, fixtures[kind], kind)), `${kind} already exists; run cleanup first`);
  }
  for (const [table, fields] of rowSpecs(config, fixtures)) {
    requireValue(!(await ownRow(admin, table, fields)), `${table} already exists; run cleanup first`);
  }
  for (const [table, column, value, id] of [
    ['motorist_contacts', 'phone', fixtures.contact.phone, fixtures.contact.id],
    ['motorist_vehicles', 'license_plate', fixtures.vehicle.plate, fixtures.vehicle.id],
  ]) {
    const matches = await checked(admin.from(table).select('id').eq('organization_id', config.organizationId)
      .eq(column, value), `${table} collision check`);
    requireValue(matches.every(row => row.id === id), `${table} identifier collision`);
  }
  for (const kind of ['dispatcher', 'recipient', 'outsider']) {
    const actor = fixtures[kind];
    actor.password = randomBytes(32).toString('base64url');
    requireValue(!signal?.aborted, 'setup stopped; caller must clean up after setup settles');
    const result = await admin.auth.admin.createUser({ id: actor.userId, email: actor.email, password: actor.password,
      email_confirm: true, app_metadata: fixtureProvenance(config, kind) });
    if (result.error) throw new Error(`Delivery QA ${kind} Auth creation failed (${result.error.code ?? result.error.status ?? 'unknown'})`);
    journal('created', 'auth-user', actor.userId);
    assertOwnedFields(result.data.user, { id: actor.userId, email: actor.email }, 'created Auth user');
    const profiles = await checked(admin.from('motorist_profiles').select('id').eq('user_id', actor.userId), 'unexpected Auth profile check');
    requireValue(profiles.length === 0, `${kind} unexpectedly has an automatic dispatch profile`);
  }
  for (const [table, fields, defaults] of rowSpecs(config, fixtures)) {
    requireValue(!(await ownRow(admin, table, fields)), `${table} already exists; run cleanup first`);
    requireValue(!signal?.aborted, 'setup stopped; caller must clean up after setup settles');
    await checked(admin.from(table).insert({ ...fields, ...defaults }), `${table} insert`);
    journal('created', table, fields.id);
  }
  for (const [column, ids] of [['profile_id', [fixtures.dispatcher.profileId]],
    ['member_id', [fixtures.recipient.memberId, fixtures.outsider.memberId]]]) {
    const devices = await checked(admin.from('motorist_mobile_push_devices').select('id')
      .eq('organization_id', config.organizationId).in(column, ids), 'push-device check');
    requireValue(devices.length === 0, 'QA actors have registered push devices');
  }
  return fixtures;
}

export async function cleanupFixtures(config, supplied) {
  const admin = adminClient(config);
  const fixtures = fixturePlan(config);
  // Only access tokens are accepted from mutable caller state; all deletion IDs are reconstructed.
  const specs = rowSpecs(config, fixtures);
  const users = {};
  const rows = [];
  for (const kind of ['dispatcher', 'recipient', 'outsider']) users[kind] = await ownUser(admin, config, fixtures[kind], kind);
  // Complete the ownership preflight before the first mutation.
  for (const [table, fields] of specs) rows.push(await ownRow(admin, table, fields));
  for (let i = 0; i < 3; i++) {
    if (!rows[i]) continue;
    const [table, fields] = specs[i];
    const updated = await checked(admin.from(table).update({ active: false, ...(i === 0 ? { access_status: 'disabled' } : {}) })
      .eq('id', fields.id).eq('organization_id', config.organizationId).select('id'), `${table} deactivate`);
    requireValue(updated.length === 1, `${table} deactivation affected no row`);
  }
  const errors = [];
  for (const kind of ['dispatcher', 'recipient', 'outsider']) {
    if (!users[kind] || !supplied?.[kind]?.accessToken) continue;
    assertOwnAccessToken(supplied[kind].accessToken, fixtures[kind].userId, config.supabaseUrl);
    const { error } = await admin.auth.admin.signOut(supplied[kind].accessToken, 'global');
    if (error) errors.push(new Error(`Delivery QA ${kind} session revocation failed (${error.code ?? error.status ?? 'unknown'})`));
  }
  // Cases cascade their protected handoff data. Never directly delete those tables.
  for (const i of [5, 3, 4, 1, 2, 0]) {
    if (!rows[i]) continue;
    const [table, fields] = specs[i];
    let deletion = admin.from(table).delete().eq('id', fields.id).eq('organization_id', config.organizationId);
    if (table === 'motorist_cases') deletion = deletion.eq('owner_id', fixtures.dispatcher.profileId)
      .eq('contact_id', fixtures.contact.id).eq('vehicle_id', fixtures.vehicle.id)
      .eq('summary', fixtures.marker).eq('main_note', fixtures.marker).eq('case_number', fixtures.case.caseNumber);
    const deleted = await checked(deletion.select('id'), `${table} delete`);
    requireValue(deleted.length === 1, `${table} deletion affected no row`);
    journal('deleted', table, fields.id);
  }
  for (const kind of ['dispatcher', 'recipient', 'outsider']) {
    if (!users[kind]) continue;
    // Recheck provenance immediately before deleting an identity.
    if (!(await ownUser(admin, config, fixtures[kind], kind))) continue;
    const { error } = await admin.auth.admin.deleteUser(fixtures[kind].userId, false);
    if (error) errors.push(new Error(`Delivery QA ${kind} Auth delete failed (${error.code ?? error.status ?? 'unknown'})`));
    else journal('deleted', 'auth-user', fixtures[kind].userId);
  }
  if (errors.length) throw new AggregateError(errors, 'Delivery QA cleanup incomplete');
  for (const [table, fields] of specs) {
    requireValue(!(await ownRow(admin, table, fields)), `${table} still exists after cleanup`);
  }
  for (const kind of ['dispatcher', 'recipient', 'outsider']) {
    requireValue(!(await ownUser(admin, config, fixtures[kind], kind)), `${kind} still exists after cleanup`);
  }
  journal('cleanup-complete', 'run', config.runId);
}
