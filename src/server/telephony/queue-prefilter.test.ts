import { describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, PROFILES } from "@/test/telephony-harness";
import { loadRoutingContext, loadSessionSnapshot } from "./session-runner";
import { sweepOverdueRingSteps } from "./routing/ring-plan";
import { processTelnyxEvent } from "./telnyx/event-processor";
import { reduce } from "./state/transitions";
import { readMeta, WAITING_TICK_STALE_MS, type SessionRow } from "./state/types";

async function fixture() {
  const h = createTelephonyHarness({ writerContract: 2, fallbackKind: "waiting_room", sweepAfterEvent: false });
  for (const id of Object.values(PROFILES)) h.setPresence(id, { status: "offline" });
  const call = await h.inbound({ to: NUMBERS.allianz });
  const backup = h.legByNumber(call.sessionId, NUMBERS.external)!;
  await h.legEvent(String(backup.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
  h.advance(6_000);
  expect(h.session(call.sessionId).state).toBe("waiting");
  return { h, call };
}

describe("queue sweep advisory prefilter", () => {
  it("offers the oldest waiting caller after a ringing operator is released, in retained maintenance", async () => {
    const { h, call } = await fixture();
    h.setPresence(PROFILES.o1, { status: "available" });
    h.touchDevice(PROFILES.o1);
    const ringing = await h.inbound({ to: NUMBERS.allianz });
    const operator = h.legFor(ringing.sessionId, PROFILES.o1)!;
    expect(operator).toBeDefined();
    expect(h.legFor(call.sessionId, PROFILES.o1)).toBeNull();
    const queued: Array<() => Promise<void>> = [];
    const result = await processTelnyxEvent({ ...h.deps, sweepAfterEvent: true, deferMaintenance: work => queued.push(work) },
      h.envelope("call.hangup", { call_control_id: operator.telnyx_call_control_id, call_session_id: operator.telnyx_session_id,
        hangup_cause: "call_rejected" }));
    expect(result.status).toBe(200);
    expect(h.legFor(call.sessionId, PROFILES.o1)).toBeNull();
    expect(queued).toHaveLength(1);
    await queued[0]();
    expect(h.legFor(call.sessionId, PROFILES.o1)?.ended_at).toBeNull();
    expect(h.session(call.sessionId).state).toBe("ringing");
  });
  it.each(["offline", "retry", "available", "clear idle"])("agrees with the reducer for %s operators", async mode => {
    const { h, call } = await fixture();
    if (mode !== "offline") { h.setPresence(PROFILES.o1, { status: "available" }); h.touchDevice(PROFILES.o1); }
    if (mode === "retry" || mode === "clear idle") {
      h.db.seed("motorist_ring_attempts", [{ organization_id: h.deps.organizationId, session_id: call.sessionId,
        profile_id: PROFILES.o1, member_kind: "operator", step_index: -1, result: "no_answer", offered_at: h.now().toISOString() }]);
    }
    if (mode === "retry") {
      const meta = readMeta(h.session(call.sessionId) as SessionRow);
      h.db.update("motorist_call_sessions", { metadata: { ...meta, queue: { ...meta.queue!, idle_since: null } } }, row => row.id === call.sessionId);
    }
    const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
    const event = { kind: "app" as const, type: "sweep" as const, id: "parity", actorProfileId: null, occurredAt: h.now().toISOString() };
    const context = await loadRoutingContext(h.deps, snapshot.session, event, snapshot.legs);
    const verdict = reduce(snapshot.session, snapshot.legs, snapshot.attempts, event, context);
    const before = h.db.log.length;
    const run = vi.fn(async () => undefined);
    const result = await sweepOverdueRingSteps({ ...h.deps, runSessionEvent: run });
    if (mode === "offline" || mode === "retry") {
      expect(verdict.ignored).toBe("sweep: queue has no new offer");
      expect(run).not.toHaveBeenCalled();
      expect(result.deferred).toContain(call.sessionId);
    } else {
      expect(verdict.ignored).toBeNull();
      expect(run).toHaveBeenCalledWith(call.sessionId, expect.any(Object), { known: expect.objectContaining({ id: call.sessionId }) });
    }
    expect(h.db.log.slice(before).every(row => row.operation === "select")).toBe(true);
    expect(h.session(call.sessionId).metadata).toEqual(snapshot.session.metadata);
  });

  it.each(["escalation", "audio", "expiry", "cancellation"])("does not skip %s maintenance with nobody available", async mode => {
    const { h, call } = await fixture();
    const meta = readMeta(h.session(call.sessionId) as SessionRow);
    if (mode === "escalation") meta.queue = { ...meta.queue!, idle_since: new Date(h.now().getTime() - 121_000).toISOString() };
    if (mode === "audio") meta.waiting = { ...meta.waiting!, last_tick_at: new Date(h.now().getTime() - WAITING_TICK_STALE_MS - 1).toISOString() };
    if (mode === "expiry") meta.waiting = { ...meta.waiting!, since: new Date(h.now().getTime() - 31 * 60_000).toISOString() };
    h.db.update("motorist_call_sessions", { metadata: meta, ...(mode === "cancellation" ? { cancellations_next_attempt_at: h.now().toISOString() } : {}) }, row => row.id === call.sessionId);
    const run = vi.fn(async () => undefined);
    await sweepOverdueRingSteps({ ...h.deps, runSessionEvent: run });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
