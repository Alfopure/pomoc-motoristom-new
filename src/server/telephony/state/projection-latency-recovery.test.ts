import { afterEach, describe, expect, it, vi } from "vitest";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { createTelephonyHarness, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import type { FakeRow } from "@/test/fake-supabase";
import { runPendingEffectRecovery } from "../cron-jobs";
import { runSessionEvent } from "../session-runner";
import { databaseEffectCount, readPendingEffects } from "./continuation";
import { emptyTransition, readMeta, toJson, type SessionRow } from "./types";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function recordedCall() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "false");
  for (const key of ["TELNYX_RECORDING_ENABLED", "RECORDING_PROCESSING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED",
    "TELNYX_RECORDING_CHANNELS_VERIFIED", "TELNYX_RECORDING_CONFERENCE_VERIFIED", "TELNYX_RECORDING_TRANSFER_VERIFIED"]) vi.stubEnv(key, "true");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true,
    approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  const call = await h.inbound();
  await completeCallAnnouncements(h, call.sessionId);
  const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  h.telnyx.physical.answered(operator);
  expect((await h.legEvent(operator, "call.answered")).outcome).toBe("processed");
  for (const leg of h.legs(call.sessionId)) if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) {
    await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  expect(h.session(call.sessionId).writer_contract).toBe(2);
  expect(readMeta(h.session(call.sessionId) as SessionRow).recording?.recorders[0].observed).toBe("recording");
  return { h, ...call, operator };
}

const pending = (h: TelephonyHarness, sessionId: string) => readPendingEffects(h.session(sessionId) as SessionRow).entries;
const audits = (h: TelephonyHarness, eventId: string) => h.rows("motorist_call_events").filter(row => row.event_fingerprint === eventId);
const hold = (h: TelephonyHarness, sessionId: string, id: string) => runSessionEvent(h.deps, sessionId, {
  kind: "app", type: "hold", id, actorProfileId: PROFILES.o1, occurredAt: h.now().toISOString(),
});

function projectedHoldEvent(h: TelephonyHarness): string | null {
  const query = h.db.log.at(-1);
  if (query?.table !== "motorist_call_events" || query.operation !== "insert") return null;
  const payload = query.payload as FakeRow;
  const normalized = payload.normalized_payload as FakeRow;
  return normalized.state_after === "held" ? String(payload.event_fingerprint) : null;
}

function removingEntry(h: TelephonyHarness, entryId: string): boolean {
  const payload = h.db.log.at(-1)?.payload as FakeRow | undefined;
  return Boolean(payload && "pending_effects" in payload &&
    !readPendingEffects({ pending_effects: toJson(payload.pending_effects) }).entries.some(entry => entry.id === entryId));
}

describe("recorded control projection recovery with writer contract 2", () => {
  it("replays a lost final checkpoint after projection and audit without duplicating provider work or the audit", async () => {
    const { h, sessionId } = await recordedCall();
    let eventId: string | null = null;
    const original = h.db.takeInjectedError.bind(h.db);
    let failures = 0;
    const fault = vi.spyOn(h.db, "takeInjectedError").mockImplementation((table, operation) => {
      eventId ??= projectedHoldEvent(h);
      const payload = h.db.log.at(-1)?.payload as FakeRow | undefined;
      if (eventId && table === "motorist_call_sessions" && operation === "update" && audits(h, eventId).length && payload && "pending_effects" in payload) {
        // The outage also prevents the error handler from checkpointing the
        // in-memory cursor. Recovery must use the older persisted obligation.
        if (failures === 0) expect(removingEntry(h, eventId)).toBe(true);
        failures += 1;
        expect(h.call(sessionId)?.raw_latest_payload).toMatchObject({ state: "held" });
        return { code: "08006", message: "final checkpoint unavailable", details: null, hint: null };
      }
      return original(table, operation);
    });
    await expect(hold(h, sessionId, "hold-final-checkpoint-loss")).rejects.toThrow("final checkpoint unavailable");
    expect(failures).toBeGreaterThanOrEqual(2);
    const obligation = pending(h, sessionId).find(entry => entry.id === eventId)!;
    expect(obligation).toBeDefined();
    expect(obligation.auditComplete).toBe(false);
    expect(obligation.databaseCursor).toBeLessThan(databaseEffectCount(obligation.transition));
    expect(audits(h, eventId!)).toHaveLength(1);
    const providerCalls = structuredClone(h.telnyx.calls);
    const projectionWrites = h.db.log.filter(query => query.table === "motorist_calls" && query.operation === "update").length;
    const auditAttempts = () => h.db.log.filter(query => query.table === "motorist_call_events" && query.operation === "insert" &&
      (query.payload as FakeRow).event_fingerprint === eventId).length;
    const attemptsBeforeRecovery = auditAttempts();
    fault.mockRestore();
    h.advance(5 * 60_000);
    expect((await runPendingEffectRecovery(h.deps)).status).toBe("ok");
    expect(pending(h, sessionId)).toEqual([]);
    expect(audits(h, eventId!)).toHaveLength(1);
    expect(auditAttempts()).toBeGreaterThan(attemptsBeforeRecovery);
    expect(h.db.log.filter(query => query.table === "motorist_calls" && query.operation === "update")).toHaveLength(projectionWrites);
    expect(h.telnyx.calls).toEqual(providerCalls);
    expect(h.session(sessionId).state).toBe("held");
  });

  it("retains an audit insert obligation after its projection and recovers it exactly once", async () => {
    const { h, sessionId } = await recordedCall();
    let eventId: string | null = null;
    const original = h.db.takeInjectedError.bind(h.db);
    let failures = 0;
    const fault = vi.spyOn(h.db, "takeInjectedError").mockImplementation((table, operation) => {
      eventId ??= projectedHoldEvent(h);
      if (table === "motorist_call_events" && operation === "insert" && projectedHoldEvent(h) === eventId && eventId) {
        failures += 1;
        expect(h.call(sessionId)?.raw_latest_payload).toMatchObject({ state: "held" });
        return { code: "08006", message: "audit insert unavailable", details: null, hint: null };
      }
      return original(table, operation);
    });
    await hold(h, sessionId, "hold-audit-insert-loss");
    expect(failures).toBeGreaterThan(0);
    const obligation = pending(h, sessionId).find(entry => entry.id === eventId)!;
    expect(obligation).toMatchObject({ auditComplete: false, lastError: expect.stringContaining("audit insert unavailable") });
    expect(obligation.databaseCursor).toBe(databaseEffectCount(obligation.transition));
    expect(audits(h, eventId!)).toEqual([]);
    const providerCalls = structuredClone(h.telnyx.calls);
    fault.mockRestore();
    h.advance(5 * 60_000);
    expect((await runPendingEffectRecovery(h.deps)).status).toBe("ok");
    expect(pending(h, sessionId)).toEqual([]);
    expect(audits(h, eventId!)).toHaveLength(1);
    expect(h.telnyx.calls).toEqual(providerCalls);
    h.advance(5 * 60_000);
    await runPendingEffectRecovery(h.deps);
    expect(audits(h, eventId!)).toHaveLength(1);
  });

  it("preserves an independently staged obligation and newer version when the final checkpoint loses its compare-and-set", async () => {
    const { h, sessionId } = await recordedCall();
    let eventId: string | null = null;
    const concurrentId = "concurrent-audit-obligation";
    const original = h.db.takeInjectedError.bind(h.db);
    let injectedVersion: number | null = null;
    const fault = vi.spyOn(h.db, "takeInjectedError").mockImplementation((table, operation) => {
      eventId ??= projectedHoldEvent(h);
      if (eventId && injectedVersion === null && table === "motorist_call_sessions" && operation === "update" && audits(h, eventId!).length && removingEntry(h, eventId)) {
        const current = h.session(sessionId) as SessionRow;
        const currentPending = readPendingEffects(current);
        const template = currentPending.entries.find(entry => entry.id === eventId)!;
        expect(template).toBeDefined();
        injectedVersion = current.version + 1;
        const next = { ...template, id: concurrentId, event: { kind: "app" as const, type: "sweep" as const,
          id: concurrentId, actorProfileId: null, occurredAt: h.now().toISOString() },
        transition: emptyTransition(), commands: [], compensations: [], databaseCursor: 0, completedCommands: [], auditComplete: false };
        h.db.update("motorist_call_sessions", { version: injectedVersion,
          pending_effects: toJson({ version: 1, entries: [...currentPending.entries, next] }) }, row => row.id === sessionId);
      }
      return original(table, operation);
    });
    await hold(h, sessionId, "hold-concurrent-finalize");
    expect(injectedVersion).not.toBeNull();
    expect(Number(h.session(sessionId).version)).toBeGreaterThan(injectedVersion!);
    // A newly queued entry may be completed by this invocation's bounded drain;
    // it must either remain durable or have its own exactly-once audit.
    expect(pending(h, sessionId).some(entry => entry.id === concurrentId) || audits(h, concurrentId).length === 1).toBe(true);
    expect(audits(h, eventId!)).toHaveLength(1);
    fault.mockRestore();
    const providerCalls = structuredClone(h.telnyx.calls);
    h.advance(5 * 60_000);
    expect((await runPendingEffectRecovery(h.deps)).status).toBe("ok");
    expect(pending(h, sessionId)).toEqual([]);
    expect(audits(h, concurrentId)).toHaveLength(1);
    expect(audits(h, eventId!)).toHaveLength(1);
    expect(h.telnyx.calls).toEqual(providerCalls);
  });
});
