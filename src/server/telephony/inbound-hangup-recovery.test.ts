import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { hangupCall } from "./call-actions";
import { completeVerifiedInboundHangup, recoverUnknownInboundHangup } from "./inbound-hangup-recovery";
import { ownedSessionWork, runSessionEvent } from "./session-runner";
import { sessionOwnership } from "./ownership";
import { readPendingEffects } from "./state/continuation";
import { parseTelnyxEnvelope } from "./state/events";
import { payloadFingerprint } from "./provider-journal";
import { reconciledHangupEvent } from "./call-reconciliation";
import { commandKey, type LegRow, type SessionEvent, type SessionRow } from "./state/types";
import { TelnyxCommandError } from "./telnyx/client";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
const actor = { profileId: PROFILES.o1, role: "admin" as const };
const sweep = (h: TelephonyHarness): SessionEvent => ({ kind: "app", type: "sweep", id: h.nextEventId(), actorProfileId: null, occurredAt: h.now().toISOString() });
const snapshot = (h: TelephonyHarness, sessionId: string) => ({ session: structuredClone(h.session(sessionId)) as SessionRow, legs: structuredClone(h.legs(sessionId)) as LegRow[] });
const pendingHangups = (h: TelephonyHarness, sessionId: string) => readPendingEffects(h.session(sessionId) as SessionRow).entries
  .flatMap(entry => entry.commands.filter(command => command.kind === "hangup" && !entry.completedCommands.includes(commandKey(command))));

async function failedHangup() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  vi.stubEnv("TELNYX_RECORDING_ENABLED", "false");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  const call = await h.inbound({ to: NUMBERS.allianz, answer: false });
  h.telnyx.failNext("hangup", new Error("transport failed before provider execution"));
  await expect(hangupCall(h.deps, actor, call.sessionId)).rejects.toMatchObject({ status: 502 });
  const original = h.rows("motorist_provider_commands").find(row => row.path === `/calls/${encodeURIComponent(call.callControlId)}/actions/hangup`)!;
  expect(original.outcome).toBe("unknown");
  expect(pendingHangups(h, call.sessionId)).toHaveLength(1);
  return { h, call, original };
}
const recover = (h: TelephonyHarness, sessionId: string) => runSessionEvent(h.deps, sessionId, sweep(h));

describe("bounded recovery of an inbound customer hangup", () => {
  it("verifies the physical leg, retries the same wire command, and closes the leg/history without a webhook", async () => {
    const { h, call, original } = await failedHangup();
    const before = h.telnyx.of("hangup").length;
    h.advance(30_001);
    const result = await recover(h, call.sessionId);
    expect(result.inboundHangupRecovery).toMatchObject({ status: "terminal_confirmed", attemptCount: 1 });
    expect(h.telnyx.of("hangup")).toHaveLength(before + 1);
    expect(h.telnyx.of("hangup").at(-1)?.params).toMatchObject({ commandId: original.command_id, body: original.request_payload });
    expect(h.telnyx.of("hangup").at(-1)?.params.journalCommandId).not.toBe(original.command_id);
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(true);
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)?.ended_at).toBeTruthy();
    expect(pendingHangups(h, call.sessionId)).toHaveLength(0);
    expect(h.call(call.sessionId)?.ended_at).toBeTruthy();
    await recover(h, call.sessionId);
    expect(h.telnyx.of("hangup")).toHaveLength(before + 1);
    expect(h.session(call.sessionId).pending_effects).toBeNull();
  });

  it("does not retry before the cooldown and never retires the pending command from a late original 2xx", async () => {
    const { h, call, original } = await failedHangup();
    h.db.update("motorist_provider_commands", { outcome: "accepted", result: { data: { result: "ok" } } }, row => row.command_id === original.command_id);
    const before = h.telnyx.of("hangup").length;
    const result = await recover(h, call.sessionId);
    expect(result.inboundHangupRecovery?.status).toBe("backoff");
    expect(h.telnyx.of("hangup")).toHaveLength(before);
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(false);
    expect(pendingHangups(h, call.sessionId)).toHaveLength(1);
  });

  it("resolves a performed command whose acknowledgement was lost without another send", async () => {
    const { h, call } = await failedHangup();
    h.telnyx.physical.ended(call.callControlId);
    const before = h.telnyx.of("hangup").length;
    const result = await recover(h, call.sessionId);
    expect(result.inboundHangupRecovery?.status).toBe("terminal_confirmed");
    expect(h.telnyx.of("hangup")).toHaveLength(before);
    expect(pendingHangups(h, call.sessionId)).toHaveLength(0);
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)?.ended_at).toBeTruthy();
  });

  it("retains the original obligation after a recovery HTTP success while the provider still reports alive", async () => {
    const { h, call } = await failedHangup();
    h.telnyx.setCallStatus(call.callControlId, { known: true, alive: true });
    h.advance(30_001);
    const result = await recover(h, call.sessionId);
    expect(result.inboundHangupRecovery?.status).toBe("retry_pending");
    expect(pendingHangups(h, call.sessionId)).toHaveLength(1);
    const before = h.telnyx.of("hangup").length;
    await recover(h, call.sessionId);
    expect(h.telnyx.of("hangup")).toHaveLength(before);
    expect(pendingHangups(h, call.sessionId)).toHaveLength(1);
  });

  it("uses two durable attempt slots, then checks status without creating further sends", async () => {
    const { h, call } = await failedHangup();
    h.telnyx.failAlways("hangup", new Error("still disconnected"));
    const before = h.telnyx.of("hangup").length;
    for (let pass = 0; pass < 2; pass += 1) {
      h.advance(30_001);
      expect((await recover(h, call.sessionId)).inboundHangupRecovery).toMatchObject({ status: "retry_pending", attemptCount: pass + 1 });
    }
    h.advance(30_001);
    expect((await recover(h, call.sessionId)).inboundHangupRecovery).toMatchObject({ status: "retry_exhausted", attemptCount: 2 });
    h.advance(300_000);
    await recover(h, call.sessionId);
    expect(h.telnyx.of("hangup")).toHaveLength(before + 2);
    expect(pendingHangups(h, call.sessionId)).toHaveLength(1);
    expect(new Set(h.telnyx.of("hangup").slice(-2).map(row => row.params.journalCommandId)).size).toBe(2);
  });

  it("consumes a 429 slot without hidden immediate retry and respects Retry-After before allocating the next", async () => {
    const { h, call } = await failedHangup();
    h.advance(30_001);
    h.telnyx.failNext("hangup", new TelnyxCommandError({ code: "rate_limited", status: 429, retryable: true }));
    const before = h.telnyx.of("hangup").length;
    expect((await recover(h, call.sessionId)).inboundHangupRecovery?.status).toBe("retry_pending");
    expect(h.telnyx.of("hangup")).toHaveLength(before + 1);
    const slot = h.rows("motorist_provider_commands").find(row => row.outcome === "rate_limited")!;
    h.db.update("motorist_provider_commands", { next_attempt_at: new Date(h.now().getTime() + 120_000).toISOString() }, row => row.command_id === slot.command_id);
    h.advance(60_000);
    expect((await recover(h, call.sessionId)).inboundHangupRecovery?.status).toBe("backoff");
    expect(h.telnyx.of("hangup")).toHaveLength(before + 1);
    h.advance(60_001);
    expect((await recover(h, call.sessionId)).inboundHangupRecovery).toMatchObject({ status: "terminal_confirmed", attemptCount: 2 });
    expect(h.telnyx.of("hangup")).toHaveLength(before + 2);
  });

  it("does not send through a definitive refusal, but terminal evidence can settle the rejected original", async () => {
    const { h, call, original } = await failedHangup();
    h.db.update("motorist_provider_commands", { outcome: "rejected" }, row => row.command_id === original.command_id);
    const before = h.telnyx.of("hangup").length;
    h.advance(30_001);
    expect((await recover(h, call.sessionId)).inboundHangupRecovery?.status).toBe("rejected");
    expect(h.telnyx.of("hangup")).toHaveLength(before);
    expect(pendingHangups(h, call.sessionId)).toHaveLength(1);
    h.telnyx.physical.ended(call.callControlId);
    expect((await recover(h, call.sessionId)).inboundHangupRecovery?.status).toBe("terminal_confirmed");
    expect(pendingHangups(h, call.sessionId)).toHaveLength(0);
    expect(h.rows("motorist_provider_commands").find(row => row.command_id === original.command_id)?.outcome).toBe("rejected");
  });

  it.each([
    ["unknown", { known: false, alive: false, raw: null }],
    ["missing alive", { known: true, alive: false, raw: {} }],
    ["wrong ID", { known: true, alive: false, raw: { call_control_id: "another-leg", is_alive: false } }],
  ])("keeps %s provider status pending", async (_name, status) => {
    const { h, call } = await failedHangup();
    h.advance(30_001);
    vi.spyOn(h.telnyx.client, "retrieveCall").mockResolvedValue({ callControlId: call.callControlId, callSessionId: null, ...status });
    const before = h.telnyx.of("hangup").length;
    expect((await recover(h, call.sessionId)).inboundHangupRecovery?.status).toBe("provider_unknown");
    expect(h.telnyx.of("hangup")).toHaveLength(before);
    expect(pendingHangups(h, call.sessionId)).toHaveLength(1);
  });

  it("rejects foreign TEST provenance before even requesting provider status", async () => {
    const { h, call } = await failedHangup();
    h.telnyx.client.config.testSafety = { restricted: true, deploymentAllowed: true, enabled: false,
      allowedNumbers: [], fromNumbers: [], allowAnyPhoneNumber: true, smsAllowAnyRecipient: false, aiSipTarget: null, smsAlphaSender: null };
    h.db.update("motorist_telnyx_webhook_events", { connection_id: "production-app" }, row => row.call_control_id === call.callControlId);
    const read = vi.spyOn(h.telnyx.client, "retrieveCall");
    const before = h.telnyx.of("hangup").length;
    h.advance(30_001);
    expect((await recover(h, call.sessionId)).inboundHangupRecovery?.status).toBe("unavailable");
    expect(read).not.toHaveBeenCalled();
    expect(h.telnyx.of("hangup")).toHaveLength(before);
    expect(pendingHangups(h, call.sessionId)).toHaveLength(1);
  });

  it("allows proven TEST cleanup after creation is disabled", async () => {
    const { h, call } = await failedHangup();
    h.telnyx.client.config.testSafety = { restricted: true, deploymentAllowed: true, enabled: false,
      allowedNumbers: [], fromNumbers: [], allowAnyPhoneNumber: true, smsAllowAnyRecipient: false, aiSipTarget: null, smsAlphaSender: null };
    h.advance(30_001);
    expect((await recover(h, call.sessionId)).inboundHangupRecovery?.status).toBe("terminal_confirmed");
    expect(pendingHangups(h, call.sessionId)).toHaveLength(0);
  });

  it("retains scheduling after terminal observation until its exact leg fact is durable", async () => {
    const { h, call } = await failedHangup();
    h.telnyx.physical.ended(call.callControlId);
    await ownedSessionWork(h.deps, call.sessionId, async () => {
      const observed = await recoverUnknownInboundHangup(h.deps, snapshot(h, call.sessionId), sweep(h));
      expect(observed.recovery.status).toBe("terminal_confirmed");
      expect(await completeVerifiedInboundHangup(h.deps, observed)).toBeNull();
      expect(pendingHangups(h, call.sessionId)).toHaveLength(1);
    });
    await recover(h, call.sessionId);
    expect(pendingHangups(h, call.sessionId)).toHaveLength(0);
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)?.ended_at).toBeTruthy();
  });

  it("keeps a lost recovery-prepare response in its existing slot instead of duplicating sends", async () => {
    const { h, call, original } = await failedHangup();
    const prepare = h.db.rpcHandlers.get("motorist_provider_command_prepare_v2")!;
    let lost = false;
    h.db.registerRpc("motorist_provider_command_prepare_v2", async (args, db) => {
      const result = await prepare(args, db);
      if (!lost && args.p_command_id !== original.command_id && String(args.p_path).endsWith("/hangup")) { lost = true; throw new Error("prepare response lost"); }
      return result;
    });
    h.advance(30_001);
    const before = h.telnyx.of("hangup").length;
    expect((await recover(h, call.sessionId)).inboundHangupRecovery).toMatchObject({ status: "retry_pending", attemptCount: 1 });
    expect(h.telnyx.of("hangup")).toHaveLength(before);
    expect((await recover(h, call.sessionId)).inboundHangupRecovery?.status).toBe("backoff");
    h.advance(30_001);
    expect((await recover(h, call.sessionId)).inboundHangupRecovery).toMatchObject({ status: "terminal_confirmed", attemptCount: 2 });
    expect(h.telnyx.of("hangup")).toHaveLength(before + 1);
  });

  it("does not start database or provider work once the reserved deadline is consumed", async () => {
    const { h, call } = await failedHangup();
    await ownedSessionWork(h.deps, call.sessionId, async () => {
      sessionOwnership.getStore()!.deadline = Date.now() + 7_999;
      h.db.log.length = 0;
      const before = h.telnyx.calls.length;
      const result = await recoverUnknownInboundHangup(h.deps, snapshot(h, call.sessionId), sweep(h));
      expect(result.recovery.status).toBe("unavailable");
      expect(result.deferredCommandIds.size).toBe(1);
      expect(h.db.log).toEqual([]);
      expect(h.telnyx.calls).toHaveLength(before);
    });
  });

  it("refuses another organization's scope and does not touch a newer call", async () => {
    const { h, call } = await failedHangup();
    const newCall = await h.inbound({ to: NUMBERS.allianz, answer: false });
    h.advance(30_001);
    await ownedSessionWork(h.deps, call.sessionId, async () => {
      const result = await recoverUnknownInboundHangup({ ...h.deps, organizationId: `${ORG}-foreign` }, snapshot(h, call.sessionId), sweep(h));
      expect(result.recovery.status).toBe("skipped");
    });
    await recover(h, call.sessionId);
    expect(h.telnyx.physical.legs.get(newCall.callControlId)?.ended).toBe(false);
    expect(h.session(newCall.sessionId).termination_requested_at).toBeFalsy();
  });

  it("uses current exact terminal facts without an additional provider GET", async () => {
    const { h, call } = await failedHangup();
    const read = vi.spyOn(h.telnyx.client, "retrieveCall");
    await h.legEvent(call.callControlId, "call.hangup");
    expect(read).not.toHaveBeenCalled();
    expect(pendingHangups(h, call.sessionId)).toHaveLength(0);
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)?.ended_at).toBeTruthy();
  });

  it("does not add status requests to a successful first hangup", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
    const call = await h.inbound({ answer: false });
    const read = vi.spyOn(h.telnyx.client, "retrieveCall");
    await hangupCall(h.deps, actor, call.sessionId);
    expect(read).not.toHaveBeenCalled();
    expect(h.telnyx.of("hangup")).toHaveLength(1);
  });

  it("keeps a late-accepted unresolved command gated on a re-click and unrelated provider callback", async () => {
    const { h, call, original } = await failedHangup();
    h.db.update("motorist_provider_commands", { outcome: "accepted", result: { data: { result: "ok" } } }, row => row.command_id === original.command_id);
    const before = h.telnyx.of("hangup").length;
    await expect(hangupCall(h.deps, actor, call.sessionId)).rejects.toMatchObject({ status: 409 });
    expect(pendingHangups(h, call.sessionId).map(commandKey)).toContain(original.command_id);
    await h.legEvent(call.callControlId, "call.answered");
    expect(pendingHangups(h, call.sessionId).map(commandKey)).toContain(original.command_id);
    expect(h.telnyx.of("hangup")).toHaveLength(before);
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(false);
  });

  it("preserves successful terminal recovery while continuing an unrelated provider event", async () => {
    const { h, call } = await failedHangup();
    h.telnyx.physical.ended(call.callControlId);
    const event = parseTelnyxEnvelope(h.envelope("call.playback.ended", { call_control_id: call.callControlId }))!;
    const result = await runSessionEvent(h.deps, call.sessionId, event);
    expect(result.inboundHangupRecovery?.status).toBe("terminal_confirmed");
    expect(pendingHangups(h, call.sessionId)).toHaveLength(0);
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)?.ended_at).toBeTruthy();
  });

  it.each([false, true])("replays terminal staging after a lost response (stage committed: %s)", async committed => {
    const { h, call } = await failedHangup();
    h.telnyx.physical.ended(call.callControlId);
    const stage = h.db.rpcHandlers.get("motorist_stage_transition_v1")!;
    let interrupted = false;
    h.db.registerRpc("motorist_stage_transition_v1", async (args, db) => {
      const entry = (args.p_main as { entry?: { event?: { id?: string } } }).entry;
      if (!interrupted && entry?.event?.id?.startsWith("reconcile:")) {
        interrupted = true;
        if (committed) await stage(args, db);
        throw { message: "AbortError: terminal stage response lost", code: "" };
      }
      return stage(args, db);
    });
    await expect(recover(h, call.sessionId)).rejects.toMatchObject({ name: "SessionEventDeferredError" });
    expect(interrupted).toBe(true);
    expect(pendingHangups(h, call.sessionId)).toHaveLength(1);
    expect(h.session(call.sessionId).effects_next_attempt_at).toBeTruthy();
    const result = await recover(h, call.sessionId);
    expect(result.inboundHangupRecovery?.status).toBe("terminal_confirmed");
    expect(pendingHangups(h, call.sessionId)).toHaveLength(0);
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)?.ended_at).toBeTruthy();
  });

  it("retains a failed evidence RPC instead of inventing journal adoption", async () => {
    const { h, call } = await failedHangup();
    h.telnyx.physical.ended(call.callControlId);
    h.db.registerRpc("motorist_provider_command_result_v2", () => false);
    const result = await recover(h, call.sessionId);
    expect(result.inboundHangupRecovery?.status).toBe("unavailable");
    expect(pendingHangups(h, call.sessionId)).toHaveLength(1);
    expect(h.rows("motorist_provider_commands").filter(row => row.path === `/calls/${call.callControlId}/actions/hangup`)[0].outcome).toBe("unknown");
  });

  it("does not confuse sub-millisecond earlier terminal facts or a backwards status clock with post-dispatch evidence", async () => {
    const { h, call, original } = await failedHangup();
    h.db.update("motorist_provider_commands", { first_dispatched_at: "2026-09-03T08:00:00.000900Z" }, row => row.command_id === original.command_id);
    h.telnyx.physical.ended(call.callControlId);
    const result = await recover(h, call.sessionId);
    expect(result.inboundHangupRecovery?.status).toBe("unavailable");
    expect(pendingHangups(h, call.sessionId)).toHaveLength(1);
    h.advance(1);
    expect((await recover(h, call.sessionId)).inboundHangupRecovery?.status).toBe("terminal_confirmed");
  });

  it("recovers a lost retry acknowledgement from the physical state without spending another slot", async () => {
    const { h, call } = await failedHangup();
    h.advance(30_001);
    h.telnyx.loseNextResponse("hangup");
    const before = h.telnyx.of("hangup").length;
    expect((await recover(h, call.sessionId)).inboundHangupRecovery).toMatchObject({ status: "retry_pending", attemptCount: 1 });
    expect(pendingHangups(h, call.sessionId)).toHaveLength(1);
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(true);
    expect((await recover(h, call.sessionId)).inboundHangupRecovery?.status).toBe("terminal_confirmed");
    expect(h.telnyx.of("hangup")).toHaveLength(before + 1);
    expect(pendingHangups(h, call.sessionId)).toHaveLength(0);
  });

  it("uses one deterministic original and retry budget when old duplicate intents are returned in different orders", async () => {
    const { h, call, original } = await failedHangup();
    const duplicateId = "ffffffff-ffff-5fff-bfff-ffffffffffff";
    const payload = { ...(original.request_payload as Record<string, unknown>), command_id: duplicateId };
    h.db.insert("motorist_provider_commands", { ...original, id: "duplicate-original-fixture", command_id: duplicateId, request_payload: payload,
      first_dispatched_at: "2026-09-03T08:00:00.000001Z", fingerprint: payloadFingerprint({ method: "POST", path: original.path, body: payload }) });
    const pending = readPendingEffects(h.session(call.sessionId) as SessionRow);
    const entry = structuredClone(pending.entries[0]);
    entry.id = `${entry.id}:duplicate`;
    entry.commands = entry.commands.map(command => command.kind === "hangup" ? { ...command, commandId: duplicateId } : command);
    h.db.update("motorist_call_sessions", { pending_effects: { version: 1, entries: [...pending.entries, entry] } }, row => row.id === call.sessionId);
    h.telnyx.failAlways("hangup", new Error("network remains down"));
    h.advance(30_001);
    await recover(h, call.sessionId);
    h.db.storage("motorist_provider_commands").reverse();
    h.advance(30_001);
    expect((await recover(h, call.sessionId)).inboundHangupRecovery?.attemptCount).toBe(2);
    expect(h.telnyx.of("hangup").slice(-2).every(row => row.params.commandId === original.command_id)).toBe(true);
    expect(pendingHangups(h, call.sessionId)).toHaveLength(2);
  });

  it.each(["call_leg_id", "call_session_id"])("refuses a matching control ID with another raw %s", async key => {
    const { h, call } = await failedHangup();
    vi.spyOn(h.telnyx.client, "retrieveCall").mockResolvedValue({ callControlId: call.callControlId, known: true, alive: false, callSessionId: null,
      raw: { call_control_id: call.callControlId, is_alive: false, [key]: "another-provider-identity" } });
    expect((await recover(h, call.sessionId)).inboundHangupRecovery?.status).toBe("provider_unknown");
    expect(pendingHangups(h, call.sessionId)).toHaveLength(1);
  });

  it("does not trust a generic known:true synthetic event without the private strict status proof", async () => {
    const { h, call } = await failedHangup();
    const read = vi.spyOn(h.telnyx.client, "retrieveCall");
    await ownedSessionWork(h.deps, call.sessionId, async () => {
      const result = await recoverUnknownInboundHangup(h.deps, snapshot(h, call.sessionId), reconciledHangupEvent(call.callControlId, h.now(), true));
      expect(result.recovery.status).toBe("backoff");
      expect(result.terminal).toBeUndefined();
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(pendingHangups(h, call.sessionId)).toHaveLength(1);
  });

  it("retains the gate when journal reads fail, even if the original later appears accepted", async () => {
    const { h, call, original } = await failedHangup();
    h.db.update("motorist_provider_commands", { outcome: "accepted" }, row => row.command_id === original.command_id);
    h.db.failNext("motorist_provider_commands", "select", "database unavailable");
    expect((await recover(h, call.sessionId)).inboundHangupRecovery?.status).toBe("unavailable");
    expect(pendingHangups(h, call.sessionId)).toHaveLength(1);
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(false);
  });

  it("does not dispatch a recovery command after another owner replaces the lease during status retrieval", async () => {
    const { h, call } = await failedHangup();
    h.advance(30_001);
    const read = h.telnyx.client.retrieveCall.bind(h.telnyx.client);
    vi.spyOn(h.telnyx.client, "retrieveCall").mockImplementation(async id => {
      const result = await read(id);
      h.db.update("motorist_call_sessions", { lease_token: "new-owner", lease_generation: 500 }, row => row.id === call.sessionId);
      return result;
    });
    const before = h.telnyx.of("hangup").length;
    await expect(recover(h, call.sessionId)).rejects.toMatchObject({ name: "SessionLeaseLostError" });
    expect(h.telnyx.of("hangup")).toHaveLength(before);
    expect(pendingHangups(h, call.sessionId)).toHaveLength(1);
  });
});
