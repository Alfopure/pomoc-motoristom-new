import { describe, expect, it } from "vitest";
import { createTelephonyHarness, PROFILES } from "@/test/telephony-harness";
import { effectsDeps } from "../session-runner";
import { persistTransition } from "./effects";
import { emptyTransition, readMeta, toJson, type SessionEvent, type SessionRow } from "./types";
import type { EffectContinuation } from "./continuation";
import { runPendingEffectRecovery } from "../cron-jobs";

describe("deferred projection ordering", () => {
  it("keeps newer call ownership/status and monotonic member timestamps when an old projection returns", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const call = await h.inbound();
    const source = h.session(call.sessionId) as SessionRow;
    const event: SessionEvent = { kind: "app", type: "sweep", id: "old-projection", actorProfileId: null, occurredAt: h.now().toISOString() };
    const member = h.db.storage("motorist_ring_group_members")[0];
    h.advance(60_000);
    const newerTimestamp = h.now().toISOString();
    member.last_offered_at = newerTimestamp;
    const transition = emptyTransition();
    transition.memberTouches = [{ memberId: String(member.id), field: "last_offered_at" }];
    transition.call = { status: "ringing_agent", operator_id: PROFILES.o1 };
    const entry: EffectContinuation = { id: event.id, generation: 1, createdAt: event.occurredAt, event,
      stateBefore: "ringing", previousConferenceId: null, branch: "main", transition, commands: [], compensations: [],
      databaseCursor: 0, completedCommands: [], attempts: 1, lastError: "old projection failed", auditComplete: false };
    const fresh: SessionRow = { ...source, state: "talking", answered_by_profile_id: PROFILES.o2,
      answered_at: newerTimestamp, metadata: toJson({ ...readMeta(source), effects_v1: { generation: 2 } }),
      pending_effects: toJson({ version: 1, entries: [entry] }) };
    Object.assign(h.db.storage("motorist_call_sessions").find(row => row.id === call.sessionId)!, fresh);
    Object.assign(h.db.storage("motorist_calls").find(row => row.session_id === call.sessionId)!, { status: "answered", operator_id: PROFILES.o2 });
    h.advance(5 * 60_000);
    await persistTransition(effectsDeps(h.deps), { session: fresh, transition, expectedVersion: null, event, continuation: entry, phase: "projection" });
    expect(h.call(call.sessionId)).toMatchObject({ status: "answered", operator_id: PROFILES.o2 });
    expect(h.rows("motorist_ring_group_members").find(row => row.id === member.id)?.last_offered_at).toBe(newerTimestamp);
  });

  it("does not report an ignored sweep as completed while its durable projection remains", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const call = await h.inbound();
    const transition = emptyTransition();
    const event: SessionEvent = { kind: "app", type: "sweep", id: "pending", actorProfileId: null, occurredAt: h.now().toISOString() };
    const entry: EffectContinuation = { id: event.id, generation: 1, createdAt: event.occurredAt, event,
      stateBefore: "ringing", previousConferenceId: null, branch: "main", transition, commands: [], compensations: [],
      databaseCursor: 0, completedCommands: [], attempts: 1, lastError: "history unavailable", auditComplete: false };
    const row = h.db.storage("motorist_call_sessions").find(row => row.id === call.sessionId)!;
    row.pending_effects = toJson({ version: 1, entries: [entry] });
    row.effects_next_attempt_at = h.now().toISOString();
    const result = await runPendingEffectRecovery({ ...h.deps, runSession: async () => ({ outcome: "ignored", session: h.session(call.sessionId) }) });
    expect(result.status).toBe("failed");
    expect(result.detail.errors).toEqual([expect.objectContaining({ sessionId: call.sessionId, error: "durable call recovery remains pending" })]);
  });
});
