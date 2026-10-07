import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, PROFILES } from "@/test/telephony-harness";
import { continueAcceptedHangup, hangupCall } from "./call-actions";
import { sessionOwnership } from "./ownership";
import { readPendingEffects } from "./state/continuation";
import type { SessionRow } from "./state/types";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const actor = { profileId: PROFILES.o1, role: "admin" as const };

async function busyCall() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  vi.stubEnv("TELNYX_RECORDING_ENABLED", "false");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  const call = await h.inbound({ to: NUMBERS.allianz, answer: false });
  const acquire = h.db.rpcHandlers.get("motorist_session_lease_acquire_v2")!;
  const release = h.db.rpcHandlers.get("motorist_session_lease_release_v2")!;
  const held = await acquire({ p_session_id: call.sessionId, p_token: "another-handler", p_ttl_ms: 30_000 }, h.db) as { generation: number };
  expect(held?.generation).toBeGreaterThan(0);
  h.db.log.length = 0;
  return { h, call, release: () => release({ p_session_id: call.sessionId, p_token: "another-handler", p_generation: held.generation }, h.db) };
}

describe("durably accepted hangup under contention", () => {
  it("accepts once without waiting or claiming provider completion, then the retained continuation ends the call", async () => {
    const { h, call, release } = await busyCall();
    const before = h.telnyx.calls.length;
    const wait = vi.fn(async () => { await release(); });
    h.deps.sleep = wait;
    const result = await hangupCall(h.deps, actor, call.sessionId);
    expect(result).toMatchObject({ sessionId: call.sessionId, terminationPending: true, commands: [] });
    expect(h.session(call.sessionId).termination_requested_at).toBeTruthy();
    expect(wait).not.toHaveBeenCalled();
    expect(h.db.log.filter(row => row.table === "motorist_session_lease_acquire_v2")).toHaveLength(1);
    expect(h.telnyx.calls).toHaveLength(before);
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(false);

    await continueAcceptedHangup(h.deps, call.sessionId);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(true);
    expect(h.session(call.sessionId).lease_token).toBeNull();
    expect(h.session(call.sessionId).termination_next_attempt_at).toBeNull();
    const hangups = h.telnyx.of("hangup").length;
    await continueAcceptedHangup(h.deps, call.sessionId);
    expect(h.telnyx.of("hangup")).toHaveLength(hangups);
  });

  it("never acknowledges an intent write whose outcome was not confirmed", async () => {
    const { h, call } = await busyCall();
    h.db.failNext("motorist_session_terminate_v2", "rpc", "database unavailable");
    await expect(hangupCall(h.deps, actor, call.sessionId)).rejects.toMatchObject({ status: 500 });
    expect(h.session(call.sessionId).termination_requested_at).toBeFalsy();
    expect(h.db.log.filter(row => row.table === "motorist_session_lease_acquire_v2")).toHaveLength(0);
  });

  it("does not disguise an acquisition outage as proven contention", async () => {
    const { h, call } = await busyCall();
    h.db.failNext("motorist_session_lease_acquire_v2", "rpc", "database unavailable");
    await expect(hangupCall(h.deps, actor, call.sessionId)).rejects.toMatchObject({ status: 503, code: "session_event_deferred" });
    expect(h.session(call.sessionId).termination_requested_at).toBeTruthy();
  });

  it("does not start termination when the durable intent is absent", async () => {
    const { h, call, release } = await busyCall();
    await release();
    h.db.log.length = 0;
    const before = h.telnyx.calls.length;
    await continueAcceptedHangup(h.deps, call.sessionId);
    expect(h.db.log.filter(row => row.table === "motorist_session_lease_acquire_v2")).toHaveLength(0);
    expect(h.telnyx.calls).toHaveLength(before);
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(false);
  });

  it("retains an unknown provider teardown without falsely completing or blindly resending it", async () => {
    const { h, call, release } = await busyCall();
    expect(await hangupCall(h.deps, actor, call.sessionId)).toMatchObject({ terminationPending: true });
    const requestedAt = h.session(call.sessionId).termination_requested_at;
    await release();
    h.telnyx.failAlways("hangup", new Error("temporary provider transport failure"));

    await continueAcceptedHangup(h.deps, call.sessionId);
    expect(h.session(call.sessionId).termination_requested_at).toBe(requestedAt);
    expect(h.session(call.sessionId).lease_token).toBeNull();
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(false);
    const pending = readPendingEffects(h.session(call.sessionId) as SessionRow).entries;
    expect(pending.some(entry => entry.commands.some(command => command.kind === "hangup" && !entry.completedCommands.includes(command.commandId)))).toBe(true);

    h.telnyx.clearFailures();
    const dispatched = h.telnyx.of("hangup").length;
    await continueAcceptedHangup(h.deps, call.sessionId);
    // Transport recovery alone is not exact provider outcome evidence. The
    // existing journal must retain its unknown result instead of inventing an
    // acknowledgement or duplicating a command whose response was lost.
    expect(h.telnyx.of("hangup")).toHaveLength(dispatched);
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(false);
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries.length).toBeGreaterThan(0);
    expect(h.session(call.sessionId).termination_requested_at).toBe(requestedAt);
    expect(h.db.log.filter(row => row.table === "motorist_session_terminate_v2")).toHaveLength(1);
  });

  it("does no database work when the retained host deadline has expired", async () => {
    const { h, call } = await busyCall();
    expect(await hangupCall(h.deps, actor, call.sessionId)).toMatchObject({ terminationPending: true });
    const requestedAt = h.session(call.sessionId).termination_requested_at;
    h.db.log.length = 0;
    const before = h.telnyx.calls.length;
    await expect(continueAcceptedHangup(h.deps, call.sessionId, Date.now() - 1)).rejects.toMatchObject({ name: "SessionLeaseLostError" });
    expect(h.db.log).toEqual([]);
    expect(h.telnyx.calls).toHaveLength(before);
    expect(h.session(call.sessionId).termination_requested_at).toBe(requestedAt);
  });

  it("does not acquire ownership when loading consumes the remaining work budget", async () => {
    const { h, call } = await busyCall();
    expect(await hangupCall(h.deps, actor, call.sessionId)).toMatchObject({ terminationPending: true });
    const requestedAt = h.session(call.sessionId).termination_requested_at;
    vi.useFakeTimers();
    const started = Date.now();
    const readError = h.db.takeInjectedError.bind(h.db);
    vi.spyOn(h.db, "takeInjectedError").mockImplementation((table, operation) => {
      if (table === "motorist_call_sessions" && operation === "select") vi.setSystemTime(started + 9_000);
      return readError(table, operation);
    });
    h.db.log.length = 0;
    const before = h.telnyx.calls.length;
    await expect(continueAcceptedHangup(h.deps, call.sessionId, started + 16_000)).rejects.toMatchObject({ name: "SessionLeaseLostError" });
    expect(h.db.log.filter(row => row.table === "motorist_call_sessions" && row.operation === "select")).toHaveLength(1);
    expect(h.db.log.filter(row => row.table === "motorist_session_lease_acquire_v2")).toHaveLength(0);
    expect(h.telnyx.calls).toHaveLength(before);
    expect(h.session(call.sessionId).termination_requested_at).toBe(requestedAt);
  });

  it("keeps accepted teardown pending when the provider fence cannot renew its lease", async () => {
    const { h, call, release } = await busyCall();
    expect(await hangupCall(h.deps, actor, call.sessionId)).toMatchObject({ terminationPending: true });
    const requestedAt = h.session(call.sessionId).termination_requested_at;
    await release();
    const stage = h.db.rpcHandlers.get("motorist_stage_transition_v1")!;
    const renew = h.db.rpcHandlers.get("motorist_session_lease_renew_v2")!;
    h.db.registerRpc("motorist_stage_transition_v1", async (args, db) => {
      const staged = await stage(args, db);
      const owner = sessionOwnership.getStore()!;
      owner.acquiredAt = Date.now() - 6_000;
      return staged;
    });
    h.db.registerRpc("motorist_session_lease_renew_v2", () => {
      throw { code: "", message: "AbortError: owned database request exceeded 4000 ms", details: null, hint: null };
    });
    const before = h.telnyx.of("hangup").length;

    await continueAcceptedHangup(h.deps, call.sessionId);
    expect(h.db.log.filter(row => row.table === "motorist_session_lease_renew_v2").length).toBeGreaterThan(0);
    expect(h.telnyx.of("hangup")).toHaveLength(before);
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(false);
    expect(h.session(call.sessionId).termination_requested_at).toBe(requestedAt);
    expect(h.session(call.sessionId).lease_token).toBeNull();
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries.length).toBeGreaterThan(0);

    h.db.registerRpc("motorist_stage_transition_v1", stage);
    h.db.registerRpc("motorist_session_lease_renew_v2", renew);
    await continueAcceptedHangup(h.deps, call.sessionId);
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(true);
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toEqual([]);
    expect(h.session(call.sessionId).termination_requested_at).toBe(requestedAt);
  });

  it("rejects a foreign organisation before storing an intent", async () => {
    const { h, call } = await busyCall();
    await expect(hangupCall({ ...h.deps, organizationId: "00000000-0000-4000-8000-000000009999" }, actor, call.sessionId)).rejects.toMatchObject({ status: 404 });
    expect(h.session(call.sessionId).termination_requested_at).toBeFalsy();
  });
});
