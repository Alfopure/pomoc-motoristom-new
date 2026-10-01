import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, GROUPS, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { setPresence } from "../presence-service";
import { effectsDeps, runSessionEvent } from "../session-runner";
import { TelnyxCommandError } from "../telnyx/client";
import { cancelRevokedOffers } from "./cancelled-offers";
import { readPendingEffects } from "./continuation";
import { readMeta, type SessionRow } from "./types";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function world() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false, fallbackKind: "waiting_room" });
  h.db.update("motorist_operator_telephony_settings", { default_mobile_number: NUMBERS.external }, row => row.profile_id === PROFILES.o1);
  h.db.insert("motorist_ring_group_members", { organization_id: ORG, ring_group_id: GROUPS.a, member_kind: "external_number",
    profile_id: null, owner_profile_id: PROFILES.o1, external_number: NUMBERS.external, position: 3, ring_secs: null });
  return h;
}

function endpoints(h: TelephonyHarness, sessionId: string) {
  const legs = h.legs(sessionId).filter(leg => leg.profile_id === PROFILES.o1);
  return {
    web: String(legs.find(leg => leg.role === "operator")!.telnyx_call_control_id),
    mobile: String(legs.find(leg => leg.role === "external")!.telnyx_call_control_id),
  };
}

const ownerAttempts = (h: TelephonyHarness, sessionId: string) => h.attempts(sessionId).filter(row => row.profile_id === PROFILES.o1);

async function answer(h: TelephonyHarness, callControlId: string) {
  h.telnyx.physical.answered(callControlId);
  await h.legEvent(callControlId, "call.answered");
}

async function hangup(h: TelephonyHarness, callControlId: string) {
  h.telnyx.physical.ended(callControlId);
  await h.legEvent(callControlId, "call.hangup", { hangup_cause: "normal_clearing" });
}

describe("simultaneous web and owned mobile fanout", () => {
  it.each(["web", "mobile"] as const)("connects the %s winner, stops its sibling and preserves ownership after late sibling events", async winner => {
    const h = world();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const targets = endpoints(h, call.sessionId);
    const loser = winner === "web" ? "mobile" : "web";
    const token = h.presence(PROFILES.o1).offer_token;

    expect(h.telnyx.of("dial")).toHaveLength(4);
    expect(new Set(h.telnyx.of("dial").map(row => row.params.commandId)).size).toBe(4);
    expect(ownerAttempts(h, call.sessionId)).toHaveLength(2);
    expect(new Set(ownerAttempts(h, call.sessionId).map(row => row.leg_id)).size).toBe(2);
    expect(token).toEqual(expect.any(String));
    expect(h.clientStateOf(targets.web).offerToken).toBe(token);
    expect(h.clientStateOf(targets.mobile).offerToken).toBe(token);

    // Both devices physically answer before either webhook is reduced. Only
    // the first serialized provider fact may connect a leg to the caller.
    h.telnyx.physical.answered(targets.web);
    h.telnyx.physical.answered(targets.mobile);
    expect(h.telnyx.physical.connections()).toEqual([]);
    await h.legEvent(targets[winner], "call.answered");
    expect(h.telnyx.physical.connected(call.callControlId, targets[winner])).toBe(true);
    expect(h.telnyx.physical.connected(call.callControlId, targets[loser])).toBe(false);
    expect(h.telnyx.physical.legs.get(targets[loser])?.ended).toBe(true);
    expect(ownerAttempts(h, call.sessionId).map(row => row.result).sort()).toEqual(["answered", "cancelled"]);

    await h.legEvent(targets[loser], "call.answered");
    await hangup(h, targets[loser]);
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o1 });
    expect(readMeta(h.session(call.sessionId) as SessionRow).answered_leg_call_control_id).toBe(targets[winner]);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: call.sessionId, offer_token: token });
    expect(h.telnyx.physical.connected(call.callControlId, targets[winner])).toBe(true);
  });

  it("keeps the mobile reservation when the web dial is definitively rejected", async () => {
    const h = world();
    h.telnyx.failNext("dial", new TelnyxCommandError({ code: "rejected", status: 422, detail: "SIP unavailable" }));
    const call = await h.inbound({ to: NUMBERS.allianz });
    const attempts = ownerAttempts(h, call.sessionId);
    expect(attempts.find(row => row.member_kind === "operator")?.result).toBe("failed");
    expect(attempts.find(row => row.member_kind === "external_number")?.result).toBe("offered");
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "ringing", current_session_id: call.sessionId });
    const mobile = String(h.legs(call.sessionId).find(leg => leg.to_number === NUMBERS.external)!.telnyx_call_control_id);
    await answer(h, mobile);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
    expect(h.telnyx.physical.connected(call.callControlId, mobile)).toBe(true);
  });

  it.each(["web", "mobile"] as const)("keeps the other endpoint answerable when %s hangs up before answering", async ended => {
    const h = world();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const targets = endpoints(h, call.sessionId);
    const remaining = ended === "web" ? "mobile" : "web";
    const token = h.presence(PROFILES.o1).offer_token;
    await hangup(h, targets[ended]);
    expect(ownerAttempts(h, call.sessionId).filter(row => row.result === "offered")).toHaveLength(1);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "ringing", current_session_id: call.sessionId, offer_token: token });
    await answer(h, targets[remaining]);
    expect(h.telnyx.physical.connected(call.callControlId, targets[remaining])).toBe(true);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: call.sessionId, offer_token: token });
  });

  it("releases the owner only after both endpoint offers end", async () => {
    const h = world();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const targets = endpoints(h, call.sessionId);
    await hangup(h, targets.web);
    expect(h.presence(PROFILES.o1).status).toBe("ringing");
    await hangup(h, targets.mobile);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "available", current_session_id: null, offer_token: null });
    expect(ownerAttempts(h, call.sessionId).every(row => row.result !== "offered")).toBe(true);
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.attempts(call.sessionId).filter(row => row.result === "offered")).toHaveLength(2);
  });

  it("releases both endpoint reservations when every dial is definitively refused", async () => {
    const h = world();
    h.db.delete("motorist_ring_plan_steps", row => row.step_index === 1);
    for (let i = 0; i < 4; i++) h.telnyx.failNext("dial", new TelnyxCommandError({ code: "rejected", status: 422, detail: "Dial refused" }));
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(ownerAttempts(h, call.sessionId)).toHaveLength(2);
    expect(ownerAttempts(h, call.sessionId).every(row => row.result === "failed")).toBe(true);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "available", current_session_id: null, offer_token: null });
    expect(h.session(call.sessionId).state).toBe("waiting");
  });

  it("cancels both endpoint offers when the caller hangs up", async () => {
    const h = world();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const targets = endpoints(h, call.sessionId);
    await hangup(h, call.callControlId);
    for (const target of Object.values(targets)) expect(h.telnyx.physical.legs.get(target)?.ended).toBe(true);
    expect(ownerAttempts(h, call.sessionId).map(row => row.result)).toEqual(["cancelled", "cancelled"]);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "available", current_session_id: null, offer_token: null });
    await h.legEvent(targets.mobile, "call.answered");
    expect(h.telnyx.of("bridge")).toHaveLength(0);
    expect(h.presence(PROFILES.o1).status).toBe("available");
  });

  it("pausing the operator revokes both endpoints under their shared token", async () => {
    const h = world();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const targets = endpoints(h, call.sessionId);
    const token = String(h.presence(PROFILES.o1).offer_token);
    await setPresence(h.deps, { organizationId: ORG, profileId: PROFILES.o1, status: "paused", pauseReasonId: "00000000-0000-4000-8000-000000002501" });
    await cancelRevokedOffers(effectsDeps(h.deps), h.session(call.sessionId) as SessionRow);
    expect(h.session(call.sessionId).presence_cancellations).toHaveProperty(token);
    for (const target of Object.values(targets)) expect(h.telnyx.physical.legs.get(target)?.ended).toBe(true);
    expect(ownerAttempts(h, call.sessionId).map(row => row.result)).toEqual(["cancelled", "cancelled"]);
    await h.legEvent(targets.web, "call.answered");
    await h.legEvent(targets.mobile, "call.answered");
    expect(h.telnyx.of("bridge")).toHaveLength(0);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "paused", current_session_id: null });
  });

  it("keeps a shared offer while a sibling dial outcome is unknown without blindly repeating either dial", async () => {
    const h = world();
    h.telnyx.loseNextResponse("dial");
    const call = await h.inbound({ to: NUMBERS.allianz });
    const token = h.presence(PROFILES.o1).offer_token;
    expect(h.telnyx.of("dial")).toHaveLength(4);
    expect(ownerAttempts(h, call.sessionId).filter(row => row.result === "offered")).toHaveLength(2);
    expect(h.rows("motorist_provider_commands").filter(row => row.path === "/calls" && row.outcome === "unknown")).toHaveLength(1);
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries.length).toBeGreaterThan(0);

    await runSessionEvent(h.deps, call.sessionId, { kind: "app", id: h.nextEventId(), type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(h.telnyx.of("dial")).toHaveLength(4);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "ringing", current_session_id: call.sessionId, offer_token: token });
    expect(ownerAttempts(h, call.sessionId).filter(row => row.result === "offered")).toHaveLength(2);

    // Losing the known mobile offer does not prove the unknown browser dial
    // failed: it may still be ringing until its original provider fact lands.
    const mobile = String(h.legs(call.sessionId).find(leg => leg.to_number === NUMBERS.external)!.telnyx_call_control_id);
    await hangup(h, mobile);
    expect(h.telnyx.of("dial")).toHaveLength(4);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "ringing", current_session_id: call.sessionId, offer_token: token });
    expect(ownerAttempts(h, call.sessionId).find(row => row.member_kind === "operator")?.result).toBe("offered");
  });
});
