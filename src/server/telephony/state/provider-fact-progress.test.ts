import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness } from "@/test/telephony-harness";
import { ProviderOutcomeUnknownError } from "../provider-journal";
import { applyReduceResult, resumePendingEffects, type EffectsDeps } from "./effects";
import { parseTelnyxEnvelope } from "./events";
import { effectGeneration, readPendingEffects, stageEffects } from "./continuation";
import { emptyTransition, type ReduceResult, type SessionRow } from "./types";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function unknownCommand() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness({ sweepAfterEvent: false });
  const call = await h.inbound({ answer: false });
  const effects: EffectsDeps = { ...h.deps, now: h.now, mediaBaseUrl: null };
  const session = () => h.session(call.sessionId) as SessionRow;
  const unknown = vi.spyOn(h.telnyx.client, "playbackStop").mockRejectedValue(new ProviderOutcomeUnknownError("unknown-stop"));
  const old = await stageEffects(effects, { session: session(), expectedVersion: session().version,
    event: { kind: "app", type: "sweep", id: "old-effect", actorProfileId: null, occurredAt: h.now().toISOString() },
    result: { next: emptyTransition(), commands: [{ kind: "playback_stop", commandId: "unknown-stop", leg: { callControlId: call.callControlId } }], compensations: [], guard: null, ignored: null } });
  expect((await resumePendingEffects(effects, old))?.failed).toBe(true);
  const fact = parseTelnyxEnvelope(h.envelope("call.answered", { call_control_id: call.callControlId }, "new-fact"));
  if (!fact) throw new Error("test provider envelope was not parsed");
  const next = emptyTransition();
  next.legs.push({ callControlId: call.callControlId, values: { state: "answered", answered_at: h.now().toISOString() } });
  const result: ReduceResult = { next, commands: [], compensations: [], guard: null, ignored: null };
  return { h, call, effects, session, fact, result, unknown };
}

describe("provider facts behind unresolved commands", () => {
  it("attempts urgent teardown and commits a second leg's hangup while an older hangup remains unknown", async () => {
    const { h, call, effects, session, fact, result, unknown } = await unknownCommand();
    unknown.mockRestore();
    const pending = readPendingEffects(session());
    pending.entries[0].commands = [{ kind: "hangup", commandId: "old-hangup", leg: { callControlId: "older-leg" }, reason: "cleanup" }];
    h.db.update("motorist_call_sessions", { pending_effects: pending }, row => row.id === call.sessionId);
    const hangup = h.telnyx.client.hangup.bind(h.telnyx.client);
    vi.spyOn(h.telnyx.client, "hangup").mockImplementation(async params => {
      if (params.callControlId === "older-leg") throw new ProviderOutcomeUnknownError("old-hangup");
      await hangup(params);
    });
    fact.type = "call.hangup";
    result.next.legs[0].values = { state: "ended", ended_at: h.now().toISOString() };
    result.commands = [{ kind: "hangup", commandId: "current-hangup", leg: { callControlId: call.callControlId }, reason: "cleanup" }];
    const applied = await applyReduceResult(effects, { session: session(), expectedVersion: session().version, event: fact, result });
    expect(applied).toMatchObject({ failed: true, failure: { command: "continuation" } });
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)).toMatchObject({ state: "ended", ended_at: h.now().toISOString() });
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(true);
    expect(h.telnyx.of("hangup")).toHaveLength(1);
    expect(readPendingEffects(session()).entries.find(entry => entry.id === fact.id)?.databaseCursor).toBe(1);
  });

  it("commits an exact leg observation at the same topology generation and retains this event as pending", async () => {
    const { h, call, effects, session, fact, result, unknown } = await unknownCommand();
    const generation = effectGeneration(session());
    for (let attempt = 0; attempt < 2; attempt++) {
      const applied = await applyReduceResult(effects, { session: session(), expectedVersion: session().version, event: fact, result });
      expect(applied).toMatchObject({ failed: true, commands: [], failure: { command: "continuation" } });
      expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)).toMatchObject({ state: "answered" });
      expect(effectGeneration(session())).toBe(generation);
      expect(readPendingEffects(session()).entries.map(entry => entry.id)).toEqual(["old-effect", "new-fact"]);
      expect(readPendingEffects(session()).entries[1].databaseCursor).toBe(1);
    }
    // Each invocation reaches the retained journal operation; the journal's
    // unknown result refuses another HTTP dispatch (covered by its HTTP test).
    expect(unknown).toHaveBeenCalledTimes(3);
  });

  it("does not acknowledge a provider fact whose critical database write failed", async () => {
    const { h, effects, session, fact, result } = await unknownCommand();
    h.db.failNext("motorist_call_legs", "update", "critical fact database unavailable");
    await expect(applyReduceResult(effects, { session: session(), expectedVersion: session().version, event: fact, result })).rejects.toThrow("leg update failed");
    expect(readPendingEffects(session()).entries.find(entry => entry.id === fact.id)?.databaseCursor).toBe(0);
  });

  it("keeps app actions behind unresolved commands without applying their later database changes", async () => {
    const { h, call, effects, session, result } = await unknownCommand();
    const before = h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)?.state;
    const applied = await applyReduceResult(effects, { session: session(), expectedVersion: session().version, result,
      event: { kind: "app", type: "pickup", id: "app-action", actorProfileId: null, occurredAt: h.now().toISOString() } });
    expect(applied).toMatchObject({ failed: true, commands: [] });
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)?.state).toBe(before);
    expect(readPendingEffects(session()).entries.find(entry => entry.id === "app-action")?.databaseCursor).toBe(0);
  });
});
