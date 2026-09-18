import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { describe, expect, it } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { addCallParty, blindTransfer, createRateLimiter, holdCall, type CallActionDeps, type CallActor } from "./call-actions";

const o1: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Jana" };
const o2: CallActor = { profileId: PROFILES.o2, role: "dispatcher", displayName: "Peter" };
const PARTY = "+421900000001";

const deps = (h: TelephonyHarness): CallActionDeps => ({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) });

/** The provider answers the leg before the webhook says so. */
async function answer(h: TelephonyHarness, cc: string) {
  h.telnyx.physical.answered(cc);
  await h.legEvent(cc, "call.answered");
}

async function hangup(h: TelephonyHarness, cc: string, cause = "normal_clearing") {
  h.telnyx.physical.ended(cc);
  await h.legEvent(cc, "call.hangup", { hangup_cause: cause });
}

/** Inbound call answered by o1 (losers hung up) → talking. */
async function talking(h: TelephonyHarness) {
  const call = await h.inbound({ to: NUMBERS.allianz });
  const winner = h.legFor(call.sessionId, PROFILES.o1)!;
  await answer(h, String(winner.telnyx_call_control_id));
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) {
      await hangup(h, String(leg.telnyx_call_control_id), "originator_cancel");
    }
  }
  expect(h.session(call.sessionId).state).toBe("talking");
  return { call, operatorLeg: String(winner.telnyx_call_control_id) };
}

/** Adds an external third party and answers it. */
async function addParty(h: TelephonyHarness, actor: CallActor, sessionId: string) {
  await completeAnnouncedAction(h, addCallParty(deps(h), actor, sessionId, { number: PARTY }));
  const leg = h.legs(sessionId).find((row) => row.to_number === PARTY && !row.ended_at)!;
  await answer(h, String(leg.telnyx_call_control_id));
  return String(leg.telnyx_call_control_id);
}

describe("who can still hear whom after somebody leaves a three-way", () => {
  it("keeps the caller and the added party together when the operator drops", async () => {
    const h = createTelephonyHarness();
    const { call, operatorLeg } = await talking(h);
    const party = await addParty(h, o1, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("conference");
    expect(h.telnyx.physical.connected(call.callControlId, party)).toBe(true);

    await hangup(h, operatorLeg);

    // The operator stepped out of their own three-way. The other two were
    // talking a second ago and nothing about that changed.
    expect(h.telnyx.physical.connected(call.callControlId, party)).toBe(true);
    expect(h.session(call.sessionId).state).toBe("talking");
  });

  it("keeps the caller and the operator together when the added party hangs up", async () => {
    const h = createTelephonyHarness();
    const { call, operatorLeg } = await talking(h);
    const party = await addParty(h, o1, call.sessionId);

    await hangup(h, party);

    expect(h.telnyx.physical.connected(call.callControlId, operatorLeg)).toBe(true);
    expect(h.session(call.sessionId).state).toBe("talking");
  });

  it("does the same after a transfer, which is how it was reported", async () => {
    const h = createTelephonyHarness();
    const { call, operatorLeg } = await talking(h);

    // What was actually clicked: transfer first, then add a number to the call
    // the new operator is now on.
    await completeAnnouncedAction(h, blindTransfer(deps(h), o1, call.sessionId, { profileId: PROFILES.o2 }));
    const transfer = h.telnyx.of("transfer")[0].params;
    // The provider mints the target leg and bridges the caller onto it; the
    // webhook only reports the id afterwards. Using the id it actually minted
    // is what makes the audio below mean anything.
    // The newest, not the first: o2 was already rung once when the call came in.
    const target = [...h.telnyx.physical.legs.values()].filter((leg) => leg.to === transfer.to).at(-1)!.id;
    await h.process(h.envelope("call.initiated", { call_control_id: target, call_leg_id: `leg-${target}`,
      call_session_id: call.telnyxSessionId, client_state: transfer.targetLegClientState, direction: "outgoing" }));
    await answer(h, target);
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o2 });
    expect(h.telnyx.physical.connected(call.callControlId, target)).toBe(true);
    expect(operatorLeg).toBeTruthy();

    const party = await addParty(h, o2, call.sessionId);
    expect(h.telnyx.physical.connected(call.callControlId, party)).toBe(true);
    expect(h.telnyx.physical.connected(target, party)).toBe(true);

    // The transferred-to operator leaves. The caller and the added number were
    // audible to each other a second ago.
    await hangup(h, target);

    expect(h.telnyx.physical.connected(call.callControlId, party)).toBe(true);
  });

  it("lets the operator finish with the added number when the caller hangs up", async () => {
    const h = createTelephonyHarness();
    const { call, operatorLeg } = await talking(h);
    const party = await addParty(h, o1, call.sessionId);
    expect(h.telnyx.physical.connected(operatorLeg, party)).toBe(true);

    // The caller leaves a three-way. The operator was mid-sentence with the
    // number they added — a tow service, a partner — and that conversation is
    // not the caller's to end.
    await hangup(h, call.callControlId);

    expect(h.telnyx.physical.connected(operatorLeg, party)).toBe(true);
    expect(h.telnyx.physical.legs.get(party)?.ended).toBe(false);
    expect(h.telnyx.of("hangup").filter((entry) => entry.params.callControlId === party)).toHaveLength(0);
  });

  it("hangs the added number up once the operator leaves too", async () => {
    const h = createTelephonyHarness();
    const { call, operatorLeg } = await talking(h);
    const party = await addParty(h, o1, call.sessionId);
    await hangup(h, call.callControlId);

    // The operator finishes and hangs up. Nobody is left for the added number
    // to talk to, and a stranger holding a silent call is worse than a
    // goodbye.
    await hangup(h, operatorLeg);

    expect(h.telnyx.of("hangup").some((entry) => entry.params.callControlId === party)).toBe(true);
    h.telnyx.physical.ended(party);
    await h.legEvent(party, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(["ended", "wrap_up"]).toContain(h.session(call.sessionId).state);
  });

  it("still ends the call when the caller leaves an ordinary two-party conversation", async () => {
    const h = createTelephonyHarness();
    const { call, operatorLeg } = await talking(h);

    await hangup(h, call.callControlId);

    // Nobody is left to talk to, so nothing is kept alive.
    expect(h.telnyx.of("hangup").some((entry) => entry.params.callControlId === operatorLeg)).toBe(true);
    expect(h.session(call.sessionId).state).toBe("wrap_up");
  });

  it("never leaves the caller held behind a departing operator", async () => {
    const h = createTelephonyHarness();
    const { call, operatorLeg } = await talking(h);

    // Held first, then a number added: answering the party takes the caller
    // off hold, which is the only way all three become audible.
    await completeAnnouncedAction(h, holdCall(deps(h), o1, call.sessionId));
    const party = await addParty(h, o1, call.sessionId);
    expect(h.session(call.sessionId).hold_started_at).toBeNull();
    expect(h.telnyx.of("conference:unhold").length).toBeGreaterThan(0);

    // And hold is refused once there are three, so nobody can be muted and
    // then abandoned by the operator who muted them.
    await expect(completeAnnouncedAction(h, holdCall(deps(h), o1, call.sessionId)))
      .rejects.toMatchObject({ status: 409 });

    await hangup(h, operatorLeg);
    expect(h.telnyx.physical.connected(call.callControlId, party)).toBe(true);
  });
});
