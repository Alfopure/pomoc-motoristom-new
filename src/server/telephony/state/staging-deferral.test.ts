import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { processTelnyxEvent } from "../telnyx/event-processor";
import { encodeClientState } from "../telnyx/client-state";
import { readPendingEffects, type EffectContinuation } from "./continuation";
import { emptyTransition, toJson, type SessionRow } from "./types";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function talkingCall() {
  vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "false");
  vi.stubEnv("TELNYX_RECORDING_ENABLED", "false");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  const call = await h.inbound({ to: NUMBERS.allianz });
  const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  await h.legEvent(operator, "call.answered");
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  expect(h.session(call.sessionId)).toMatchObject({ state: "talking", writer_contract: 2 });
  return { h, call, operator };
}

function ledger(h: TelephonyHarness, eventId: string) { return h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === eventId)!; }

describe("transient atomic transition staging", () => {
  it.each([
    { code: "", message: "motorist_session_lease_renew_v2: AbortError: owned database request exceeded 4000 ms" },
    { code: "ABORT_ERR", message: "session lease unavailable during effects" },
  ])("defers an unapplied customer hangup after $message and drains it without cron", async (failure) => {
    const { h, call, operator } = await talkingCall();
    const eventId = "staging-timeout-hangup";
    const queued: Array<() => Promise<void>> = [];
    const commandsBefore = h.telnyx.calls.length;
    h.db.failNext("motorist_stage_transition_v1", "rpc", { ...failure, details: null, hint: null });
    const result = await processTelnyxEvent({ ...h.deps, deferMaintenance: work => { queued.push(work); } }, h.envelope("call.hangup", {
      call_control_id: call.callControlId, call_session_id: call.telnyxSessionId, hangup_cause: "normal_clearing",
      client_state: encodeClientState(h.clientStateOf(call.callControlId)),
    }, eventId));

    // A failed stage is not an applied fact. The durable inbox requests retry;
    // no provider command from this transition was admitted or sent.
    expect(result).toMatchObject({ status: 500, outcome: "failed", error: expect.stringContaining("transition_staging_unavailable") });
    expect(h.telnyx.calls).toHaveLength(commandsBefore);
    expect(ledger(h, eventId)).toMatchObject({ status: "failed", retry_state: "deferred", effect_failure_count: 0, deferral_count: 1 });
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)?.ended_at).toBeNull();
    expect(h.session(call.sessionId).lease_token).toBeNull();
    expect(queued).toHaveLength(1);

    await queued[0]();
    expect(ledger(h, eventId)).toMatchObject({ status: "processed", attempts: 2, effect_failure_count: 0, deferral_count: 1 });
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)?.ended_at).toBe(ledger(h, eventId).occurred_at);
    expect(h.session(call.sessionId)).toMatchObject({ state: "wrap_up", lease_token: null });
    expect(h.telnyx.of("hangup").filter(command => command.params.callControlId === operator)).toHaveLength(1);
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toEqual([]);
  });

  it.each([false, true])("recovers a committed stage whose response timed out without duplicate effects, older audio pending=%s", async (olderAudio) => {
    const { h, call, operator } = await talkingCall();
    const eventId = "staging-response-lost";
    const stage = h.db.rpcHandlers.get("motorist_stage_transition_v1")!;
    const bridgesBefore = h.telnyx.of("bridge").length;
    let lost = false;
    h.db.registerRpc("motorist_stage_transition_v1", async (args, db) => {
      const result = await stage(args, db);
      if (!lost) {
        lost = true;
        if (olderAudio) {
          const row = db.storage("motorist_call_sessions").find(row => row.id === call.sessionId)!;
          const terminal = readPendingEffects(row as SessionRow).entries[0];
          const previous: EffectContinuation = { ...structuredClone(terminal), id: "older-audio", generation: terminal.generation - 1,
            event: { kind: "app", type: "unhold", id: "older-audio", actorProfileId: PROFILES.o1, occurredAt: h.now().toISOString() },
            transition: emptyTransition(), commands: [{ kind: "bridge", commandId: "older-bridge", leg: { callControlId: call.callControlId }, target: { callControlId: operator } }] };
          row.pending_effects = toJson({ version: 1, entries: [previous, terminal] });
        }
        throw new DOMException("staging response timed out", "TimeoutError");
      }
      return result;
    });
    const queued: Array<() => Promise<void>> = [];
    const response = await processTelnyxEvent({ ...h.deps, deferMaintenance: work => { queued.push(work); } }, h.envelope("call.hangup", {
      call_control_id: call.callControlId, call_session_id: call.telnyxSessionId, hangup_cause: "normal_clearing",
      client_state: encodeClientState(h.clientStateOf(call.callControlId)),
    }, eventId));
    expect(response).toMatchObject({ status: 500, outcome: "failed" });
    expect(ledger(h, eventId)).toMatchObject({ retry_state: "deferred", effect_failure_count: 0 });
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries.map(entry => entry.id)).toEqual(olderAudio ? ["older-audio", eventId] : [eventId]);
    expect(h.telnyx.of("hangup").filter(command => command.params.callControlId === operator)).toHaveLength(0);

    expect(queued).toHaveLength(1);
    await queued[0]();
    expect(ledger(h, eventId)).toMatchObject({ status: "processed", attempts: 2, effect_failure_count: 0 });
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toEqual([]);
    expect(h.telnyx.of("hangup").filter(command => command.params.callControlId === operator)).toHaveLength(1);
    expect(h.telnyx.of("bridge")).toHaveLength(bridgesBefore);
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)?.ended_at).toBe(ledger(h, eventId).occurred_at);
    expect(h.rows("motorist_call_events").filter(row => row.event_fingerprint === eventId)).toHaveLength(1);
  });

  it.each([
    { code: "XX000", message: "missing rejected transition" },
    { code: "42501", message: "permission denied" },
    { code: "42501", message: "permission denied: AbortError: cannot disguise a SQL refusal" },
  ])("preserves the failure budget for permanent staging errors: $message", async (failure) => {
    const { h, call } = await talkingCall();
    const eventId = "staging-permanent-failure";
    h.db.failNext("motorist_stage_transition_v1", "rpc", { ...failure, details: null, hint: null });
    const result = await h.legEvent(call.callControlId, "call.hangup", {}, eventId);
    expect(result).toMatchObject({ outcome: "failed", error: expect.stringContaining("Transition staging failed") });
    expect(ledger(h, eventId)).toMatchObject({ retry_state: "ready", effect_failure_count: 1, deferral_count: 0 });
  });
});
