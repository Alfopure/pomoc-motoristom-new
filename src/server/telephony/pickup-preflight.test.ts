import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_LIVENESS_WINDOW_MS } from "@/lib/telephony/device-liveness";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { PICKUP_LEASE_WAIT_MS, pickupWaitingCall } from "./call-actions";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
const presenceTable = "motorist_operator_presence";
const deviceTable = "motorist_operator_devices";
const mobileTable = "motorist_operator_mobile_devices";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// Pause execution of the first real fake-DB read, not construction of its
// thenable. All production lookup filters and query errors still run normally.
function controlRead(h: TelephonyHarness, tableName: string, rejection?: Error) {
  const gate = deferred();
  const started = deferred();
  const finished = deferred();
  let didStart = false;
  let intercepted = false;
  const from = vi.isMockFunction(h.client.from) ? vi.mocked(h.client.from).getMockImplementation()! : h.client.from.bind(h.client);
  vi.spyOn(h.client, "from").mockImplementation(table => {
    const query = from(table);
    if (table === tableName && !intercepted) {
      intercepted = true;
      const then = query.then.bind(query);
      query.then = (fulfilled, rejected) => {
        didStart = true;
        started.resolve();
        return gate.promise.then(() => {
          if (rejection) throw rejection;
          return then();
        }).finally(finished.resolve).then(fulfilled, rejected);
      };
    }
    return query;
  });
  return { started: started.promise, finished: finished.promise, release: gate.resolve, didStart: () => didStart };
}

async function fixture() {
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  for (const profile of Object.values(PROFILES)) h.setPresence(profile, { status: "offline" });
  const call = await h.inbound({ to: NUMBERS.allianz });
  await completeCallAnnouncements(h, call.sessionId);
  h.setPresence(actor.profileId, { status: "available" });
  h.db.log.length = 0;
  h.telnyx.calls.length = 0;
  return { h, sessionId: call.sessionId };
}

function expectNoDispatch(h: TelephonyHarness) {
  expect(h.db.log.filter(entry => entry.kind === "rpc" && entry.table === "motorist_presence_transition_v1")).toEqual([]);
  expect(h.telnyx.of("dial")).toEqual([]);
}

beforeEach(() => {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  for (const name of ["TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED"]) vi.stubEnv(name, "false");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("pickup preflight with local fake DB/provider", () => {
  it("starts the device read while presence is pending, inside the lease, and waits for both before reservation", async () => {
    const { h, sessionId } = await fixture();
    const presence = controlRead(h, presenceTable);
    const device = controlRead(h, deviceTable);
    const result = pickupWaitingCall(h.deps, actor, sessionId);
    await presence.started;
    await tick();
    const overlapped = device.didStart();
    const leaseHeld = Boolean(h.session(sessionId).lease_token);
    expectNoDispatch(h);
    // Always unblock the request, including on the old sequential implementation.
    presence.release();
    await device.started;
    await tick();
    expectNoDispatch(h);
    device.release();
    expect((await result).operatorLegCallControlId).toBeTruthy();
    expect(leaseHeld).toBe(true);
    expect(overlapped).toBe(true);
    expect(h.telnyx.of("dial")).toHaveLength(1);
  });

  it.each(["web", "mobile"] as const)("rejects a %s device that expires while the presence read is pending", async deviceKind => {
    const { h, sessionId } = await fixture();
    const table = deviceKind === "mobile" ? mobileTable : deviceTable;
    if (deviceKind === "mobile") h.db.seed(mobileTable, h.rows(deviceTable));
    h.db.update(table, { device_seen_at: new Date(h.now().getTime() - DEVICE_LIVENESS_WINDOW_MS + 1).toISOString() }, row => row.profile_id === actor.profileId);
    const presence = controlRead(h, presenceTable);
    const device = controlRead(h, table);
    const result = pickupWaitingCall({ ...h.deps, deviceKind }, actor, sessionId).catch(error => error);
    await presence.started;
    device.release();
    await tick();
    const overlapped = device.didStart();
    if (overlapped) await device.finished;
    h.advance(2);
    presence.release();
    expect(await result).toMatchObject({ status: 409, code: "device_offline" });
    expect(overlapped).toBe(true);
    expectNoDispatch(h);
  });

  it.each(["query error", "rejection"])("keeps a presence %s ahead of an already rejected device read", async mode => {
    const { h, sessionId } = await fixture();
    const presenceFailure = new Error("presence transport failed");
    const presence = controlRead(h, presenceTable, mode === "rejection" ? presenceFailure : undefined);
    const device = controlRead(h, deviceTable, new Error("device transport failed"));
    if (mode === "query error") h.db.failNext(presenceTable, "select", "presence query failed");
    const result = pickupWaitingCall(h.deps, actor, sessionId).catch(error => error);
    await presence.started;
    device.release();
    await tick(); // Device rejection must already have a handler while presence waits.
    const overlapped = device.didStart();
    presence.release();
    const error = await result;
    if (mode === "rejection") expect(error).toBe(presenceFailure);
    else expect(error).toMatchObject({ status: 500, message: "Prezenciu sa nepodarilo overiť: presence query failed" });
    expect(overlapped).toBe(true);
    expectNoDispatch(h);
  });

  it.each(["lookup", "liveness"])("keeps device %s errors ahead of presence admission", async failure => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    const { h, sessionId } = await fixture();
    h.setPresence(actor.profileId, { status: "paused" });
    if (failure === "lookup") h.db.failNext(deviceTable, "select", "device query failed");
    else h.db.update(deviceTable, { registration_state: "unregistered" }, row => row.profile_id === actor.profileId);
    const result = pickupWaitingCall(h.deps, actor, sessionId);
    await expect(result).rejects.toMatchObject(failure === "lookup"
      ? { status: 500, message: "Zariadenie sa nepodarilo načítať: device query failed" }
      : { status: 409, code: "device_offline" });
    expectNoDispatch(h);
  });

  it("keeps the presence query error ahead of a device query error", async () => {
    const { h, sessionId } = await fixture();
    h.db.failNext(presenceTable, "select", "presence query failed");
    h.db.failNext(deviceTable, "select", "device query failed");
    await expect(pickupWaitingCall(h.deps, actor, sessionId)).rejects.toMatchObject({
      status: 500, message: "Prezenciu sa nepodarilo overiť: presence query failed",
    });
    expectNoDispatch(h);
  });

  it("lets atomic reservation reject a new owner after the presence snapshot was read", async () => {
    const { h, sessionId } = await fixture();
    const presence = controlRead(h, presenceTable);
    const device = controlRead(h, deviceTable);
    const result = pickupWaitingCall(h.deps, actor, sessionId).catch(error => error);
    presence.release();
    await presence.finished;
    await device.started;
    h.setPresence(actor.profileId, { status: "on_call", current_session_id: "another-session" });
    device.release();
    expect(await result).toMatchObject({ status: 409, code: "operator_unavailable" });
    expect(h.telnyx.of("dial")).toEqual([]);
    expect(h.presence(actor.profileId).current_session_id).toBe("another-session");
    expect(h.db.log.filter(entry => entry.table === "motorist_presence_transition_v1")).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ p_action: "pickup", p_session_id: sessionId }) }),
    ]);
  });

  it("still gives competing pickups one reservation and one dial", async () => {
    const { h, sessionId } = await fixture();
    h.setPresence(PROFILES.o2, { status: "available" });
    const presence = controlRead(h, presenceTable);
    const first = pickupWaitingCall(h.deps, actor, sessionId);
    await presence.started;
    const results = Promise.allSettled([first, pickupWaitingCall(h.deps, { ...actor, profileId: PROFILES.o2 }, sessionId)]);
    await tick();
    presence.release();
    const outcomes = await results;
    expect(outcomes.map(result => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const winner = outcomes[0].status === "fulfilled" ? actor.profileId : PROFILES.o2;
    const loser = winner === actor.profileId ? PROFILES.o2 : actor.profileId;
    expect(h.telnyx.of("dial")).toHaveLength(1);
    expect(h.session(sessionId).presence_pickup).toMatchObject({ profileId: winner });
    expect(h.presence(loser)).toMatchObject({ status: "available", current_session_id: null });
  });

  it.each(["paused", "on_call"])("retains presence admission when the operator becomes %s during the read", async status => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    const { h, sessionId } = await fixture();
    const presence = controlRead(h, presenceTable);
    const result = pickupWaitingCall(h.deps, actor, sessionId).catch(error => error);
    await presence.started;
    await tick();
    h.setPresence(actor.profileId, { status, current_session_id: status === "on_call" ? "another-session" : null });
    presence.release();
    expect(await result).toMatchObject({ status: 409, code: "operator_unavailable" });
    expectNoDispatch(h);
  });

  it.each(["budget", "session"])("rejects failed %s admission before either preflight read", async failure => {
    const { h, sessionId } = await fixture();
    if (failure === "budget") h.db.update("motorist_telephony_settings", { daily_leg_soft_cap: 1 }, () => true);
    else h.db.update("motorist_call_sessions", { state: "ended", ended_at: h.now().toISOString() }, row => row.id === sessionId);
    await expect(pickupWaitingCall(h.deps, actor, sessionId)).rejects.toMatchObject({ code: failure === "budget" ? "daily_cap_reached" : "not_waiting" });
    expect(h.db.log.filter(entry => [presenceTable, deviceTable, mobileTable].includes(entry.table))).toEqual([]);
    expectNoDispatch(h);
  });

  it.each(["web", "mobile"] as const)("retains exact organization/profile/environment and %s device filters", async deviceKind => {
    const { h, sessionId } = await fixture();
    const table = deviceKind === "mobile" ? mobileTable : deviceTable;
    if (deviceKind === "mobile") h.db.seed(mobileTable, h.rows(deviceTable));
    // Stop after the preflight queries so later routing reads cannot mask them.
    const queries: Array<{ table: string; filters: unknown[][] }> = [];
    const from = h.client.from.bind(h.client);
    vi.spyOn(h.client, "from").mockImplementation(table => {
      const query = from(table);
      queries.push({ table, filters: vi.spyOn(query, "eq").mock.calls });
      return query;
    });
    h.db.failNext(presenceTable, "select", "stop after reads");
    await expect(pickupWaitingCall({ ...h.deps, deviceKind }, actor, sessionId)).rejects.toMatchObject({ status: 500 });
    expect(queries.find(entry => entry.table === presenceTable)?.filters).toEqual([
      ["organization_id", ORG], ["profile_id", actor.profileId],
    ]);
    expect(queries.find(entry => entry.table === table)?.filters).toEqual([
      ["organization_id", ORG], ["profile_id", actor.profileId], ["environment", "development"],
    ]);
    expect(h.db.log.some(entry => entry.table === (deviceKind === "mobile" ? deviceTable : mobileTable))).toBe(false);
    expectNoDispatch(h);
  });

  it("waits the pickup budget for a held lease and reads neither presence nor device", async () => {
    const { h, sessionId } = await fixture();
    h.db.registerRpc("motorist_session_lease_acquire_v2", () => null);
    h.deps.random = () => 0;
    // The harness sleep only moves the harness clock; the v2 wait loop reads
    // `Date.now()`, so it needs real timers driven under fake time.
    h.deps.sleep = ms => new Promise<void>(resolve => setTimeout(resolve, ms));
    vi.useFakeTimers();
    try {
      const started = Date.now();
      const pending = pickupWaitingCall(h.deps, actor, sessionId).catch(error => error);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error).toMatchObject({ name: "SessionLeaseBusyError", code: "session_busy", details: { leaseWaitMs: PICKUP_LEASE_WAIT_MS, eventType: "app.pickup" } });
      expect(Date.now() - started).toBeGreaterThanOrEqual(PICKUP_LEASE_WAIT_MS);
      const polls = h.db.log.filter(entry => entry.table === "motorist_session_lease_acquire_v2").length;
      expect(polls).toBeGreaterThan(7);
      expect(polls).toBeLessThanOrEqual(13);
      expect(error.details.polls).toBe(polls);
      // The preflight never left the lease: no reads while waiting, nothing dispatched.
      expect(h.db.log.filter(entry => [presenceTable, deviceTable, mobileTable].includes(entry.table))).toEqual([]);
      expectNoDispatch(h);
    } finally { vi.useRealTimers(); }
  });
});
