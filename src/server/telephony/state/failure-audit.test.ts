import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES } from "@/test/telephony-harness";
import { pickupWaitingCall } from "../call-actions";
import { runPendingEffectRecovery } from "../cron-jobs";
import { setPresence } from "../presence-service";
import { effectsDeps, ownedSessionWork } from "../session-runner";
import { SessionLeaseLostError } from "../service-errors";
import { TelnyxCommandError } from "../telnyx/client";
import { failureAudits, readPendingEffects, stageEffects } from "./continuation";
import { resumePendingEffects } from "./effects";
import { emptyTransition, type SessionRow } from "./types";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("immutable command failure obligations", () => {
  it("retains two different mandatory command failures once each across retries and legacy singular markers", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
    const call = await h.inbound({ to: NUMBERS.allianz, answer: false });
    const current = () => h.session(call.sessionId) as SessionRow;
    const owned = (work: () => Promise<unknown>) => ownedSessionWork(h.deps, call.sessionId, work, { known: current() });
    const ids = ["30000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000002"];
    await owned(() => stageEffects(effectsDeps(h.deps), { session: current(), expectedVersion: current().version,
      event: { kind: "app", type: "sweep", id: "two-commands", actorProfileId: null, occurredAt: h.now().toISOString() },
      result: { next: emptyTransition(), commands: ids.map(commandId => ({ kind: "playback_start", commandId,
        leg: { callControlId: call.callControlId }, media: { file: "audit-test.mp3" } })), compensations: [], guard: null, ignored: null } }));
    const prepare = h.db.rpcHandlers.get("motorist_provider_command_prepare_v2")!;
    const failures = new Set(ids);
    h.db.registerRpc("motorist_provider_command_prepare_v2", (args, db) => {
      if (failures.delete(String(args.p_command_id))) throw new Error("temporary command admission failure");
      return prepare(args, db);
    });
    const resume = () => owned(() => resumePendingEffects(effectsDeps(h.deps), current()));
    // Simulate the first release's singular JSON already persisted before the
    // newer writer sees it, including a lost initial audit INSERT.
    h.db.failNext("motorist_call_events", "upsert", "audit unavailable");
    await resume();
    const pending = readPendingEffects(current());
    const first = pending.entries[0].failureAudits![0];
    expect(first.recorded).not.toBe(true);
    delete first.commandKey;
    pending.entries[0].failureAudit = first;
    delete pending.entries[0].failureAudits;
    h.db.update("motorist_call_sessions", { pending_effects: pending }, row => row.id === call.sessionId);
    await resume();
    expect(failureAudits(readPendingEffects(current()).entries[0])).toHaveLength(2);
    await resume();
    await resume();
    const audits = h.rows("motorist_call_events").filter(row => row.handled_status === "failed");
    expect(audits).toHaveLength(2);
    expect(audits.map(row => row.event_fingerprint)).toEqual(expect.arrayContaining(["two-commands:failure", `two-commands:failure:${ids[1]}`]));
    expect(audits.flatMap(row => (row.normalized_payload as { commands: { command_id: string }[] }).commands.map(command => command.command_id))).toEqual(ids);
    expect(readPendingEffects(current()).entries).toEqual([]);
    expect(h.telnyx.of("playbackStart")).toHaveLength(2);
  });

  it("checkpoints a rejected command before a compensation can run or retire its predecessor", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
    const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
    for (const id of Object.values(PROFILES)) h.setPresence(id, { status: "offline" });
    await setPresence(h.deps, { organizationId: ORG, profileId: actor.profileId, status: "paused", pauseReasonId: "00000000-0000-4000-8000-000000002501" });
    const call = await h.inbound({ to: NUMBERS.allianz });
    const dialsBefore = h.telnyx.of("dial").length;
    h.telnyx.failAlways("dial", new TelnyxCommandError({ code: "invalid_destination", status: 422, detail: "permanent rejection" }));
    const stage = h.db.rpcHandlers.get("motorist_stage_transition_v1")!;
    let interrupted = false;
    h.db.registerRpc("motorist_stage_transition_v1", (args, db) => {
      const plan = args.p_main as { entry?: { id?: string } };
      if (!interrupted && plan.entry?.id?.includes(":compensate:")) {
        interrupted = true;
        const original = readPendingEffects(h.session(call.sessionId) as SessionRow).entries.find(entry => !entry.id.includes(":compensate:"))!;
        expect(failureAudits(original)).toEqual([expect.objectContaining({ commands: [expect.objectContaining({ kind: "dial", ok: false })] })]);
        throw new SessionLeaseLostError();
      }
      return stage(args, db);
    });
    await expect(pickupWaitingCall(h.deps, actor, call.sessionId)).rejects.toBeTruthy();
    expect(interrupted).toBe(true);
    expect(h.rows("motorist_call_events").filter(row => row.handled_status === "failed")).toEqual([]);
    const predecessor = readPendingEffects(h.session(call.sessionId) as SessionRow).entries[0].id;
    const update = h.db.update.bind(h.db);
    let retirementChecked = false;
    vi.spyOn(h.db, "update").mockImplementation((table, values, filter) => {
      if (table === "motorist_call_sessions" && "pending_effects" in values &&
        readPendingEffects(h.session(call.sessionId) as SessionRow).entries.some(entry => entry.id === predecessor) &&
        !readPendingEffects({ pending_effects: values.pending_effects as SessionRow["pending_effects"] }).entries.some(entry => entry.id === predecessor)) {
        retirementChecked = true;
        expect(h.rows("motorist_call_events").filter(row => row.handled_status === "failed")).toHaveLength(1);
      }
      return update(table, values, filter);
    });
    h.advance(5 * 60_000);
    await runPendingEffectRecovery(h.deps);
    expect(retirementChecked).toBe(true);
    expect(h.rows("motorist_call_events").filter(row => row.handled_status === "failed")).toHaveLength(1);
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toEqual([]);
    expect(h.presence(actor.profileId)).toMatchObject({ status: "paused", current_session_id: null });
    expect(h.telnyx.of("dial")).toHaveLength(dialsBefore + 1);
  });
});
