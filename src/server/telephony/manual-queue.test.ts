import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, ORG, PROFILES } from "@/test/telephony-harness";
import { deferRingingCall, pickupWaitingCall } from "./call-actions";
import { runPendingEffectRecovery } from "./cron-jobs";
import { sweepOverdueRingSteps } from "./routing/ring-plan";
import { runSessionEvent } from "./session-runner";
import { readPendingEffects } from "./state/continuation";
import { commandKey, readMeta, type SessionRow } from "./state/types";
import { TelnyxCommandError } from "./telnyx/client";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
afterEach(() => vi.unstubAllEnvs());

describe("manual inbound waiting room", () => {
  it("queues two callers without dialling and lets the operator choose one", async () => {
    const h = createTelephonyHarness();
    h.db.update("motorist_telephony_settings", { inbound_call_mode: "queue_first" }, () => true);

    const first = await h.inbound({ to: NUMBERS.allianz });
    const second = await h.inbound({ to: NUMBERS.allianz });
    expect(first.sessionId).not.toBe(second.sessionId);
    expect(h.telnyx.of("dial")).toHaveLength(0);
    for (const call of [first, second]) {
      expect(h.session(call.sessionId).state).toBe("waiting");
      expect(readMeta(h.session(call.sessionId) as SessionRow)).toMatchObject({
        waiting: { reason: "queue_first" }, queue: { manual_only: true },
      });
    }
    expect(h.telnyx.of("gatherUsingAudio").length).toBeGreaterThanOrEqual(2);

    const pickup = await pickupWaitingCall(h.deps, actor, second.sessionId);
    expect(pickup.operatorLegCallControlId).toBeTruthy();
    expect(h.session(first.sessionId).state).toBe("waiting");
  });

  it("queues without a ring plan and still reaches the callback limit", async () => {
    const h = createTelephonyHarness();
    h.db.update("motorist_telephony_settings", { inbound_call_mode: "queue_first", park_max_minutes: 1 }, () => true);
    h.db.update("motorist_telephony_lines", { ring_plan_id: null }, (row) => row.phone_number === NUMBERS.allianz);

    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(readMeta(h.session(call.sessionId) as SessionRow).queue?.manual_only).toBe(true);

    h.advance(65_000);
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", type: "sweep", id: "manual-queue-timeout", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(h.session(call.sessionId).state).toBe("callback_offered");
  });

  it("defers only the exact active offer, cancels all branches and never reoffers it", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const own = h.legFor(call.sessionId, PROFILES.o1)!;
    const ownId = String(own.telnyx_call_control_id);
    await expect(deferRingingCall(h.deps, actor, call.sessionId, "old-offer-id"))
      .rejects.toMatchObject({ status: 409, code: "offer_unavailable" });
    expect(h.session(call.sessionId).state).toBe("ringing");

    const result = await deferRingingCall(h.deps, actor, call.sessionId, ownId);
    expect(result.state).toBe("waiting");
    expect(readMeta(h.session(call.sessionId) as SessionRow)).toMatchObject({
      waiting: { reason: "operator_deferred" }, queue: { manual_only: true },
    });
    expect(h.attempts(call.sessionId).every((attempt) => attempt.result === "cancelled")).toBe(true);
    expect(h.telnyx.of("hangup").map((entry) => entry.params.callControlId).sort())
      .toEqual(h.legs(call.sessionId).filter((leg) => leg.role !== "customer").map((leg) => leg.telnyx_call_control_id).sort());
    expect(h.legs(call.sessionId).find((leg) => leg.role === "customer")?.ended_at).toBeNull();

    h.advance(130_000);
    await sweepOverdueRingSteps({ admin: h.admin, organizationId: h.deps.organizationId, environment: h.deps.environment,
      now: h.now, runSessionEvent: (id, event) => runSessionEvent(h.deps, id, event) });
    expect(h.telnyx.of("dial")).toHaveLength(3);
    expect(h.session(call.sessionId).state).toBe("waiting");
    await expect(deferRingingCall(h.deps, actor, call.sessionId, ownId))
      .rejects.toMatchObject({ status: 409, code: "offer_unavailable" });
  });

  it("refuses defer at the offer deadline even if its provider timeout webhook is late", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const own = h.legFor(call.sessionId, PROFILES.o1)!;
    const deadline = readMeta(h.session(call.sessionId) as SessionRow).ring?.step_deadline_at;
    expect(deadline).toBeTruthy();
    h.advance(Date.parse(deadline!) - h.now().getTime());

    await expect(deferRingingCall(h.deps, actor, call.sessionId, String(own.telnyx_call_control_id)))
      .rejects.toMatchObject({ status: 409, code: "offer_expired" });
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.attempts(call.sessionId).some((attempt) => attempt.profile_id === PROFILES.o1 && attempt.result === "offered")).toBe(true);
  });

  it("refuses defer when the actor's shorter attempt deadline passes before the ring step ends", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const own = h.legFor(call.sessionId, PROFILES.o1)!;
    const attempt = h.attempts(call.sessionId).find((row) => row.profile_id === PROFILES.o1)!;
    const stepDeadline = readMeta(h.session(call.sessionId) as SessionRow).ring?.step_deadline_at;
    expect(Date.parse(stepDeadline!)).toBeGreaterThan(h.now().getTime() + 1_000);
    h.db.update("motorist_ring_attempts", { ring_secs: 1 }, (row) => row.id === attempt.id);
    h.advance(1_000);

    await expect(deferRingingCall(h.deps, actor, call.sessionId, String(own.telnyx_call_control_id)))
      .rejects.toMatchObject({ status: 409, code: "offer_expired" });
    expect(h.session(call.sessionId).state).toBe("ringing");
  });

  it("reports a failed provider hangup and durably retries every offered leg", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const ownId = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    const offeredIds = h.legs(call.sessionId).filter((leg) => leg.role !== "customer")
      .map((leg) => String(leg.telnyx_call_control_id));
    h.telnyx.failNext("hangup", new TelnyxCommandError({ code: "provider_unavailable", status: 503, detail: "Temporary failure" }));

    await expect(deferRingingCall(h.deps, actor, call.sessionId, ownId))
      .rejects.toMatchObject({ status: 502, code: "command_failed" });
    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(readMeta(h.session(call.sessionId) as SessionRow).queue?.manual_only).toBe(true);
    const pending = readPendingEffects(h.session(call.sessionId) as SessionRow).entries;
    expect(pending).toHaveLength(1);
    expect(pending[0].commands.some((command) => command.kind === "hangup" &&
      !pending[0].completedCommands.includes(commandKey(command)))).toBe(true);
    expect(h.legs(call.sessionId).filter((leg) => leg.role !== "customer" && !leg.ended_at)).toHaveLength(offeredIds.length);

    h.advance(5 * 60_000);
    expect((await runPendingEffectRecovery(h.deps)).status).toBe("ok");
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toHaveLength(0);
    for (const id of offeredIds) expect(h.telnyx.physical.legs.get(id)?.ended).toBe(true);
    expect(h.session(call.sessionId).state).toBe("waiting");
  });

  it("lets the owner defer an unanswered offer ringing on their personal mobile", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = createTelephonyHarness();
    h.db.insert("motorist_operator_telephony_settings", [{ organization_id: ORG, profile_id: PROFILES.o2,
      delivery_mode: "personal_mobile", default_mobile_number: "+421905123456", pause_routing_mode: "none", wrap_up_seconds: 30 }]);
    h.db.delete("motorist_operator_devices", (row) => row.profile_id === PROFILES.o2);
    const call = await h.inbound({ to: NUMBERS.allianz });
    const mobile = h.legFor(call.sessionId, PROFILES.o2)!;
    expect(mobile).toMatchObject({ role: "external", to_number: "+421905123456" });
    await expect(deferRingingCall(h.deps, actor, call.sessionId, String(mobile.telnyx_call_control_id)))
      .rejects.toMatchObject({ status: 409, code: "offer_unavailable" });

    const result = await deferRingingCall(h.deps, { profileId: PROFILES.o2, role: "dispatcher" }, call.sessionId, String(mobile.telnyx_call_control_id));
    expect(result.state).toBe("waiting");
    expect(h.telnyx.of("hangup").some((entry) => entry.params.callControlId === mobile.telnyx_call_control_id)).toBe(true);
    expect(readMeta(h.session(call.sessionId) as SessionRow).queue?.manual_only).toBe(true);
  });

  it("rejects a late click when the same call has a newer offer for that operator", async () => {
    const h = createTelephonyHarness({ fallbackKind: "waiting_room" });
    const call = await h.inbound({ to: NUMBERS.allianz });
    const oldId = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    for (const leg of h.legs(call.sessionId).filter((row) => row.role !== "customer")) {
      await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
    }
    const backup = h.legByNumber(call.sessionId, NUMBERS.external);
    if (backup && !backup.ended_at) await h.legEvent(String(backup.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
    expect(h.session(call.sessionId).state).toBe("waiting");
    h.setPresence(PROFILES.o2, { status: "offline" });
    h.setPresence(PROFILES.o5, { status: "offline" });
    h.advance(61_000);
    await sweepOverdueRingSteps({ admin: h.admin, organizationId: h.deps.organizationId, environment: h.deps.environment,
      now: h.now, runSessionEvent: (id, event) => runSessionEvent(h.deps, id, event) });
    const current = h.legs(call.sessionId).find((leg) => leg.profile_id === PROFILES.o1 && !leg.ended_at);
    expect(current?.telnyx_call_control_id).toBeTruthy();
    expect(current?.telnyx_call_control_id).not.toBe(oldId);

    await expect(deferRingingCall(h.deps, actor, call.sessionId, oldId))
      .rejects.toMatchObject({ status: 409, code: "offer_unavailable" });
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.legs(call.sessionId).find((leg) => leg.telnyx_call_control_id === current?.telnyx_call_control_id)?.ended_at).toBeNull();
  });

  it("keeps ring-first callback behaviour on a line without a plan", async () => {
    const h = createTelephonyHarness();
    h.db.update("motorist_telephony_lines", { ring_plan_id: null }, (row) => row.phone_number === NUMBERS.allianz);
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.session(call.sessionId).state).toBe("callback_offered");
  });

  it.each(["ring_first", "queue_first"] as const)("respects %s for an explicit IVR waiting-room choice", async (mode) => {
    const h = createTelephonyHarness();
    h.db.update("motorist_telephony_settings", { inbound_call_mode: mode }, () => true);
    h.db.update("motorist_ivr_options", { action: "waiting_room", target_ring_plan_id: null }, (row) => row.digit === "1");
    const call = await h.inbound({ to: NUMBERS.neutral });
    expect(h.session(call.sessionId).state).toBe("ivr");
    const prompt = h.telnyx.of("gatherUsingAudio").at(-1)!;
    await h.legEvent(call.callControlId, "call.gather.ended", { digits: "1", status: "valid", client_state: prompt.params.clientState });
    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(readMeta(h.session(call.sessionId) as SessionRow).queue?.manual_only).toBe(mode === "queue_first");

    h.advance(6_000);
    await sweepOverdueRingSteps({ admin: h.admin, organizationId: h.deps.organizationId, environment: h.deps.environment,
      now: h.now, runSessionEvent: (id, event) => runSessionEvent(h.deps, id, event) });
    if (mode === "ring_first") expect(h.telnyx.of("dial").length).toBeGreaterThan(0);
    else expect(h.telnyx.of("dial")).toHaveLength(0);
  });
});
