import { afterEach, describe, expect, it, vi } from "vitest";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { createTelephonyHarness, PROFILES } from "@/test/telephony-harness";
import { effectsDeps, ownedSessionWork } from "../session-runner";
import { ownershipRpc } from "../ownership";
import { reconciledHangupEvent } from "../call-reconciliation";
import { checkpointEffects, readPendingEffects, stageEffects } from "./continuation";
import { applyReduceResult, resumePendingEffects } from "./effects";
import { emptyTransition, type Command, type SessionRow } from "./types";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function pendingHangups(originalOutcome: "unknown" | "accepted" = "accepted") {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  vi.stubEnv("TELNYX_RECORDING_ENABLED", "false");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  const call = await h.inbound();
  await completeCallAnnouncements(h, call.sessionId);
  const operator = h.legFor(call.sessionId, PROFILES.o1)!;
  expect(operator).toBeTruthy();
  const eventId = "inbound-hangup-proof-required";
  const customerCommandId = "inbound-customer-hangup";
  const operatorCommandId = "independent-operator-hangup";
  const commands: Command[] = [
    { kind: "hangup", commandId: customerCommandId, leg: { callControlId: call.callControlId }, reason: "app_hangup", bestEffort: false },
    { kind: "hangup", commandId: operatorCommandId, leg: { callControlId: String(operator.telnyx_call_control_id) }, reason: "app_hangup", bestEffort: true },
  ];
  await ownedSessionWork(h.deps, call.sessionId, async () => {
    await ownershipRpc(h.deps.admin, "motorist_session_terminate_v2", { p_organization_id: h.deps.organizationId, p_session_id: call.sessionId });
    const session = h.session(call.sessionId) as SessionRow;
    const next = emptyTransition();
    next.session = { state: "ended", ended_at: h.now().toISOString() };
    await stageEffects(effectsDeps(h.deps), { session, expectedVersion: session.version,
      event: { kind: "app", type: "hangup", id: eventId, actorProfileId: PROFILES.o1, occurredAt: h.now().toISOString() },
      result: { next, commands, compensations: [], guard: null, ignored: null } });
    h.telnyx.failNext("hangup", new Error("response unavailable"));
    await expect(h.telnyx.client.hangup({ callControlId: call.callControlId, commandId: customerCommandId })).rejects.toThrow("response unavailable");
    const journal = h.rows("motorist_provider_commands").find(row => row.command_id === customerCommandId)!;
    expect(journal.outcome).toBe("unknown");
    if (originalOutcome === "accepted") {
      // Model the delayed original HTTP acknowledgement while the exact leg
      // still lacks terminal provider evidence. Use the real result RPC path.
      expect(await ownershipRpc(h.deps.admin, "motorist_provider_command_result_v2", {
        p_session_id: call.sessionId, p_command_id: customerCommandId, p_fingerprint: journal.fingerprint,
        p_generation: journal.dispatch_generation, p_token: journal.dispatch_token,
        p_status: 200, p_result: { data: { result: "ok" } },
      })).toBe(true);
    }
  });
  expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(false);
  h.telnyx.calls.length = 0;
  return { h, call, eventId, customerCommandId, operatorCommandId, operator: String(operator.telnyx_call_control_id) };
}

async function resume(t: Awaited<ReturnType<typeof pendingHangups>>, options: Parameters<typeof resumePendingEffects>[2] = {}) {
  return ownedSessionWork(t.h.deps, t.call.sessionId, () => resumePendingEffects({
    ...effectsDeps(t.h.deps), deferredCommandIds: new Set([t.customerCommandId]),
  }, t.h.session(t.call.sessionId) as SessionRow, options));
}

describe("derived inbound hangup terminal-proof gate", () => {
  it.each(["unknown", "accepted"] as const)("keeps a %s original pending while completing other legs' urgent teardown", async originalOutcome => {
    const t = await pendingHangups(originalOutcome);
    const result = await resume(t);
    expect(result).toMatchObject({ failed: true, failure: { error: "mandatory effects pending" } });
    const entry = readPendingEffects(t.h.session(t.call.sessionId) as SessionRow).entries.find(row => row.id === t.eventId)!;
    expect(entry.commands.some(command => "commandId" in command && command.commandId === t.customerCommandId)).toBe(true);
    expect(entry.completedCommands).not.toContain(t.customerCommandId);
    expect(entry.completedCommands).toContain(t.operatorCommandId);
    expect(entry.auditComplete).toBe(false);
    expect(t.h.telnyx.physical.legs.get(t.call.callControlId)?.ended).toBe(false);
    expect(t.h.telnyx.physical.legs.get(t.operator)?.ended).toBe(true);
    expect(t.h.telnyx.of("hangup").map(row => row.params.callControlId)).toEqual([t.operator]);
    expect(t.h.rows("motorist_provider_commands").find(row => row.command_id === t.customerCommandId)?.outcome).toBe(originalOutcome);
  });

  it("preserves the gate through database-only preemption and a following normal replay", async () => {
    const t = await pendingHangups();
    await resume(t, { databaseOnly: true });
    expect(t.h.telnyx.of("hangup")).toEqual([]);
    expect(readPendingEffects(t.h.session(t.call.sessionId) as SessionRow).entries[0].completedCommands).not.toContain(t.customerCommandId);
    await resume(t);
    expect(t.h.telnyx.of("hangup").map(row => row.params.callControlId)).toEqual([t.operator]);
    expect(readPendingEffects(t.h.session(t.call.sessionId) as SessionRow).entries[0].completedCommands).not.toContain(t.customerCommandId);
  });

  it("persists a new terminal leg fact before blocked FIFO replay without retiring the old command", async () => {
    const t = await pendingHangups();
    const observedAt = t.h.now().toISOString();
    const terminal = reconciledHangupEvent(t.call.callControlId, t.h.now(), true);
    const result = await ownedSessionWork(t.h.deps, t.call.sessionId, async () => {
      const session = t.h.session(t.call.sessionId) as SessionRow;
      const next = emptyTransition();
      next.legs.push({ callControlId: t.call.callControlId, values: { state: "ended", ended_at: observedAt, hangup_cause: "reconciled" } });
      return applyReduceResult({ ...effectsDeps(t.h.deps), deferredCommandIds: new Set([t.customerCommandId]) }, {
        session, expectedVersion: session.version, event: terminal,
        result: { next, commands: [], compensations: [], guard: null, ignored: null },
      });
    });
    // The new provider fact is committed even though FIFO still stops at the
    // original obligation. Only recovery's later proof checkpoint retires it.
    expect(result).toMatchObject({ failed: true, failure: { error: "Earlier effects remain pending" } });
    expect(t.h.legs(t.call.sessionId).find(leg => leg.telnyx_call_control_id === t.call.callControlId))
      .toMatchObject({ state: "ended", ended_at: observedAt });
    const pending = readPendingEffects(t.h.session(t.call.sessionId) as SessionRow).entries;
    expect(pending.find(entry => entry.id === t.eventId)?.completedCommands).not.toContain(t.customerCommandId);
    expect(pending.find(entry => entry.id === terminal.id)?.databaseCursor).toBeGreaterThanOrEqual(1);
    expect(t.h.telnyx.of("hangup").map(row => row.params.callControlId)).toEqual([t.operator]);
  });

  it("retires only after the dedicated recovery checkpoints proven completion, without another provider hangup", async () => {
    const t = await pendingHangups();
    await resume(t);
    const before = structuredClone(t.h.telnyx.calls);
    t.h.telnyx.physical.ended(t.call.callControlId);
    await ownedSessionWork(t.h.deps, t.call.sessionId, async () => {
      const session = t.h.session(t.call.sessionId) as SessionRow;
      const entry = readPendingEffects(session).entries.find(row => row.id === t.eventId)!;
      entry.completedCommands.push(t.customerCommandId);
      const confirmed = await checkpointEffects({ admin: t.h.deps.admin, organizationId: t.h.deps.organizationId, now: t.h.now },
        session.id, entry, entry.id, session);
      await resumePendingEffects(effectsDeps(t.h.deps), confirmed);
    });
    expect(readPendingEffects(t.h.session(t.call.sessionId) as SessionRow).entries).toEqual([]);
    expect(t.h.telnyx.calls).toEqual(before);
    expect(t.h.rows("motorist_call_events").filter(row => row.event_fingerprint === t.eventId)).toHaveLength(1);
  });
});
