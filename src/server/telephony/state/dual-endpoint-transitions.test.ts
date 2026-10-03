import { describe, expect, it } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES } from "@/test/telephony-harness";
import { loadRoutingContext, loadSessionSnapshot } from "../session-runner";
import type { TelnyxClientState } from "../telnyx/client-state";
import { reduce } from "./transitions";
import { readMeta, toJson, type AttemptRow, type LegRow, type TelephonyEvent } from "./types";

async function dualRingSnapshot() {
  const h = createTelephonyHarness();
  const call = await h.inbound({ to: NUMBERS.allianz });
  const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
  const context = await loadRoutingContext(h.deps, snapshot.session);
  const sip = snapshot.legs.find(leg => leg.profile_id === PROFILES.o1)!;
  const mobile: LegRow = { ...sip, id: "00000000-0000-4000-8000-00000000d001", telnyx_call_control_id: "owned-mobile",
    telnyx_call_leg_id: "owned-mobile-leg", role: "external", to_number: NUMBERS.external,
    client_state: toJson({ ...h.clientStateOf(sip.telnyx_call_control_id), role: "external" }) };
  snapshot.legs.push(mobile);
  const sipAttempt = snapshot.attempts.find(attempt => attempt.profile_id === PROFILES.o1)!;
  const mobileAttempt: AttemptRow = { ...sipAttempt, id: "00000000-0000-4000-8000-00000000d002", member_kind: "external_number",
    external_number: NUMBERS.external, leg_id: null, position: 3 };
  // Provider events may arrive before the accepted-dial bookkeeping linked
  // either leg. Correlation must then select the exact endpoint, not owner.
  sipAttempt.leg_id = null;
  snapshot.attempts.push(mobileAttempt);
  const event = (leg: LegRow, type: string): TelephonyEvent => ({ kind: "telnyx", id: `dual:${leg.id}:${type}`, type,
    occurredAt: h.now().toISOString(), callControlId: leg.telnyx_call_control_id, callLegId: leg.telnyx_call_leg_id,
    callSessionId: call.telnyxSessionId, connectionId: "app-test", clientState: leg.client_state as TelnyxClientState,
    rawClientState: null, from: leg.from_number, to: leg.to_number, direction: "outgoing", state: null,
    hangupCause: "no_answer", hangupSource: "callee", sipHangupCause: null, digits: null, status: null,
    conferenceId: null, customHeaders: [], payload: {} });
  return { h, snapshot, context, sip, mobile, sipAttempt, mobileAttempt, event };
}

describe("one operator offered on SIP and a personal mobile", () => {
  it.each(["sip", "mobile"] as const)("accepts the %s endpoint and cancels its sibling without releasing the owner", async endpoint => {
    const world = await dualRingSnapshot();
    const { snapshot, context, sip, mobile, event, sipAttempt, mobileAttempt } = world;
    const winner = world[endpoint];
    const loser = endpoint === "sip" ? mobile : sip;
    const winnerAttempt = endpoint === "sip" ? sipAttempt : mobileAttempt;
    const loserAttempt = endpoint === "sip" ? mobileAttempt : sipAttempt;

    const result = reduce(snapshot.session, snapshot.legs, snapshot.attempts, event(winner, "call.answered"), context);

    expect(result.next.session).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o1 });
    expect(result.next.attempts).toContainEqual(expect.objectContaining({ id: winnerAttempt.id, values: expect.objectContaining({ result: "answered" }) }));
    expect(result.next.attempts).toContainEqual(expect.objectContaining({ id: loserAttempt.id, values: expect.objectContaining({ result: "cancelled" }) }));
    expect(result.commands).toContainEqual(expect.objectContaining({ kind: "hangup", leg: { callControlId: loser.telnyx_call_control_id } }));
    expect(result.next.presence.filter(change => change.profileId === PROFILES.o1 && change.sessionId === null)).toEqual([]);
  });

  it.each(["sip", "mobile"] as const)("keeps the shared reservation when %s ends while its sibling still rings", async endpoint => {
    const world = await dualRingSnapshot();
    const { snapshot, context, event, sipAttempt, mobileAttempt } = world;
    const failedAttempt = endpoint === "sip" ? sipAttempt : mobileAttempt;
    const siblingAttempt = endpoint === "sip" ? mobileAttempt : sipAttempt;

    const result = reduce(snapshot.session, snapshot.legs, snapshot.attempts, event(world[endpoint], "call.hangup"), context);

    expect(result.next.attempts).toContainEqual(expect.objectContaining({ id: failedAttempt.id, values: expect.objectContaining({ result: "no_answer" }) }));
    expect(result.next.attempts.some(change => change.id === siblingAttempt.id)).toBe(false);
    expect(result.next.presence.some(change => change.profileId === PROFILES.o1)).toBe(false);
    expect(result.commands).toEqual([]);
  });

  it.each(["sip", "mobile"] as const)("ignores late sibling answer and hangup after %s won", async endpoint => {
    const world = await dualRingSnapshot();
    const { snapshot, context, h, event } = world;
    const winner = world[endpoint];
    const loser = endpoint === "sip" ? world.mobile : world.sip;
    winner.answered_at = h.now().toISOString();
    winner.state = "answered";
    snapshot.session = { ...snapshot.session, state: "talking", answered_by_profile_id: PROFILES.o1,
      answered_at: winner.answered_at, metadata: toJson({ ...readMeta(snapshot.session),
        answered_leg_call_control_id: winner.telnyx_call_control_id,
        accepted_device_legs: { [PROFILES.o1]: winner.telnyx_call_control_id } }) };

    const answered = reduce(snapshot.session, snapshot.legs, snapshot.attempts, event(loser, "call.answered"), context);
    expect(answered.commands).toHaveLength(1);
    expect(answered.commands[0]).toMatchObject({ kind: "hangup", leg: { callControlId: loser.telnyx_call_control_id } });
    expect(answered.next.presence).toEqual([]);
    // A losing device may report both answer and hangup after winner admission.
    loser.answered_at = h.now().toISOString();
    const hungup = reduce(snapshot.session, snapshot.legs, snapshot.attempts, event(loser, "call.hangup"), context);
    expect(hungup.commands).toEqual([]);
    expect(hungup.next.presence).toEqual([]);
    expect(hungup.next.session.state).toBeUndefined();
  });
});
