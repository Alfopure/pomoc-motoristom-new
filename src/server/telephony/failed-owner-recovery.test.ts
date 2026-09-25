import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, PROFILES, ORG } from "@/test/telephony-harness";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { encodeClientState } from "./telnyx/client-state";
import { readPendingEffects, stageEffects } from "./state/continuation";
import { emptyTransition, readMeta, type SessionRow } from "./state/types";
import { effectsDeps, ownedSessionWork } from "./session-runner";
import { sessionOwnership } from "./ownership";
import { TelnyxCommandError } from "./telnyx/client";

// Timers may wake slightly early; cross the fake SQL due time without polling.
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms + 5));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function failedOwner(options: { customer?: boolean; recording?: boolean; rejectAudio?: boolean } = {}) {
  vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "false");
  for (const name of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED", "TELNYX_RECORDING_CONFERENCE_VERIFIED", "TELNYX_RECORDING_TRANSFER_VERIFIED", "TELNYX_RECORDING_CHANNELS_VERIFIED"]) vi.stubEnv(name, "false");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  if (options.recording) {
    for (const name of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED", "TELNYX_RECORDING_CONFERENCE_VERIFIED", "TELNYX_RECORDING_TRANSFER_VERIFIED", "TELNYX_RECORDING_CHANNELS_VERIFIED"]) vi.stubEnv(name, "true");
    h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  }
  const call = await h.inbound({ to: NUMBERS.allianz });
  await completeCallAnnouncements(h, call.sessionId);
  const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  h.telnyx.physical.answered(operator);
  await h.legEvent(operator, "call.answered");
  for (const leg of h.legs(call.sessionId)) if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1) {
    await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  expect(h.session(call.sessionId).state).toBe("talking");
  const clockOffset = h.now().getTime() - Date.now();
  h.db.setNow(() => new Date(Date.now() + clockOffset));
  h.deps.now = () => h.db.now();
  h.deps.random = () => 0;
  h.deps.sleep = sleep;
  const retained: Array<() => Promise<void>> = [];
  h.deps.deferMaintenance = work => { retained.push(work); };
  const gone = new TelnyxCommandError({ code: "90018", status: 422, detail: "Call has already ended" });
  if (options.rejectAudio !== false) {
    h.telnyx.failAlways("playbackStart", gone);
    h.telnyx.failAlways("gather", gone);
  }
  const entered = gate(), finish = gate();
  const gather = h.telnyx.client.gather;
  vi.spyOn(h.telnyx.client, "gather").mockImplementation(async params => {
    entered.release();
    await finish.promise;
    return gather(params);
  });
  h.telnyx.physical.ended(operator);
  if (options.customer !== false) h.telnyx.physical.ended(call.callControlId);
  const owner = h.legEvent(operator, "call.hangup", {}, "failed-operator");
  await entered.promise;
  // The deferred customer hangup retains its own drain from its host (E2.1);
  // it is kept apart so `retained` stays the failed owner's maintenance only.
  let customerSelfDrain: (() => Promise<void>) | null = null;
  if (options.customer !== false) {
    const customer = await h.legEvent(call.callControlId, "call.hangup", {}, "deferred-customer");
    // Durably deferred with its own drain retained: acknowledged, not redelivered.
    expect(customer).toMatchObject({ status: 200, outcome: "deferred" });
    expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "deferred-customer"))
      .toMatchObject({ retry_state: "deferred", delivery_count: 1 });
    expect(retained).toHaveLength(1);
    customerSelfDrain = retained.shift()!;
  }
  return { h, call, operator, retained, finish, owner, customerSelfDrain };
}

describe("failed owner customer terminal recovery", () => {
  it("recovers both physically ended legs only through retained maintenance, without resending rejected audio", async () => {
    const { h, call, retained, finish, owner } = await failedOwner();
    finish.release();
    expect(await owner).toMatchObject({ status: 200, outcome: "failed" });
    expect(h.session(call.sessionId).state).toBe("waiting");
    const customer = h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "deferred-customer")!;
    expect(Date.parse(String(customer.next_attempt_at))).toBeGreaterThan(h.db.now().getTime());
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries.some(entry => entry.commands.some(command => command.kind === "gather"))).toBe(true);
    expect(h.rows("motorist_provider_commands").filter(row => /\/(gather|playback_start)$/.test(String(row.path)) && row.http_status === 422)).toHaveLength(2);
    const generation = Number(h.session(call.sessionId).lease_generation);
    const commands = [...h.telnyx.calls];
    expect(retained).toHaveLength(1);
    expect(sessionOwnership.getStore()).toBeUndefined();
    await retained[0]();
    expect(h.session(call.sessionId)).toMatchObject({ state: "ended", ended_at: customer.occurred_at });
    expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "deferred-customer"))
      .toMatchObject({ status: "processed", attempts: 2, delivery_count: 1 });
    expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "failed-operator"))
      .toMatchObject({ status: "failed", effect_failure_count: 1 });
    expect(Number(h.session(call.sessionId).lease_generation)).toBeGreaterThan(generation);
    expect(h.session(call.sessionId).pending_effects).toBeNull();
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)?.ended_at).toBe(customer.occurred_at);
    expect(h.call(call.sessionId)?.ended_at).toBe(customer.occurred_at);
    expect(h.presence(PROFILES.o1).current_session_id).toBeNull();
    const intervals = h.rows("motorist_call_participant_intervals");
    // Recording-disabled sessions intentionally create no participant intervals.
    expect(intervals).toEqual([]);
    expect(intervals.every(row => row.ended_at)).toBe(true);
    expect(h.telnyx.calls.slice(commands.length).filter(command =>
      ["dial", "bridge", "playbackStart", "speak", "gather", "gatherUsingSpeak", "gatherUsingAudio"].includes(command.method))).toEqual([]);
    expect(retained).toHaveLength(1);
  });
});

// Every test below invokes the host-retained callback, never the public replay
// helper, so it also exercises the eligibility gate and recursion suppression.
describe("failed owner replay boundaries", () => {
  it.each([false, true])("preserves a live customer with rejected audio=%s", async rejectAudio => {
    const { h, call, retained, finish, owner } = await failedOwner({ customer: false, rejectAudio });
    finish.release();
    expect(await owner).toMatchObject({ status: 200, outcome: rejectAudio ? "failed" : "processed" });
    const commands = [...h.telnyx.calls];
    await retained[0]();
    expect(h.session(call.sessionId)).toMatchObject({ state: "waiting", ended_at: null });
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(false);
    expect(h.telnyx.calls).toEqual(commands);
  });

  it.each(["lost", "throws"])("does not replay when the failure ledger write %s", async mode => {
    const { h, call, retained, finish, owner, customerSelfDrain } = await failedOwner();
    const finishRpc = h.db.rpcHandlers.get("motorist_telnyx_finish_webhook_event_v2")!;
    h.db.registerRpc("motorist_telnyx_finish_webhook_event_v2", (args, db) => {
      if (args.p_event_id === "failed-operator") {
        if (mode === "throws") throw new Error("failure ledger unavailable");
        return false;
      }
      return finishRpc(args, db);
    });
    finish.release();
    expect(await owner).toMatchObject({ status: 200, outcome: "failed" });
    for (const work of retained) await work();
    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "deferred-customer")?.attempts).toBe(1);
    // The failed owner is not eligible; the deferring host's own drain still is.
    await customerSelfDrain!();
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "deferred-customer")).toMatchObject({ status: "processed", attempts: 2, delivery_count: 1 });
  });

  it("falls back inline if host scheduling throws, retaining the owner's failed HTTP result", async () => {
    const { h, call, finish, owner } = await failedOwner();
    h.deps.deferMaintenance = () => { throw new Error("host unavailable"); };
    finish.release();
    expect(await owner).toMatchObject({ status: 200, outcome: "failed" });
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.logs).toContainEqual(expect.objectContaining({ message: "maintenance scheduling unavailable" }));
  });

  it.each([true, false])("defers under a fresh claim when release warns with failed apply=%s", async rejectAudio => {
    const { h, call, retained, finish, owner } = await failedOwner({ rejectAudio });
    const oldToken = h.session(call.sessionId).lease_token;
    const generation = h.session(call.sessionId).lease_generation;
    h.db.registerRpc("motorist_session_lease_release_v2", () => { throw new Error("release unavailable"); });
    finish.release();
    expect(await owner).toMatchObject({ status: 200, outcome: rejectAudio ? "failed" : "processed" });
    const commands = [...h.telnyx.calls];
    const acquire = h.db.rpcHandlers.get("motorist_session_lease_acquire_v2")!;
    const tokens: unknown[] = [];
    h.db.registerRpc("motorist_session_lease_acquire_v2", (args, db) => {
      expect(sessionOwnership.getStore()).toBeUndefined();
      tokens.push(args.p_token);
      return acquire(args, db);
    });
    await retained[0]();
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every(token => token !== oldToken)).toBe(true);
    expect(h.session(call.sessionId)).toMatchObject({ state: "waiting", lease_token: oldToken, lease_generation: generation });
    expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "deferred-customer"))
      .toMatchObject({ attempts: 2, delivery_count: 1, deferral_count: 2, effect_failure_count: 0, retry_state: "deferred" });
    expect(h.telnyx.calls).toEqual(commands);
    expect(h.logs).toContainEqual(expect.objectContaining({ message: "lease release pending expiry" }));
  });

  it("excludes operator, answer/bridge, awaiting-correlation and invalid customer identities", async () => {
    const { h, call, operator, retained, finish, owner } = await failedOwner({ customer: false });
    const template = { organization_id: ORG, call_session_id: call.telnyxSessionId, call_control_id: call.callControlId,
      connection_id: "app-test", event_type: "call.hangup", status: "failed", retry_state: "deferred", payload: {},
      next_attempt_at: h.db.nowIso(), occurred_at: h.db.nowIso(), received_at: h.db.nowIso(),
      claimed_at: null, attempts: 1, contract_version: 2, effect_failure_count: 0 };
    h.db.insert("motorist_call_legs", { organization_id: ORG, session_id: call.sessionId, role: "customer", telnyx_call_control_id: "other-saved-customer", state: "answered" });
    const invalid = [
      { event_id: "operator-only", call_control_id: operator },
      { event_id: "answer", event_type: "call.answered" },
      { event_id: "bridge", event_type: "call.bridged" },
      { event_id: "awaiting", retry_state: "awaiting_correlation" },
      { event_id: "foreign-leg", call_control_id: "foreign-customer" },
      { event_id: "other-saved-customer", call_control_id: "other-saved-customer" },
      { event_id: "future-backoff", next_attempt_at: new Date(h.db.now().getTime() + 60_000).toISOString() },
      { event_id: "foreign-org", organization_id: "foreign-org" },
      { event_id: "conflicting-sid", payload: { client_state: encodeClientState({ sid: "foreign-session", role: "customer" }) } },
      { event_id: "payload-operator", payload: { call_control_id: operator, client_state: encodeClientState({ sid: call.sessionId, role: "customer" }) } },
    ].map(row => ({ ...template, ...row }));
    h.db.seed("motorist_telnyx_webhook_events", invalid);
    finish.release();
    expect(await owner).toMatchObject({ outcome: "failed" });
    const before = invalid.map(row => h.rows("motorist_telnyx_webhook_events").find(item => item.event_id === row.event_id));
    await retained[0]();
    expect(invalid.map(row => h.rows("motorist_telnyx_webhook_events").find(item => item.event_id === row.event_id))).toEqual(before);
    expect(h.session(call.sessionId)).toMatchObject({ state: "waiting", ended_at: null });
  });

  it("keeps lookup failures recoverable without changing the owner's result", async () => {
    const { h, call, retained, finish, owner } = await failedOwner();
    finish.release();
    expect(await owner).toMatchObject({ status: 200, outcome: "failed" });
    h.db.failNext("motorist_call_legs", "select", "lookup unavailable");
    await retained[0]();
    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(h.logs).toContainEqual(expect.objectContaining({ message: "correlation replay deferred" }));
  });

  it("does not bypass a competing webhook claim", async () => {
    const { h, call, retained, finish, owner } = await failedOwner();
    finish.release();
    await owner;
    const row = h.db.storage("motorist_telnyx_webhook_events").find(row => row.event_id === "deferred-customer")!;
    row.claimed_at = h.db.nowIso();
    await retained[0]();
    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(row.attempts).toBe(1);
  });

  it("stops after two terminal facts and does not recursively retain work", async () => {
    const { h, call, retained, finish, owner } = await failedOwner();
    const template = h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "deferred-customer")!;
    h.db.seed("motorist_telnyx_webhook_events", [1, 2].map(index => ({ ...template, event_id: `extra-terminal-${index}` })));
    finish.release();
    await owner;
    await retained[0]();
    expect(h.session(call.sessionId).state).toBe("ended");
    const rows = h.rows("motorist_telnyx_webhook_events").filter(row => row.event_id === "deferred-customer" || String(row.event_id).startsWith("extra-terminal"));
    expect(rows.filter(row => row.status === "processed")).toHaveLength(2);
    expect(rows.filter(row => row.retry_state === "deferred")).toHaveLength(1);
    expect(retained).toHaveLength(1);
  });

  it("checks the wall clock budget again after waiting for SQL backoff", async () => {
    const { h, call, retained, finish, owner } = await failedOwner();
    finish.release();
    await owner;
    h.deps.sleep = async () => { vi.spyOn(Date, "now").mockReturnValue(Date.now() + 8_001); };
    await retained[0]();
    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "deferred-customer")?.attempts).toBe(1);
  });

  it.each([false, true])("closes recorded participant evidence with pending teardown=%s", async pendingTeardown => {
    const { h, call, retained, finish, owner } = await failedOwner({ recording: true });
    expect(h.telnyx.of("recordingStart")).toHaveLength(1);
    finish.release();
    expect(await owner).toMatchObject({ status: 200, outcome: "failed" });
    if (pendingTeardown) {
      // An already committed stop remains an obligation even if its provider
      // acknowledgement is unavailable when the customer terminal fact arrives.
      await ownedSessionWork(h.deps, call.sessionId, async () => {
        const session = h.session(call.sessionId) as SessionRow;
        const recorder = readMeta(session).recording!.recorders[0];
        await stageEffects(effectsDeps(h.deps), { session, expectedVersion: session.version,
          event: { kind: "app", type: "recording_stop", id: "pending-recording-stop", actorProfileId: PROFILES.o1, occurredAt: h.db.nowIso() },
          result: { next: emptyTransition(), guard: null, ignored: null, compensations: [],
            commands: [{ kind: "recording_stop", commandId: "durable-stop", leg: { callControlId: recorder.callControlId }, recorderId: recorder.id, epoch: recorder.epoch }] } });
      });
      h.telnyx.failAlways("recordingStop", new TelnyxCommandError({ code: "timeout", status: 503, detail: "stop acknowledgement unavailable" }));
    }
    await retained[0]();
    expect(h.session(call.sessionId)).toMatchObject({ state: "ended" });
    const intervals = h.rows("motorist_call_participant_intervals");
    expect(intervals.length).toBeGreaterThan(0);
    expect(intervals.every(row => row.ended_at)).toBe(true);
    const recording = readMeta(h.session(call.sessionId) as SessionRow).recording!;
    expect(recording.recorders.length).toBeGreaterThan(0);
    expect(recording.recorders.every(recorder => recorder.desired === "stopped")).toBe(true);
    if (pendingTeardown) {
      expect(h.telnyx.of("recordingStop").length).toBeGreaterThan(0);
      expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries.some(entry => entry.id === "pending-recording-stop")).toBe(true);
      expect(h.session(call.sessionId).effects_next_attempt_at).toBeTruthy();
    } else {
      // The exact customer hangup itself proves this recorder stopped.
      expect(recording.recorders.every(recorder => recorder.observed === "stopped")).toBe(true);
      expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toEqual([]);
    }
  });
});
