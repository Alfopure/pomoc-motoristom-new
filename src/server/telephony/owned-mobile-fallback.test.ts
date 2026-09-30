import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { runSessionEvent } from "./session-runner";
import { readPendingEffects } from "./state/continuation";
import { readMeta, type SessionRow } from "./state/types";
import { decodeClientState } from "./telnyx/client-state";

const owner = PROFILES.o1;
const mobile = NUMBERS.external;

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function world(owned = true) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness({ fallbackKind: "external_number", writerContract: 2, sweepAfterEvent: false });
  h.db.update("motorist_telephony_lines", { metadata: {} }, () => true);
  h.db.delete("motorist_ring_plan_steps", row => row.step_index !== 0);
  h.db.delete("motorist_ring_group_members", row => row.profile_id !== owner);
  h.db.update("motorist_operator_telephony_settings", { default_mobile_number: owned ? mobile : null, delivery_mode: "web" }, row => row.profile_id === owner);
  return h;
}

const fallbackLeg = (h: TelephonyHarness, sessionId: string) =>
  h.legs(sessionId).find(leg => leg.to_number === mobile && !leg.ended_at);

async function expireBrowserOffer(h: TelephonyHarness, sessionId: string) {
  h.advance(26_000);
  await runSessionEvent(h.deps, sessionId, { kind: "app", id: h.nextEventId(), type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
  expect(readMeta(h.session(sessionId) as SessionRow).ring?.fallback).toBe("external_number");
}

async function answerFallback(h: TelephonyHarness, sessionId: string) {
  const leg = fallbackLeg(h, sessionId);
  expect(leg).toBeTruthy();
  const callControlId = String(leg!.telnyx_call_control_id);
  h.telnyx.physical.answered(callControlId);
  await h.legEvent(callControlId, "call.answered");
  return callControlId;
}

describe("automatic fallback to an operator's own mobile", () => {
  it("persists the owned mobile token before the provider can create its leg", async () => {
    const h = world();
    h.db.delete("motorist_operator_devices", row => row.profile_id === owner);
    const dialMany = h.telnyx.client.dialMany.bind(h.telnyx.client);
    let checkedBeforeDial = false;
    vi.spyOn(h.telnyx.client, "dialMany").mockImplementation(async list => {
      const dial = list.find(command => command.to === mobile);
      if (dial) {
        const state = decodeClientState(dial.clientState)!;
        const session = h.session(state.sid) as SessionRow;
        const durableDial = readPendingEffects(session).entries.flatMap(entry => entry.commands)
          .flatMap(command => command.kind === "ring_fanout" ? command.dials : [])
          .find(command => command.commandId === dial.commandId);
        expect(state).toMatchObject({ operatorId: owner, offerToken: expect.any(String) });
        expect(durableDial?.clientState).toEqual(state);
        expect(h.presence(owner)).toMatchObject({ status: "ringing", current_session_id: state.sid, offer_token: state.offerToken });
        expect(fallbackLeg(h, state.sid)).toBeUndefined();
        checkedBeforeDial = true;
      }
      return dialMany(list);
    });

    await h.inbound({ to: NUMBERS.allianz });

    expect(checkedBeforeDial).toBe(true);
  });

  it("connects the answered mobile after the same operator's browser offer times out", async () => {
    const h = world();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const browser = String(h.openLegFor(call.sessionId, owner)!.telnyx_call_control_id);

    await expireBrowserOffer(h, call.sessionId);
    const offered = String(fallbackLeg(h, call.sessionId)!.telnyx_call_control_id);
    expect(h.clientStateOf(offered)).toMatchObject({ operatorId: owner, offerToken: expect.any(String) });
    expect(h.presence(owner)).toMatchObject({ status: "ringing", current_session_id: call.sessionId,
      offer_token: h.clientStateOf(offered).offerToken });
    const beforeAnswer = h.telnyx.calls.length;
    const target = await answerFallback(h, call.sessionId);

    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: owner });
    expect(h.clientStateOf(target)).toMatchObject({ operatorId: owner, offerToken: expect.any(String) });
    expect(h.telnyx.physical.connected(call.callControlId, target)).toBe(true);
    expect(h.telnyx.calls.slice(beforeAnswer).filter(command => command.method === "hangup" && command.params.callControlId === target)).toEqual([]);
    expect(h.presence(owner)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });

    // The provider can acknowledge the superseded browser hangup after the
    // mobile has answered. That old fact must not disconnect the new leg.
    await h.legEvent(browser, "call.hangup", { hangup_cause: "no_answer" });
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.telnyx.physical.connected(call.callControlId, target)).toBe(true);
    expect(h.presence(owner)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
  });

  it("reserves and connects an available mobile owner whose browser is not registered", async () => {
    const h = world();
    h.db.delete("motorist_operator_devices", row => row.profile_id === owner);

    const call = await h.inbound({ to: NUMBERS.allianz });
    const offered = String(fallbackLeg(h, call.sessionId)!.telnyx_call_control_id);
    expect(h.telnyx.of("dial")).toHaveLength(1);
    expect(h.clientStateOf(offered)).toMatchObject({ operatorId: owner, offerToken: expect.any(String) });
    expect(h.presence(owner)).toMatchObject({ status: "ringing", current_session_id: call.sessionId });

    const target = await answerFallback(h, call.sessionId);

    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: owner });
    expect(h.telnyx.physical.connected(call.callControlId, target)).toBe(true);
    expect(h.presence(owner)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
  });

  it.each(["paused", "offline", "on_call"])("does not dial or acquire a %s owner through the external fallback", async status => {
    const h = world();
    const otherSession = "00000000-0000-4000-8000-000000009999";
    h.setPresence(owner, { status, current_session_id: status === "on_call" ? otherSession : null,
      offer_token: status === "on_call" ? "other-call-token" : null });
    const presence = structuredClone(h.presence(owner));

    const call = await h.inbound({ to: NUMBERS.allianz });

    expect(h.telnyx.of("dial").filter(command => command.params.to === mobile)).toEqual([]);
    expect(fallbackLeg(h, call.sessionId)).toBeUndefined();
    expect(h.presence(owner)).toEqual(presence);
    expect(h.attempts(call.sessionId).filter(attempt => attempt.external_number === mobile))
      .toEqual([expect.objectContaining({ result: "cancelled", ended_at: expect.any(String) })]);
  });

  it("keeps an independent external fallback answerable without operator ownership", async () => {
    const h = world(false);
    const call = await h.inbound({ to: NUMBERS.allianz });
    await expireBrowserOffer(h, call.sessionId);
    const offered = String(fallbackLeg(h, call.sessionId)!.telnyx_call_control_id);
    expect(h.clientStateOf(offered).operatorId).toBeUndefined();
    expect(h.clientStateOf(offered).offerToken).toBeUndefined();

    const target = await answerFallback(h, call.sessionId);

    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: null });
    expect(h.telnyx.physical.connected(call.callControlId, target)).toBe(true);
    expect(h.telnyx.of("hangup").filter(command => command.params.callControlId === target)).toEqual([]);
  });
});
