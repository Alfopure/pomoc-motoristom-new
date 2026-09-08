import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const writer = require('../../.context/compat-writer.cjs'), baseline = require('../../.context/compat-baseline.cjs');
const pg = request => { const response = JSON.parse(execFileSync('python3', ['tests/postgres/compatibility-bridge.py'], { input: JSON.stringify(request), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })); if (response.error)
    throw response.error; return response.data; };
const restore = (h, tables) => { h.db.tables.clear(); for (const [name, rows] of Object.entries(tables))
    h.db.tables.set(name, rows); };
function attach(h, seed = false) {
    restore(h, seed ? pg({ op: 'sync', tables: Object.fromEntries(h.db.tables) }) : pg({ op: 'snapshot' }));
    let depth = 0;
    for (const name of ['insert', 'upsert', 'update', 'delete']) {
        const original = h.db[name].bind(h.db);
        h.db[name] = (...args) => {
            depth++;
            let result;
            try {
                result = original(...args);
            }
            finally {
                depth--;
            }
            if (!depth) {
                restore(h, name === 'delete' ? pg({ op: 'delete', table: args[0], ids: result.map(r => r.id) }) : pg({ op: 'sync', tables: { [args[0]]: h.db.rows(args[0]) } }));
            }
            return result;
        };
    }
    for (const [name, original] of h.db.rpcHandlers) {
        h.db.registerRpc(name, async (args, db) => {
            const before = new Map([...db.tables].map(([t, rows]) => [t, JSON.stringify(rows)]));
            depth++;
            let result;
            try {
                result = await original(args, db);
            }
            finally {
                depth--;
            }
            const changed = Object.fromEntries([...db.tables].filter(([t, rows]) => before.get(t) !== JSON.stringify(rows)));
            if (Object.keys(changed).length)
                restore(h, pg({ op: 'sync', tables: changed }));
            return result;
        });
    }
    const rpcs = ['motorist_presence_transition_v1', 'motorist_stage_transition_v1', 'motorist_reconcile_callback_contact_v1', 'motorist_schedule_callback_v1', 'motorist_create_callback_obligation_v1', 'motorist_link_callback_outbound_v1', 'motorist_resolve_callback_v1'];
    for (const name of rpcs)
        h.db.registerRpc(name, args => { const result = pg({ op: 'rpc', name, args }); restore(h, result.tables); return result.value; });
    h.nextEventId = () => `compat-${randomUUID()}`;
    globalThis.__compatAdmin = h.admin;
    return h;
}
function restart(app, previous) { const h = attach(app.createTelephonyHarness({ now: previous.now().toISOString(), fallbackKind: 'waiting_room' })); h.telnyx = previous.telnyx; h.deps.telnyx = h.telnyx.client; return h; }
const pass = name => console.log('PASS', name);
const REASON = '00000000-0000-4000-8000-000000002501', actor = { profileId: writer.PROFILES.o1, role: 'dispatcher' }, own = { profileId: actor.profileId, organizationId: writer.ORG };
(async () => {
    globalThis.fetch = () => { throw Error('No external HTTP permitted in compatibility fixture'); };
    process.env.TELEPHONY_STABILITY_V1_ENABLED = 'true';
    process.env.TELNYX_RECORDING_ENABLED = 'false';
    console.log('SOURCE', require('../../.context/compat-source.json'));
    console.log('DATABASE', pg({ op: 'setup' }));
    let h = writer.createTelephonyHarness({ now: new Date().toISOString(), fallbackKind: 'waiting_room' });
    // Avoid business hours as an unrelated real-clock dependency; all destination
    // numbers and provider commands are confined to the synthetic provider.
    h.db.update('motorist_telephony_lines', { business_hours_id: null }, () => true);
    for (const profileId of Object.values(writer.PROFILES))
        h.setPresence(profileId, { status: 'offline' });
    h.db.update('motorist_operator_telephony_settings', { wrap_up_seconds: 30, pause_routing_mode: 'default_mobile', default_mobile_number: '+421900000099' }, r => r.profile_id === actor.profileId);
    h = attach(h, true);
    await writer.setPresence(h.deps, { ...own, status: 'paused', pauseReasonId: REASON });
    // The actual outcome API service creates the callback from a historical log.
    const old = h.db.insert('motorist_calls', { organization_id: writer.ORG, direction: 'inbound', caller_number: writer.NUMBERS.customer, line_id: writer.LINES.allianz, case_id: null, session_id: null })[0];
    await writer.setCallOutcome(old.id, { outcome: 'callback', callbackActionId: randomUUID(), callbackMinutes: 30 }, own);
    const callback = h.rows('motorist_callback_requests')[0];
    assert(callback);
    assert(callback.metadata.schedule_action_ids.length === 1);
    h.setNow(new Date(Date.now() + 1000).toISOString());
    for (const id of Object.values(writer.PROFILES))
        h.touchDevice(id);
    const call = await h.inbound({ to: writer.NUMBERS.allianz });
    const pickup = await writer.pickupWaitingCall(h.deps, actor, call.sessionId);
    assert(pickup.operatorLegCallControlId);
    assert.equal(h.presence(actor.profileId).pause_return.pauseReasonId, REASON);
    pass('new API services persist scheduled callback and paused pickup through real SQL RPCs');
    // Reload independently instantiated oldest compatible callers from PostgreSQL.
    h = restart(baseline, h);
    assert.equal(h.presence(actor.profileId).pause_return.pauseReasonId, REASON);
    pg({ op: 'fault', enabled: true });
    h.telnyx.physical.answered(pickup.operatorLegCallControlId);
    await h.legEvent(pickup.operatorLegCallControlId, 'call.answered');
    assert.equal(h.presence(actor.profileId).status, 'on_call');
    const operation = baseline.readContactHistory(h.session(call.sessionId)).operations.at(-1);
    assert(operation);
    for (const cc of [call.callControlId, pickup.operatorLegCallControlId]) {
        const state = cc === operation.sourceControlId ? { sid: call.sessionId, role: h.clientStateOf(cc).role, intent: baseline.contactOperationIntent(operation.id) } : h.clientStateOf(cc);
        await h.legEvent(cc, 'call.bridged', { client_state: baseline.encodeClientState(state) });
    }
    assert(h.telnyx.physical.connected(call.callControlId, pickup.operatorLegCallControlId));
    assert.equal(h.rows('motorist_callback_requests').find(r => r.id === callback.id).status, 'open');
    assert(baseline.readPendingEffects(h.session(call.sessionId)).entries.length > 0);
    pass('baseline webhook answers persisted pickup; real audit failure rolls back callback fulfillment');
    // Turn admission off while the customer/operator audio and return context live.
    process.env.TELEPHONY_STABILITY_V1_ENABLED = 'false';
    const commands = h.telnyx.calls.length;
    h = restart(baseline, h);
    assert(h.telnyx.physical.connected(call.callControlId, pickup.operatorLegCallControlId));
    assert.equal(h.telnyx.calls.length, commands);
    assert.equal(h.presence(actor.profileId).pause_return.pauseReasonId, REASON);
    const q = await baseline.loadCallbackQueue(h.deps, actor);
    assert.equal(q.schedulingEnabled, false);
    const callbackCount = h.rows('motorist_callback_requests').length;
    await baseline.setCallOutcome(old.id, { outcome: 'callback', callbackActionId: randomUUID(), callbackMinutes: 30 }, own);
    assert.equal(h.rows('motorist_callback_requests').length, callbackCount);
    assert.deepEqual(h.rows('motorist_callback_requests').find(r => r.id === callback.id).metadata.schedule_action_ids, callback.metadata.schedule_action_ids);
    pass('creation-off rollback retains live provider connection and persisted return context');
    // Real baseline handler receives customer hangup; failure remains pending after
    // terminal state, then another runtime instance must finish historical effects.
    h.telnyx.physical.ended(call.callControlId);
    await h.legEvent(call.callControlId, 'call.hangup', { hangup_cause: 'normal_clearing' });
    for (const leg of h.legs(call.sessionId))
        if (!leg.ended_at)
            await h.legEvent(String(leg.telnyx_call_control_id), 'call.hangup', { hangup_cause: 'normal_clearing' });
    assert(h.session(call.sessionId).ended_at);
    assert(baseline.readPendingEffects(h.session(call.sessionId)).entries.length > 0);
    assert(['on_call', 'after_call_work'].includes(h.presence(actor.profileId).status));
    assert.equal(h.presence(actor.profileId).pause_return.pauseReasonId, REASON);
    pass('baseline hangup persists terminal pending audit and owner return; release may await audit repair');
    pg({ op: 'fault', enabled: false });
    h.advance(5 * 60000);
    h = restart(baseline, h);
    const afterHangup = h.telnyx.calls.length;
    const recovery = await baseline.runPendingEffectRecovery(h.deps);
    console.log('CRON', recovery);
    assert.equal(recovery.status, 'ok');
    assert.equal(h.rows('motorist_callback_requests').find(r => r.id === callback.id).status, 'done');
    assert.equal(h.rows('motorist_audit_log').filter(r => r.entity_id === callback.id && r.action === 'telephony.callback.contact_done').length, 1);
    assert.equal(baseline.readPendingEffects(h.session(call.sessionId)).entries.length, 0);
    assert.deepEqual(h.telnyx.calls.slice(afterHangup).filter(c => ['dial', 'bridge', 'createConference', 'conference:join', 'recordingStart', 'playbackStart', 'speak', 'gatherUsingAudio'].includes(c.method)), []);
    assert.equal(h.presence(actor.profileId).status, 'after_call_work');
    pass('one baseline five-minute cron completes terminal proof/fulfillment/audit without restarting audio');
    console.log('RECOVERY_PROVIDER_METHODS', h.telnyx.calls.slice(afterHangup).map(c => c.method));
    // PostgreSQL clock is real; explicitly place wrap-up just in the past instead
    // of pretending the database clock follows the application test clock.
    h.db.update('motorist_operator_presence', { wrap_up_until: new Date(Date.now() - 1000).toISOString() }, r => r.profile_id === actor.profileId);
    const wrap = await baseline.sweepExpiredWrapUp(h.deps);
    assert.equal(wrap.applied, 1);
    assert.equal(h.presence(actor.profileId).status, 'paused');
    assert.equal(h.presence(actor.profileId).pause_reason_id, REASON);
    assert.equal(h.presence(actor.profileId).pause_return, null);
    const history = h.rows('motorist_operator_statuses').filter(r => r.profile_id === actor.profileId);
    assert(!history.some(r => r.status === 'available'));
    assert.equal(history.at(-1).status, 'paused');
    assert.equal(history.at(-1).reason, 'Obed');
    assert.equal((await baseline.sweepExpiredWrapUp(h.deps)).applied, 0);
    pass('baseline cron wrap-up sweep restores original pause and clears context exactly once');
    for (const id of Object.values(writer.PROFILES))
        h.touchDevice(id);
    const waiting = await h.inbound({ from: '+421905111222', to: writer.NUMBERS.allianz, completeGreeting: false });
    const greeting = h.telnyx.calls.findLast(c => ['playbackStart', 'speak'].includes(c.method) && c.params.callControlId === waiting.callControlId);
    if (h.session(waiting.sessionId).state === 'greeting')
        await h.legEvent(waiting.callControlId, greeting.method === 'speak' ? 'call.speak.ended' : 'call.playback.ended', { status: 'completed', client_state: greeting.params.clientState });
    assert.equal(h.legByNumber(waiting.sessionId, '+421900000099'), null);
    const before = h.telnyx.of('dial').length;
    await assert.rejects(baseline.pickupWaitingCall(h.deps, actor, waiting.sessionId), e => e.code === 'operator_unavailable');
    assert.equal(h.telnyx.of('dial').length, before);
    assert.equal(h.session(waiting.sessionId).presence_pickup, null);
    h.advance(31000);
    const sweep = await baseline.sweepOverdueRingSteps({ admin: h.admin, organizationId: writer.ORG, now: h.now, runSessionEvent: (id, event) => baseline.runSessionEvent(h.deps, id, event), limit: 4, budgetMs: 2000 });
    assert.deepEqual(sweep.errors, []);
    assert(sweep.swept.includes(waiting.sessionId));
    assert.equal(h.legByNumber(waiting.sessionId, '+421900000099'), null);
    assert.equal(h.presence(actor.profileId).status, 'paused');
    pass('creation-off baseline refuses new paused pickup; console sweep never revives legacy pause-to-mobile');
    const replay = await baseline.runPendingEffectRecovery(h.deps);
    assert.equal(replay.status, 'ok');
    assert.equal(h.rows('motorist_audit_log').filter(r => r.entity_id === callback.id && r.action === 'telephony.callback.contact_done').length, 1);
    pass('duplicate baseline recovery leaves exactly one fulfillment audit');
    // A separate candidate-created flow preserves the original cron evidence.
    // Its customer hangup arrives, but the operator hangup webhook is withheld:
    // the console scanner must find and finish this very same saved context.
    process.env.TELEPHONY_STABILITY_V1_ENABLED = 'true';
    h.setNow(new Date().toISOString());
    h = restart(writer, h);
    const consoleNumber = '+421905333444';
    const consoleHistory = h.db.insert('motorist_calls', { organization_id: writer.ORG, direction: 'inbound', caller_number: consoleNumber, line_id: writer.LINES.allianz, case_id: null, session_id: null })[0];
    await writer.setCallOutcome(consoleHistory.id, { outcome: 'callback', callbackActionId: randomUUID(), callbackMinutes: 30 }, own);
    const consoleCallback = h.rows('motorist_callback_requests').find(r => r.caller_number === consoleNumber);
    assert(consoleCallback);
    h.setNow(new Date(Date.now() + 1000).toISOString());
    for (const id of Object.values(writer.PROFILES)) h.touchDevice(id);
    const consoleCall = await h.inbound({ from: consoleNumber, to: writer.NUMBERS.allianz, completeGreeting: false });
    const consoleGreeting = h.telnyx.calls.findLast(c => ['playbackStart', 'speak'].includes(c.method) && c.params.callControlId === consoleCall.callControlId);
    assert.equal(h.session(consoleCall.sessionId).state, 'greeting');
    await h.legEvent(consoleCall.callControlId, consoleGreeting.method === 'speak' ? 'call.speak.ended' : 'call.playback.ended', { status: 'completed', client_state: consoleGreeting.params.clientState });
    const consolePickup = await writer.pickupWaitingCall(h.deps, actor, consoleCall.sessionId);
    assert(consolePickup.operatorLegCallControlId);
    assert.equal(h.presence(actor.profileId).pause_return.pauseReasonId, REASON);
    h = restart(baseline, h);
    pg({ op: 'fault', enabled: true });
    h.telnyx.physical.answered(consolePickup.operatorLegCallControlId);
    await h.legEvent(consolePickup.operatorLegCallControlId, 'call.answered');
    assert.equal(h.presence(actor.profileId).status, 'on_call');
    const consoleOperation = baseline.readContactHistory(h.session(consoleCall.sessionId)).operations.at(-1);
    assert(consoleOperation);
    for (const cc of [consoleCall.callControlId, consolePickup.operatorLegCallControlId]) {
        const state = cc === consoleOperation.sourceControlId ? { sid: consoleCall.sessionId, role: h.clientStateOf(cc).role, intent: baseline.contactOperationIntent(consoleOperation.id) } : h.clientStateOf(cc);
        await h.legEvent(cc, 'call.bridged', { client_state: baseline.encodeClientState(state) });
    }
    assert(h.telnyx.physical.connected(consoleCall.callControlId, consolePickup.operatorLegCallControlId));
    process.env.TELEPHONY_STABILITY_V1_ENABLED = 'false';
    h.telnyx.physical.ended(consoleCall.callControlId);
    await h.legEvent(consoleCall.callControlId, 'call.hangup', { hangup_cause: 'normal_clearing' });
    const awaitingConsole = h.session(consoleCall.sessionId);
    assert.equal(awaitingConsole.state, 'wrap_up');
    assert.equal(h.telnyx.physical.legs.get(consoleCall.callControlId).ended, true);
    assert(baseline.readPendingEffects(awaitingConsole).entries.length > 0);
    assert.equal(h.rows('motorist_callback_requests').find(r => r.id === consoleCallback.id).status, 'open');
    assert.equal(h.presence(actor.profileId).pause_return.pauseReasonId, REASON);
    const savedProofs = baseline.readContactHistory(awaitingConsole).proofs;
    assert.equal(savedProofs.length, 1);
    pg({ op: 'fault', enabled: false });
    h.advance(121000);
    h = restart(baseline, h);
    const beforeConsoleCommands = h.telnyx.calls.length;
    const consoleRecovery = await baseline.sweepOverdueRingSteps({ admin: h.admin, organizationId: writer.ORG, now: h.now, runSessionEvent: (id, event) => baseline.runSessionEvent(h.deps, id, event), limit: 4, budgetMs: 2000 });
    console.log('CONSOLE_CONTEXT_RECOVERY', consoleRecovery);
    assert.deepEqual(consoleRecovery.errors, []);
    assert(consoleRecovery.swept.includes(consoleCall.sessionId));
    assert.equal(h.session(consoleCall.sessionId).state, 'ended');
    assert.equal(baseline.readPendingEffects(h.session(consoleCall.sessionId)).entries.length, 0);
    assert.deepEqual(baseline.readContactHistory(h.session(consoleCall.sessionId)).proofs, savedProofs);
    assert.equal(h.rows('motorist_callback_requests').find(r => r.id === consoleCallback.id).status, 'done');
    assert.equal(h.rows('motorist_audit_log').filter(r => r.entity_id === consoleCallback.id && r.action === 'telephony.callback.contact_done').length, 1);
    assert(h.legs(consoleCall.sessionId).every(leg => leg.ended_at));
    assert.equal(h.presence(actor.profileId).status, 'after_call_work');
    assert.equal(h.presence(actor.profileId).current_session_id, null);
    assert.equal(h.presence(actor.profileId).pause_return.pauseReasonId, REASON);
    assert.deepEqual(h.telnyx.calls.slice(beforeConsoleCommands).filter(c => ['dial', 'bridge', 'createConference', 'conference:join', 'recordingStart', 'playbackStart', 'speak', 'gatherUsingAudio'].includes(c.method)), []);
    h.db.update('motorist_operator_presence', { wrap_up_until: new Date(Date.now() - 1000).toISOString() }, r => r.profile_id === actor.profileId);
    await baseline.endWrapUp(h.deps, own);
    assert.equal(h.presence(actor.profileId).status, 'paused');
    assert.equal(h.presence(actor.profileId).pause_reason_id, REASON);
    assert.equal(h.presence(actor.profileId).pause_return, null);
    assert(!h.rows('motorist_operator_statuses').some(r => r.profile_id === actor.profileId && r.status === 'available'));
    const consoleReplay = await baseline.sweepOverdueRingSteps({ admin: h.admin, organizationId: writer.ORG, now: h.now, runSessionEvent: (id, event) => baseline.runSessionEvent(h.deps, id, event), limit: 4, budgetMs: 2000 });
    assert.deepEqual(consoleReplay.errors, []);
    assert(!consoleReplay.swept.includes(consoleCall.sessionId));
    assert.equal(h.rows('motorist_audit_log').filter(r => r.entity_id === consoleCallback.id && r.action === 'telephony.callback.contact_done').length, 1);
    pass('baseline console sweep recovers candidate-created pickup, terminal callback audit and owner return on the same PostgreSQL session');
    console.log('PASS GROUPS 9; synthetic provider; real PostgreSQL presence/stage/callback RPCs; query filter adapter; no live deployment/device evidence');
})().catch(e => { console.error(e); process.exitCode = 1; });
