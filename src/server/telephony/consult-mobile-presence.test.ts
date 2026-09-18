import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { addCallParty, cancelConsult, completeTransfer, createRateLimiter, startConsult, type CallActionDeps, type CallActor } from "./call-actions";

const o1: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Jana" };
const MOBILE = "+421905123456";

afterEach(() => vi.unstubAllEnvs());

const deps = (h: TelephonyHarness): CallActionDeps => ({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) });

/** o2 takes their calls on their own phone: no browser device at all. */
function harness() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness();
  h.db.insert("motorist_operator_telephony_settings", [{ organization_id: ORG, profile_id: PROFILES.o2,
    delivery_mode: "personal_mobile", default_mobile_number: MOBILE, pause_routing_mode: "none", wrap_up_seconds: 30 }]);
  h.db.delete("motorist_operator_devices", (row) => row.profile_id === PROFILES.o2);
  return h;
}

async function talking(h: TelephonyHarness) {
  const call = await h.inbound({ to: NUMBERS.allianz });
  const winner = h.legFor(call.sessionId, PROFILES.o1)!;
  await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) {
      await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup", { hangup_cause: "originator_cancel" });
    }
  }
  return call;
}

/** The colleague's own leg, dialled to their mobile. */
const mobileLeg = (h: TelephonyHarness, sessionId: string) =>
  String(h.legs(sessionId).find((leg) => leg.to_number === MOBILE && !leg.ended_at)!.telnyx_call_control_id);

async function consulting(h: TelephonyHarness) {
  const call = await talking(h);
  await completeAnnouncedAction(h, startConsult(deps(h), o1, call.sessionId, { profileId: PROFILES.o2 }));
  // Their phone is ringing, so they are not free for anything else.
  expect(h.presence(PROFILES.o2)).toMatchObject({ status: "ringing", current_session_id: call.sessionId });
  return { call, leg: mobileLeg(h, call.sessionId) };
}

describe("a colleague consulted on their own phone", () => {
  it("is taken out of the ring plan while their phone rings", async () => {
    const h = harness();
    const { call } = await consulting(h);

    // Before this the dial carried no profile at all: the colleague's phone
    // rang while the ring plan was still free to offer them another call.
    expect(h.telnyx.of("dial").at(-1)?.params.to).toBe(MOBILE);
    expect(h.presence(PROFILES.o2).current_session_id).toBe(call.sessionId);
  });

  it("is released when they answer and the transfer completes", async () => {
    const h = harness();
    const { call, leg } = await consulting(h);
    await h.legEvent(leg, "call.answered");
    expect(h.presence(PROFILES.o2).status).toBe("on_call");

    await completeAnnouncedAction(h, completeTransfer(deps(h), o1, call.sessionId));
    expect(h.session(call.sessionId).answered_by_profile_id).toBe(PROFILES.o2);

    await h.legEvent(String(h.legs(call.sessionId).find((row) => row.role === "customer")!.telnyx_call_control_id), "call.hangup");
    expect(h.presence(PROFILES.o2).current_session_id).toBeNull();
  });

  it("is released when they never pick up", async () => {
    const h = harness();
    const { leg } = await consulting(h);

    await h.legEvent(leg, "call.hangup", { hangup_cause: "no_answer" });

    expect(h.presence(PROFILES.o2)).toMatchObject({ status: "available", current_session_id: null });
  });

  it("is released when the operator cancels the consultation", async () => {
    const h = harness();
    const { call, leg } = await consulting(h);
    await h.legEvent(leg, "call.answered");

    await completeAnnouncedAction(h, cancelConsult(deps(h), o1, call.sessionId));
    await h.legEvent(leg, "call.hangup", { hangup_cause: "normal_clearing" });

    expect(h.presence(PROFILES.o2).current_session_id).toBeNull();
  });

  it("is released when they hang up after answering", async () => {
    const h = harness();
    const { leg } = await consulting(h);
    await h.legEvent(leg, "call.answered");

    await h.legEvent(leg, "call.hangup", { hangup_cause: "normal_clearing" });

    expect(h.presence(PROFILES.o2).current_session_id).toBeNull();
  });

  it("occupies the colleague when added to a call, and refuses to add them twice", async () => {
    const h = harness();
    const call = await talking(h);
    await completeAnnouncedAction(h, addCallParty(deps(h), o1, call.sessionId, { profileId: PROFILES.o2 }));
    await h.legEvent(mobileLeg(h, call.sessionId), "call.answered");
    expect(h.presence(PROFILES.o2)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });

    // Being on the call is what refuses the second add; the reducer's own
    // guard now names them too, rather than seeing a number with no owner.
    await expect(completeAnnouncedAction(h, addCallParty(deps(h), o1, call.sessionId, { profileId: PROFILES.o2 })))
      .rejects.toMatchObject({ status: 409 });
  });
});
