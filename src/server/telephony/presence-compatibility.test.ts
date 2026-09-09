import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { blindTransfer, callColleague, parkCall, pickupWaitingCall, startOutboundCall } from "./call-actions";
import { reserveAnsweredOperator, reserveOperator, reserveOperatorPickup } from "./routing/reservation";
import { setPresence } from "./presence-service";
import { applyPresenceChange } from "./state/effects";
import { effectsDeps } from "./session-runner";
import type { SessionRow } from "./state/types";

afterEach(() => vi.unstubAllEnvs());
const actor = (profileId: string) => ({ profileId, role: "dispatcher" as const });

async function talking(h: TelephonyHarness) {
  const call = await h.inbound({ to: NUMBERS.allianz });
  const first = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  await h.legEvent(first, "call.answered");
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  return { ...call, first };
}

describe("migrated presence with compatibility callers", () => {
  it.each(["false", "true"])("models the installed boolean RPC independently of runtime flag %s", async flag => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", flag);
    const h = createTelephonyHarness();
    const session = h.db.insert("motorist_call_sessions", { organization_id: ORG, state: "waiting" })[0];
    expect(await reserveOperator(h.admin, { profileId: PROFILES.o1, sessionId: String(session.id) })).toBe(true);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "on_call", offer_token: expect.any(String), presence_revision: 2 });
  });

  it.each([
    { creation: "false", answer: "false", exit: "false" },
    { creation: "true", answer: "true", exit: "true" },
    { creation: "true", answer: "false", exit: "false" },
  ])("retains pickup owner from creation=$creation through answer=$answer and exit=$exit", async flags => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", flags.creation);
    const h = createTelephonyHarness();
    const call = await talking(h);
    await completeAnnouncedAction(h, parkCall(h.deps, actor(PROFILES.o1), call.sessionId));
    await h.legEvent(call.first, "call.hangup");
    const picked = await pickupWaitingCall(h.deps, actor(PROFILES.o2), call.sessionId);
    const cc = picked.operatorLegCallControlId!;
    const token = h.clientStateOf(cc)!.offerToken;
    expect(token).toBeTruthy();
    expect(h.presence(PROFILES.o2).offer_token).toBe(token);
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", flags.answer);
    await h.legEvent(cc, "call.answered");
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", flags.exit);
    await h.legEvent(call.callControlId, "call.hangup");
    await h.legEvent(cc, "call.hangup");
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.presence(PROFILES.o2)).toMatchObject({ status: "after_call_work", current_session_id: null, offer_token: null });
    await expect(setPresence(h.deps, { organizationId: ORG, profileId: PROFILES.o2, status: "available" })).resolves.toMatchObject({ status: "available" });
  });

  it.each([false, true])("binds compatibility transfer ownership when answer precedes initiated=%s", async answerFirst => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    const h = createTelephonyHarness();
    const call = await talking(h);
    await completeAnnouncedAction(h, blindTransfer(h.deps, actor(PROFILES.o1), call.sessionId, { profileId: PROFILES.o2 }));
    await h.legEvent(call.first, "call.hangup");
    const transfer = h.telnyx.of("transfer").at(-1)!.params;
    const payload = { call_control_id: "compat-transfer", call_leg_id: "compat-transfer-leg", call_session_id: call.telnyxSessionId,
      client_state: transfer.targetLegClientState, direction: "outgoing", to: "sip:gencred002@sip.telnyx.com" };
    if (!answerFirst) await h.process(h.envelope("call.initiated", payload));
    await h.process(h.envelope("call.answered", payload));
    const owned = h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === "compat-transfer")!;
    expect(owned.client_state).toMatchObject({ offerToken: h.presence(PROFILES.o2).offer_token });
    expect(h.presence(PROFILES.o2).offer_token).toBeTruthy();
    await h.legEvent(call.callControlId, "call.hangup");
    await h.legEvent("compat-transfer", "call.hangup");
    expect(h.presence(PROFILES.o2).current_session_id).toBeNull();
  });

  it("retains ownership for both internal parties and outbound caller with creation disabled", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    const h = createTelephonyHarness();
    const internal = await callColleague(h.deps, actor(PROFILES.o1), { targetProfileId: PROFILES.o2 });
    await h.legEvent(internal.operatorLegCallControlId, "call.answered");
    const callee = String(h.legFor(internal.sessionId, PROFILES.o2)!.telnyx_call_control_id);
    await h.legEvent(callee, "call.answered");
    for (const profileId of [PROFILES.o1, PROFILES.o2]) expect(h.legFor(internal.sessionId, profileId)!.client_state).toMatchObject({ offerToken: h.presence(profileId).offer_token });
    await h.legEvent(internal.operatorLegCallControlId, "call.hangup");
    await h.legEvent(callee, "call.hangup");
    for (const profileId of [PROFILES.o1, PROFILES.o2]) expect(h.presence(profileId).current_session_id).toBeNull();
    await setPresence(h.deps, { organizationId: ORG, profileId: PROFILES.o1, status: "available" });
    const outbound = await startOutboundCall(h.deps, actor(PROFILES.o1), { to: NUMBERS.customer });
    expect(h.clientStateOf(outbound.operatorLegCallControlId)!.offerToken).toBe(h.presence(PROFILES.o1).offer_token);
    await h.legEvent(outbound.operatorLegCallControlId, "call.hangup");
    expect(h.presence(PROFILES.o1).current_session_id).toBeNull();
  });

  it.each(["binding_failure", "session_cas_retry"])("does not lose a newly acquired answer token during %s", async fault => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    const h = createTelephonyHarness();
    const call = await talking(h);
    await completeAnnouncedAction(h, blindTransfer(h.deps, actor(PROFILES.o1), call.sessionId, { profileId: PROFILES.o2 }));
    const transfer = h.telnyx.of("transfer").at(-1)!.params;
    const payload = { call_control_id: "fault-transfer", call_session_id: call.telnyxSessionId,
      client_state: transfer.targetLegClientState, direction: "outgoing", to: "sip:gencred002@sip.telnyx.com" };
    await h.process(h.envelope("call.initiated", payload));
    if (fault === "binding_failure") h.db.failNext("motorist_call_legs", "update", "binding storage unavailable");
    else {
      const update = h.db.update.bind(h.db);
      let raced = false;
      vi.spyOn(h.db, "update").mockImplementation((table, values, filter) => {
        if (!raced && table === "motorist_call_sessions" && values.state === "talking") {
          raced = true;
          const row = h.db.storage(table).find(item => item.id === call.sessionId)!;
          row.version = Number(row.version) + 1;
        }
        return update(table, values, filter);
      });
    }
    await h.process(h.envelope("call.answered", payload));
    if (fault === "binding_failure") expect(h.presence(PROFILES.o2).current_session_id).toBeNull();
    else {
      expect(h.session(call.sessionId).state).toBe("talking");
      expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === "fault-transfer")!.client_state)
        .toMatchObject({ offerToken: h.presence(PROFILES.o2).offer_token });
      await h.legEvent("fault-transfer", "call.hangup");
      expect(h.presence(PROFILES.o2).current_session_id).toBeNull();
    }
  });

  it("rejects a historical tokenless answer and release against a newer same-session owner", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    const h = createTelephonyHarness();
    const session = h.db.insert("motorist_call_sessions", { organization_id: ORG, state: "waiting" })[0];
    const own = { organizationId: ORG, profileId: PROFILES.o1, sessionId: String(session.id) };
    const offered = await reserveOperatorPickup(h.admin, own);
    expect((await reserveAnsweredOperator(h.admin, own)).applied).toBe(false);
    expect(await applyPresenceChange(effectsDeps(h.deps), session as SessionRow, { profileId: PROFILES.o1, status: "available", sessionId: null, onlyIfSession: own.sessionId, reason: "old leg ended" })).toBe(false);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "ringing", offer_token: offered.offerToken, current_session_id: own.sessionId });
  });
});
