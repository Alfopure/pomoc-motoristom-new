// Application workflow against the installed SQL contract, with synthetic
// provider/media and a loopback-only fixture. See README.md for boundaries.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

const root = process.cwd();
await build({
  stdin: { contents: `export * from '@/test/telephony-harness';
    export * from '@/server/telephony/call-actions';
    export * from '@/server/telephony/presence-service';
    export * from '@/server/telephony/presence-recovery';`, resolveDir: root, loader: 'ts' },
  outfile: '.context/presence-compatibility.cjs', bundle: true, platform: 'node', format: 'cjs', packages: 'external',
  alias: { '@': path.join(root, 'src'), 'server-only': path.join(root, 'src/test/stubs/server-only.ts') },
});
const app = createRequire(import.meta.url)('../../.context/presence-compatibility.cjs');
const pg = request => {
  const response = JSON.parse(execFileSync('python3', ['tests/postgres/compatibility-bridge.py'], {
    input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  }));
  if (response.error) throw new Error(JSON.stringify(response.error));
  return response.data;
};
const restore = (h, tables) => {
  h.db.tables.clear();
  for (const [name, rows] of Object.entries(tables)) h.db.tables.set(name, rows);
};
function attach(h) {
  restore(h, pg({ op: 'sync', tables: Object.fromEntries(h.db.tables) }));
  let depth = 0;
  for (const name of ['insert', 'upsert', 'update', 'delete']) {
    const original = h.db[name].bind(h.db);
    h.db[name] = (...args) => {
      depth++;
      let result;
      try { result = original(...args); } finally { depth--; }
      if (!depth) restore(h, name === 'delete'
        ? pg({ op: 'delete', table: args[0], ids: result.map(row => row.id) })
        : pg({ op: 'sync', tables: { [args[0]]: h.db.rows(args[0]) } }));
      return result;
    };
  }
  for (const [name, original] of h.db.rpcHandlers) {
    h.db.registerRpc(name, async (args, db) => {
      const before = new Map([...db.tables].map(([table, rows]) => [table, JSON.stringify(rows)]));
      depth++;
      let result;
      try { result = await original(args, db); } finally { depth--; }
      const changed = Object.fromEntries([...db.tables].filter(([table, rows]) => before.get(table) !== JSON.stringify(rows)));
      if (Object.keys(changed).length) restore(h, pg({ op: 'sync', tables: changed }));
      return result;
    });
  }
  for (const name of ['motorist_presence_transition_v1', 'motorist_reserve_operator', 'motorist_stage_transition_v1']) {
    h.db.registerRpc(name, args => {
      const result = pg({ op: 'rpc', name, args });
      restore(h, result.tables);
      return result.value;
    });
  }
  return h;
}

globalThis.fetch = () => { throw new Error('No external HTTP permitted in presence fixture'); };
process.env.TELNYX_RECORDING_ENABLED = 'false';
const actor = { profileId: app.PROFILES.o1, role: 'dispatcher' };
const own = { organizationId: app.ORG, profileId: actor.profileId };
for (const [creation, answer] of [['false', 'false'], ['true', 'true'], ['true', 'false']]) {
  process.env.TELEPHONY_STABILITY_V1_ENABLED = creation;
  const database = pg({ op: 'setup' });
  assert.equal(database.serverAddress, '127.0.0.1');
  const h = app.createTelephonyHarness({ now: new Date().toISOString(), fallbackKind: 'waiting_room' });
  h.db.update('motorist_telephony_lines', { business_hours_id: null }, () => true);
  for (const profileId of Object.values(app.PROFILES)) h.setPresence(profileId, { status: 'offline' });
  attach(h);
  const call = await h.inbound({ to: app.NUMBERS.allianz });
  await app.setPresence(h.deps, { ...own, status: 'available' });
  const pickup = await app.pickupWaitingCall(h.deps, actor, call.sessionId);
  const leg = pickup.operatorLegCallControlId;
  assert(leg);
  assert(h.presence(actor.profileId).offer_token);
  assert.equal(h.clientStateOf(leg).offerToken, h.presence(actor.profileId).offer_token);
  process.env.TELEPHONY_STABILITY_V1_ENABLED = answer;
  await h.legEvent(leg, 'call.answered');
  assert.equal(h.presence(actor.profileId).status, 'on_call');
  await h.legEvent(call.callControlId, 'call.hangup');
  await h.legEvent(leg, 'call.hangup');
  for (const other of h.legs(call.sessionId)) {
    if (!other.ended_at) await h.legEvent(String(other.telnyx_call_control_id), 'call.hangup');
  }
  assert.equal(h.session(call.sessionId).state, 'ended');
  assert.equal(h.presence(actor.profileId).current_session_id, null);
  await app.setPresence(h.deps, { ...own, status: 'available' });
  assert.equal(h.presence(actor.profileId).status, 'available');
  console.log(`PASS migrated SQL + application pickup/answer/hangup/manual presence creation=${creation} answer=${answer}`);

  if (creation === 'false') {
    await app.setPresence(h.deps, { organizationId: app.ORG, profileId: app.PROFILES.o2, status: 'available' });
    const internal = await app.callColleague(h.deps, actor, { targetProfileId: app.PROFILES.o2 });
    await h.legEvent(internal.operatorLegCallControlId, 'call.answered');
    const callee = String(h.legFor(internal.sessionId, app.PROFILES.o2).telnyx_call_control_id);
    await h.legEvent(callee, 'call.answered');
    const saved = h.legFor(internal.sessionId, app.PROFILES.o2);
    assert(h.presence(app.PROFILES.o2).offer_token);
    assert.equal(saved.client_state.offerToken, h.presence(app.PROFILES.o2).offer_token);
    await h.legEvent(internal.operatorLegCallControlId, 'call.hangup');
    await h.legEvent(callee, 'call.hangup');
    assert.equal(h.presence(actor.profileId).current_session_id, null);
    assert.equal(h.presence(app.PROFILES.o2).current_session_id, null);
    await app.setPresence(h.deps, { ...own, status: 'available' });
    console.log('PASS migrated SQL + compatibility internal answer binds acquired ownership and releases both parties');
  }

  // Reconstruct the historical token-only leak in the isolated database and
  // verify the actual application maintenance entry point repairs it once.
  h.setPresence(actor.profileId, { status: 'on_call', current_session_id: call.sessionId, offer_token: 'historical-leak' });
  h.advance(300_000);
  const before = h.telnyx.calls.length;
  const recovery = await app.sweepEndedSessionPresence(h.deps);
  assert.equal(recovery.released, 1);
  assert.deepEqual(recovery.errors, []);
  assert.equal(h.presence(actor.profileId).current_session_id, null);
  assert.equal((await app.sweepEndedSessionPresence(h.deps)).released, 0);
  assert.equal(h.telnyx.calls.length, before);
  console.log(`PASS migrated SQL + application ended-session recovery creation=${creation} answer=${answer}`);
}
