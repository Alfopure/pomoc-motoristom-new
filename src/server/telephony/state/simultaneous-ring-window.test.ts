import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoutingDiagnostic } from "@/lib/diagnostics/routing";
import { createTelephonyHarness, GROUPS, NUMBERS, ORG, PLAN_ID, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { runPendingEffectRecovery } from "../cron-jobs";
import { sweepOverdueRingSteps } from "../routing/ring-plan";
import { runSessionEvent } from "../session-runner";
import { readPendingEffects } from "./continuation";
import type { SessionRow } from "./types";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function world(strategy: "all" | "ordered" = "all") {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false, fallbackKind: "external_number" });
  // One group with two operators, followed by the plan's external backup.
  h.db.delete("motorist_ring_plan_steps", row => row.step_index !== 0);
  h.db.delete("motorist_ring_group_members", row => row.ring_group_id === GROUPS.a && row.profile_id === PROFILES.o5);
  h.db.update("motorist_ring_plan_steps", { strategy, timeout_secs: 20 }, () => true);
  h.db.update("motorist_telephony_settings", { max_ring_fanout: 8, max_concurrent_legs: 12 }, () => true);
  return h;
}

const control = (h: TelephonyHarness, sessionId: string, profile: string) => String(h.legFor(sessionId, profile)!.telnyx_call_control_id);
const backup = (h: TelephonyHarness, sessionId: string) => h.legByNumber(sessionId, NUMBERS.external);

function routing(h: TelephonyHarness, sessionId: string): RoutingDiagnostic[] {
  return h.callEvents(sessionId).flatMap(row => (row.normalized_payload as { routing?: RoutingDiagnostic[] }).routing ?? []);
}

function expectSafeRouting(h: TelephonyHarness, sessionId: string, extraNumbers: string[] = []) {
  const serialized = JSON.stringify(routing(h, sessionId));
  const credentials = h.rows("motorist_operator_devices").flatMap(row => [row.sip_username, row.telnyx_credential_id, row.device_session_id]);
  for (const value of [...Object.values(NUMBERS), ...extraNumbers, ...credentials]) {
    if (typeof value === "string" && value) expect(serialized).not.toContain(value);
  }
  expect(serialized).not.toMatch(/sip:|password|authorization|api_key|client_state|credential/i);
}

async function hangup(h: TelephonyHarness, callControlId: string, cause = "timeout") {
  h.telnyx.physical.ended(callControlId);
  await h.legEvent(callControlId, "call.hangup", { hangup_cause: cause });
}

async function sweep(h: TelephonyHarness) {
  await sweepOverdueRingSteps({
    admin: h.admin, organizationId: ORG, now: () => h.now(),
    runSessionEvent: (sessionId, event) => runSessionEvent(h.deps, sessionId, event),
  });
}

function occupyCapacity(h: TelephonyHarness, count: number) {
  const [other] = h.db.seed("motorist_call_sessions", [{ organization_id: ORG, direction: "inbound", state: "talking" }]);
  const blockers = h.db.seed("motorist_call_legs", Array.from({ length: count }, (_, index) => ({
    organization_id: ORG, session_id: other.id, telnyx_call_control_id: `capacity-block-${index}`,
    role: "operator", state: "answered", initiated_at: h.now().toISOString(),
  })));
  return () => {
    for (const leg of blockers) {
      h.db.update("motorist_call_legs", { ended_at: h.now().toISOString(), state: "ended" }, row => row.id === leg.id);
    }
  };
}

describe("one offer window per simultaneous ring step", () => {
  it("rings both eligible operators together and starts backup after their 20-second window", async () => {
    const h = world();
    const startedAt = h.now().toISOString();
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.attempts(call.sessionId)).toHaveLength(2);
    expect(h.attempts(call.sessionId).map(row => row.offered_at)).toEqual([startedAt, startedAt]);

    h.advance(20_000);
    await hangup(h, control(h, call.sessionId, PROFILES.o1));
    expect(backup(h, call.sessionId)).toBeNull();
    await hangup(h, control(h, call.sessionId, PROFILES.o2));

    expect(backup(h, call.sessionId)).not.toBeNull();
    expect(h.attempts(call.sessionId).at(-1)).toMatchObject({ step_index: 1, external_number: NUMBERS.external, offered_at: h.now().toISOString() });
  });

  it.each([
    { description: "stale heartbeat", registration: "registered", ageMs: 121_000 },
    { description: "device still registering", registration: "registering", ageMs: 5_000 },
  ])("records the partial $description skip and preserves one window after recovery", async ({ registration, ageMs }) => {
    const h = world();
    const startedAt = h.now().toISOString();
    const deadlineAt = new Date(h.now().getTime() + 25_000).toISOString();
    h.touchDevice(PROFILES.o2, ageMs);
    h.db.update("motorist_operator_devices", { registration_state: registration }, row => row.profile_id === PROFILES.o2);
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.attempts(call.sessionId)).toHaveLength(1);
    expect(h.legFor(call.sessionId, PROFILES.o2)).toBeNull();
    const selection = routing(h, call.sessionId).find(row => row.kind === "selection");
    expect(selection).toMatchObject({
      step: 0, strategy: "all", ringSecs: 20, startedAt, deadlineAt,
      selectedCount: 1, skippedCount: 1, maxFanout: 8, maxConcurrentLegs: 12,
      members: expect.arrayContaining([
        expect.objectContaining({ profileId: PROFILES.o1, endpoint: "sip", outcome: "selected", reason: null, presence: "available", registration: "registered", heartbeatAgeMs: 5_000, openOffer: false }),
        expect.objectContaining({ profileId: PROFILES.o2, endpoint: "sip", outcome: "skipped", reason: "device_stale", presence: "available", registration, heartbeatAgeMs: ageMs, openOffer: false }),
      ]),
    });

    h.advance(3_000);
    h.touchDevice(PROFILES.o2);
    h.db.update("motorist_operator_devices", { registration_state: "registered" }, row => row.profile_id === PROFILES.o2);
    h.advance(17_000);
    await hangup(h, control(h, call.sessionId, PROFILES.o1));

    expect(h.legFor(call.sessionId, PROFILES.o2)).toBeNull();
    expect(backup(h, call.sessionId)).not.toBeNull();
    expect(h.attempts(call.sessionId)).toHaveLength(2);
    const decisions = routing(h, call.sessionId);
    expect(decisions.filter(row => row.kind === "selection" && row.step === 0)).toHaveLength(1);
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "completed", step: 0, strategy: "all", at: h.now().toISOString(), startedAt, deadlineAt }),
      expect.objectContaining({ kind: "fallback", step: 0, strategy: "all", reason: "external_number", at: h.now().toISOString(), startedAt, deadlineAt }),
    ]));
    expectSafeRouting(h, call.sessionId);
  });

  it("retains a full window for each member of an ordered step", async () => {
    const h = world("ordered");
    // Different member durations must not be mislabeled as the step's 20 s.
    h.db.update("motorist_ring_group_members", { ring_secs: 7 }, row => row.profile_id === PROFILES.o1);
    h.db.update("motorist_ring_group_members", { ring_secs: 11 }, row => row.profile_id === PROFILES.o2);
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.attempts(call.sessionId)).toHaveLength(1);
    const initialWindow = routing(h, call.sessionId).find(row => row.kind === "selection")!;
    expect(initialWindow).toMatchObject({ strategy: "ordered", ringSecs: 7, startedAt: h.now().toISOString(), deadlineAt: new Date(h.now().getTime() + 12_000).toISOString() });

    h.advance(7_000);
    await hangup(h, control(h, call.sessionId, PROFILES.o1));
    expect(h.legFor(call.sessionId, PROFILES.o2)).not.toBeNull();
    expect(h.attempts(call.sessionId).at(-1)).toMatchObject({ profile_id: PROFILES.o2, ring_secs: 11, offered_at: h.now().toISOString() });
    expect(backup(h, call.sessionId)).toBeNull();
    const secondWindow = routing(h, call.sessionId).filter(row => row.kind === "selection").at(-1)!;
    expect(secondWindow).toMatchObject({ strategy: "ordered", ringSecs: 11, startedAt: h.now().toISOString(), deadlineAt: new Date(h.now().getTime() + 16_000).toISOString() });

    h.advance(11_000);
    await hangup(h, control(h, call.sessionId, PROFILES.o2));
    expect(backup(h, call.sessionId)).not.toBeNull();
    expect(routing(h, call.sessionId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "completed", strategy: "ordered", ringSecs: 11, startedAt: secondWindow.startedAt, deadlineAt: secondWindow.deadlineAt }),
      expect.objectContaining({ kind: "fallback", strategy: "ordered", ringSecs: 11, startedAt: secondWindow.startedAt, deadlineAt: secondWindow.deadlineAt }),
    ]));
    expectSafeRouting(h, call.sessionId);
  });

  it("can start the first simultaneous window after an initial wait for capacity", async () => {
    const h = world();
    const releaseCapacity = occupyCapacity(h, 12);
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.attempts(call.sessionId)).toHaveLength(0);
    expect(routing(h, call.sessionId).find(row => row.kind === "selection")).toMatchObject({
      selectedCount: 0, skippedCount: 2, startedAt: null, deadlineAt: null,
      members: expect.arrayContaining([
        expect.objectContaining({ profileId: PROFILES.o1, outcome: "skipped", reason: "capacity" }),
        expect.objectContaining({ profileId: PROFILES.o2, outcome: "skipped", reason: "capacity" }),
      ]),
    });

    releaseCapacity();
    h.advance(6_000);
    await sweep(h);

    expect(h.attempts(call.sessionId)).toHaveLength(2);
    expect(h.attempts(call.sessionId).map(row => row.offered_at)).toEqual([h.now().toISOString(), h.now().toISOString()]);
    expect(backup(h, call.sessionId)).toBeNull();
    expect(routing(h, call.sessionId).filter(row => row.kind === "selection").at(-1)).toMatchObject({
      selectedCount: 2, skippedCount: 0, startedAt: h.now().toISOString(), deadlineAt: new Date(h.now().getTime() + 25_000).toISOString(),
    });
  });

  it("recovers a failed audit with the original routing snapshot after device availability changes", async () => {
    const h = world();
    h.touchDevice(PROFILES.o2, 121_000);
    const original = h.db.takeInjectedError.bind(h.db);
    let auditFailed = false;
    const failure = vi.spyOn(h.db, "takeInjectedError").mockImplementation((table, operation) => {
      if (!auditFailed && table === "motorist_call_events" && operation === "insert" && h.telnyx.of("dial").length > 0) {
        auditFailed = true;
        return { code: "XX000", message: "routing audit temporarily unavailable", details: null, hint: null };
      }
      return original(table, operation);
    });
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(auditFailed).toBe(true);
    expect(routing(h, call.sessionId)).toEqual([]);
    const pending = readPendingEffects(h.session(call.sessionId) as SessionRow).entries;
    const originalRouting = pending.flatMap(entry => entry.transition.routing ?? []);
    const originalEventId = pending.find(entry => entry.transition.routing?.length)!.event.id;
    expect(originalRouting).toHaveLength(1);
    expect(originalRouting[0].members).toContainEqual(expect.objectContaining({ profileId: PROFILES.o2, reason: "device_stale", heartbeatAgeMs: 121_000 }));
    const firstDialTarget = h.telnyx.of("dial")[0].params.to;

    failure.mockRestore();
    h.advance(5 * 60_000);
    h.touchDevice(PROFILES.o2);
    expect((await runPendingEffectRecovery(h.deps)).status).toBe("ok");

    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toEqual([]);
    const recoveredEvent = h.callEvents(call.sessionId).find(row => row.event_fingerprint === originalEventId)!;
    expect((recoveredEvent.normalized_payload as { routing: RoutingDiagnostic[] }).routing).toEqual(originalRouting);
    expect(h.telnyx.of("dial").filter(dial => dial.params.to === firstDialTarget)).toHaveLength(1);
    // Recovery also sweeps the now-expired step, without summoning the newly live device.
    expect(h.legFor(call.sessionId, PROFILES.o2)).toBeNull();
    expect(backup(h, call.sessionId)).not.toBeNull();
    expectSafeRouting(h, call.sessionId);
  });

  it("skips a device that remains stale and starts backup after the available operator times out", async () => {
    const h = world();
    h.touchDevice(PROFILES.o2, 121_000);
    const call = await h.inbound({ to: NUMBERS.allianz });
    h.advance(20_000);
    await hangup(h, control(h, call.sessionId, PROFILES.o1));

    expect(h.legFor(call.sessionId, PROFILES.o2)).toBeNull();
    expect(backup(h, call.sessionId)).not.toBeNull();
  });

  it("advances to backup when a sweep recovers a missing hangup instead of opening another window", async () => {
    const h = world();
    h.touchDevice(PROFILES.o2, 121_000);
    const call = await h.inbound({ to: NUMBERS.allianz });
    h.advance(3_000);
    h.touchDevice(PROFILES.o2);
    h.advance(23_000); // Past the existing five-second recovery grace.
    await sweep(h);

    expect(h.legFor(call.sessionId, PROFILES.o2)).toBeNull();
    expect(backup(h, call.sessionId)).not.toBeNull();
    expect(h.attempts(call.sessionId)[0].result).toBe("no_answer");
  });

  it("does not turn a simultaneous step into sequential windows when the fanout limit is one", async () => {
    const h = world();
    h.db.update("motorist_telephony_settings", { max_ring_fanout: 1 }, () => true);
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.attempts(call.sessionId)).toHaveLength(1);

    h.advance(20_000);
    await hangup(h, control(h, call.sessionId, PROFILES.o1));

    expect(h.legFor(call.sessionId, PROFILES.o2)).toBeNull();
    expect(backup(h, call.sessionId)).not.toBeNull();
  });

  it("does not add another window when partial capacity frees after the first offer starts", async () => {
    const h = world();
    const releaseCapacity = occupyCapacity(h, 10); // Caller + one operator fill the 12-leg cap.
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.attempts(call.sessionId)).toHaveLength(1);
    expect(h.legFor(call.sessionId, PROFILES.o1)).not.toBeNull();
    expect(h.legFor(call.sessionId, PROFILES.o2)).toBeNull();

    h.advance(5_000);
    releaseCapacity();
    h.advance(15_000);
    await hangup(h, control(h, call.sessionId, PROFILES.o1));

    expect(h.legFor(call.sessionId, PROFILES.o2)).toBeNull();
    expect(backup(h, call.sessionId)).not.toBeNull();
  });

  it("advances immediately after the final early refusal without waiting out the maximum", async () => {
    const h = world();
    const call = await h.inbound({ to: NUMBERS.allianz });
    h.advance(5_000);
    await hangup(h, control(h, call.sessionId, PROFILES.o1), "user_busy");
    expect(backup(h, call.sessionId)).toBeNull();
    h.advance(1_000);
    await hangup(h, control(h, call.sessionId, PROFILES.o2), "call_rejected");

    expect(backup(h, call.sessionId)).not.toBeNull();
    expect(h.attempts(call.sessionId).at(-1)?.offered_at).toBe(h.now().toISOString());
  });

  it("starts the next configured group before using the external fallback", async () => {
    const h = world();
    h.db.delete("motorist_ring_group_members", row => row.ring_group_id === GROUPS.b);
    h.db.seed("motorist_ring_group_members", [{ organization_id: ORG, ring_group_id: GROUPS.b, member_kind: "operator", profile_id: PROFILES.o5, external_number: null, position: 0, ring_secs: null }]);
    h.db.seed("motorist_ring_plan_steps", [{ organization_id: ORG, ring_plan_id: PLAN_ID, step_index: 1, ring_group_id: GROUPS.b, timeout_secs: 10, strategy: "all" }]);
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.attempts(call.sessionId)).toHaveLength(2);

    h.advance(20_000);
    await hangup(h, control(h, call.sessionId, PROFILES.o1));
    await hangup(h, control(h, call.sessionId, PROFILES.o2));
    expect(h.legFor(call.sessionId, PROFILES.o5)).not.toBeNull();
    expect(h.attempts(call.sessionId).at(-1)).toMatchObject({ step_index: 1, profile_id: PROFILES.o5, ring_secs: 10, offered_at: h.now().toISOString() });
    expect(backup(h, call.sessionId)).toBeNull();

    h.advance(10_000);
    await hangup(h, control(h, call.sessionId, PROFILES.o5));
    expect(backup(h, call.sessionId)).not.toBeNull();
    expect(h.attempts(call.sessionId).at(-1)).toMatchObject({ step_index: 2, external_number: NUMBERS.external, offered_at: h.now().toISOString() });
  });

  it.each(["operator", "external"] as const)("waits for both endpoints of one operator when %s ends first, then skips a newly available member", async firstRole => {
    const h = world();
    const mobileNumber = "+421900000099";
    h.db.update("motorist_operator_telephony_settings", { default_mobile_number: mobileNumber }, row => row.profile_id === PROFILES.o1);
    h.db.seed("motorist_ring_group_members", [{ organization_id: ORG, ring_group_id: GROUPS.a, member_kind: "external_number",
      profile_id: null, owner_profile_id: PROFILES.o1, external_number: mobileNumber, position: 2, ring_secs: null }]);
    h.touchDevice(PROFILES.o2, 121_000);
    const call = await h.inbound({ to: NUMBERS.allianz });
    const endpoints = h.legs(call.sessionId).filter(leg => leg.profile_id === PROFILES.o1);
    expect(endpoints).toHaveLength(2);
    const first = endpoints.find(leg => leg.role === firstRole)!;
    const second = endpoints.find(leg => leg.role !== firstRole)!;
    expect(h.attempts(call.sessionId)).toHaveLength(2);

    h.advance(3_000);
    h.touchDevice(PROFILES.o2);
    h.advance(7_000);
    await hangup(h, String(first.telnyx_call_control_id), "user_busy");
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "ringing", current_session_id: call.sessionId });
    expect(h.attempts(call.sessionId).filter(row => row.result === "offered")).toHaveLength(1);
    expect(backup(h, call.sessionId)).toBeNull();
    expect(h.legFor(call.sessionId, PROFILES.o2)).toBeNull();

    h.advance(10_000);
    await hangup(h, String(second.telnyx_call_control_id));
    expect(h.legFor(call.sessionId, PROFILES.o2)).toBeNull();
    expect(backup(h, call.sessionId)).not.toBeNull();
    expect(h.attempts(call.sessionId)).toHaveLength(3);
    expect(routing(h, call.sessionId)[0]?.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ profileId: PROFILES.o1, endpoint: "sip", outcome: "selected" }),
      expect.objectContaining({ profileId: PROFILES.o1, endpoint: "pstn", outcome: "selected" }),
    ]));
    expectSafeRouting(h, call.sessionId, [mobileNumber]);
  });
});
