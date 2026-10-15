import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { callColleague, createRateLimiter } from "../call-actions";
import { runSessionEvent } from "../session-runner";
import { readPendingEffects } from "./continuation";
import type { SessionRow } from "./types";
import { TelnyxCommandError } from "../telnyx/client";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function world() {
  for (const [key, value] of Object.entries({ APP_BASE_URL: "https://test.dispecing.linkapomoci.sk", TELEPHONY_STABILITY_V1_ENABLED: "true", MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev", VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co", MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true" })) vi.stubEnv(key, value);
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  h.db.seed("motorist_operator_mobile_devices", [{ organization_id: ORG, profile_id: PROFILES.o2, environment: "development", sip_username: "native-colleague", device_session_id: "00000000-0000-4000-8000-000000009001", device_seen_at: h.now().toISOString(), registration_state: "registered" }]);
  return h;
}
async function start(h: TelephonyHarness) {
  return callColleague({ ...h.deps, rateLimiter: createRateLimiter() }, actor, { targetProfileId: PROFILES.o2, requestId: "00000000-0000-4000-8000-000000009002" });
}
const targets = (h: TelephonyHarness, id: string) => h.legs(id).filter(leg => leg.profile_id === PROFILES.o2);
const refused = () => new TelnyxCommandError({ code: "rejected", status: 422, detail: "endpoint unavailable" });
describe("initial colleague web and native endpoint fanout", () => {
  it.each(["web", "mobile"])("rings both endpoints and retains only the %s winner after late loser events", async endpoint => {
    const h = world(), call = await start(h);
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    const legs = targets(h, call.sessionId); expect(legs).toHaveLength(2);
    expect(new Set(h.telnyx.of("dial").map(row => row.params.commandId)).size).toBe(3);
    const winner = legs.find(leg => (h.clientStateOf(String(leg.telnyx_call_control_id)).applicationDevice === "mobile") === (endpoint === "mobile"))!;
    const loser = legs.find(leg => leg !== winner)!;
    const winId = String(winner.telnyx_call_control_id), loseId = String(loser.telnyx_call_control_id);
    h.telnyx.physical.answered(call.operatorLegCallControlId); h.telnyx.physical.answered(winId); h.telnyx.physical.answered(loseId);
    await h.legEvent(winId, "call.answered");
    expect(h.telnyx.physical.connected(call.operatorLegCallControlId, winId)).toBe(true);
    expect(h.telnyx.physical.legs.get(loseId)?.ended).toBe(true);
    await h.legEvent(loseId, "call.answered"); await h.legEvent(loseId, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.presence(PROFILES.o2).current_session_id).toBe(call.sessionId);
    expect(h.attempts(call.sessionId).map(row => row.result).sort()).toEqual(["answered", "cancelled"]);
  });
  it("keeps native ringing when web dial is definitely refused", async () => {
    const h = world(), call = await start(h); h.telnyx.failNext("dial", refused());
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(targets(h, call.sessionId)).toHaveLength(1);
    expect(targets(h, call.sessionId)[0].to_number).toBe("sip:native-colleague@sip.telnyx.com");
    expect(h.telnyx.of("hangup").some(row => row.params.callControlId === call.operatorLegCallControlId)).toBe(false);
  });
  it("terminates and releases the caller when every endpoint is definitely refused", async () => {
    const h = world(), call = await start(h); h.telnyx.failNext("dial", refused()); h.telnyx.failNext("dial", refused());
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    expect(h.session(call.sessionId).state).toBe("failed");
    expect(h.telnyx.of("hangup").some(row => row.params.callControlId === call.operatorLegCallControlId)).toBe(true);
    expect(h.presence(PROFILES.o1).current_session_id).toBeNull();
    expect(h.presence(PROFILES.o2).current_session_id).toBeNull();
  });
  it.each(["web", "mobile"])("retains a single eligible %s endpoint", async endpoint => {
    const h = world(); h.db.delete(endpoint === "web" ? "motorist_operator_mobile_devices" : "motorist_operator_devices", row => row.profile_id === PROFILES.o2);
    const call = await start(h); await h.legEvent(call.operatorLegCallControlId, "call.answered");
    expect(targets(h, call.sessionId)).toHaveLength(1);
  });
  it("keeps the legacy web-only selection with the native gate disabled", async () => {
    const h = world(); vi.stubEnv("MOTORIST_NATIVE_VOICE_TEST_ENABLED", "false");
    const call = await start(h); await h.legEvent(call.operatorLegCallControlId, "call.answered");
    expect(targets(h, call.sessionId)).toHaveLength(1);
    expect(targets(h, call.sessionId)[0].to_number).not.toContain("native-colleague");
  });
  it("does not consume the customer reserve for the extra endpoint", async () => {
    const h = world(); h.db.update("motorist_telephony_settings", { max_concurrent_legs: 5 }, () => true);
    await expect(start(h)).rejects.toMatchObject({ code: "colleague_capacity" }); expect(h.telnyx.calls).toHaveLength(0);
  });
  it("rings both phones of a paused colleague and preserves the pause", async () => {
    const h = world(); h.setPresence(PROFILES.o2, { status: "paused", current_session_id: null });
    const call = await start(h); await h.legEvent(call.operatorLegCallControlId, "call.answered");
    expect(targets(h, call.sessionId)).toHaveLength(2); expect(h.presence(PROFILES.o2).status).toBe("paused");
  });
  it("reconciles an accepted unknown dial with original identities and no duplicate physical endpoint", async () => {
    const h = world(), call = await start(h); h.telnyx.loseNextResponse("dial");
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries.length).toBeGreaterThan(0);
    const firstIds = h.telnyx.of("dial").map(row => row.params.commandId);
    h.advance(31_000);
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", id: h.nextEventId(), type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(targets(h, call.sessionId)).toHaveLength(1);
    expect(h.telnyx.of("dial")).toHaveLength(3);
    const original = h.telnyx.of("dial")[1];
    const unknown = [...h.telnyx.physical.legs.values()].find(leg => leg.to === original.params.to)!;
    h.telnyx.physical.answered(call.operatorLegCallControlId); h.telnyx.physical.answered(unknown.id);
    await h.process(h.envelope("call.answered", { call_control_id: unknown.id, call_leg_id: `leg-${unknown.id}`,
      client_state: original.params.clientState, to: original.params.to, from: original.params.from, direction: "outgoing" }));
    expect(targets(h, call.sessionId)).toHaveLength(2);
    expect(h.telnyx.physical.connected(call.operatorLegCallControlId, unknown.id)).toBe(true);
    expect(new Set(h.telnyx.of("dial").map(row => row.params.commandId))).toEqual(new Set(firstIds));
    expect(h.telnyx.physical.legs.size).toBe(3);
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toHaveLength(0);
    expect(targets(h, call.sessionId).find(leg => leg.telnyx_call_control_id === unknown.id)).toMatchObject({ answered_at: h.now().toISOString(), profile_id: PROFILES.o2 });
    expect(h.attempts(call.sessionId).map(attempt => attempt.result).sort()).toEqual(["answered", "cancelled"]);
    const winningRow = targets(h, call.sessionId).find(leg => leg.telnyx_call_control_id === unknown.id)!;
    expect(h.attempts(call.sessionId).find(attempt => attempt.result === "answered")?.leg_id).toBe(winningRow.id);
    const sibling = targets(h, call.sessionId).find(leg => leg.telnyx_call_control_id !== unknown.id)!;
    await h.legEvent(String(sibling.telnyx_call_control_id), "call.answered");
    await h.legEvent(String(sibling.telnyx_call_control_id), "call.hangup", { hangup_cause: "originator_cancel" });
    await h.legEvent(unknown.id, "call.answered");
    expect(h.session(call.sessionId).state).toBe("talking"); expect(h.telnyx.of("bridge")).toHaveLength(1);
  });
  it("keeps the caller when the persisted offer ends while its sibling outcome is unknown", async () => {
    const h = world(), call = await start(h); h.telnyx.loseNextResponse("dial");
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    const native = targets(h, call.sessionId)[0]; expect(native).toBeDefined();
    await h.legEvent(String(native.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("hangup").some(row => row.params.callControlId === call.operatorLegCallControlId)).toBe(false);
  });
  it("caller teardown supersedes unknown fanout and late answers cannot reconnect", async () => {
    const h = world(), call = await start(h); h.telnyx.loseNextResponse("dial");
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    const native = targets(h, call.sessionId)[0];
    await h.legEvent(call.operatorLegCallControlId, "call.hangup", { hangup_cause: "normal_clearing" });
    h.advance(31_000);
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", id: h.nextEventId(), type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
    await h.legEvent(String(native.telnyx_call_control_id), "call.answered");
    expect(["ended", "failed"]).toContain(h.session(call.sessionId).state);
    expect(h.telnyx.of("bridge")).toHaveLength(0);
    expect(h.telnyx.of("dial")).toHaveLength(3);
  });
  it("ends only after both unanswered sibling offers end", async () => {
    const h = world(), call = await start(h); await h.legEvent(call.operatorLegCallControlId, "call.answered");
    const [web, native] = targets(h, call.sessionId);
    await h.legEvent(String(web.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
    expect(h.session(call.sessionId).state).toBe("ringing");
    await h.legEvent(String(native.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
    expect(h.session(call.sessionId).state).toBe("ended");
  });

  it("serializes near-simultaneous sibling answers into exactly one bridge", async () => {
    const h = world(), call = await start(h); await h.legEvent(call.operatorLegCallControlId, "call.answered");
    const ids = targets(h, call.sessionId).map(leg => String(leg.telnyx_call_control_id));
    h.telnyx.physical.answered(call.operatorLegCallControlId); ids.forEach(id => h.telnyx.physical.answered(id));
    await Promise.all(ids.map(id => h.legEvent(id, "call.answered")));
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    expect(h.telnyx.physical.connections()).toHaveLength(1);
    expect(h.attempts(call.sessionId).map(attempt => attempt.result).sort()).toEqual(["answered", "cancelled"]);
  });
  it("retries a stage CAS conflict before inserting the early winner or issuing its bridge", async () => {
    const h = world(), call = await start(h); h.telnyx.loseNextResponse("dial");
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    const dial = h.telnyx.of("dial")[1], unknown = [...h.telnyx.physical.legs.values()].find(leg => leg.to === dial.params.to)!;
    const originalStage = h.db.rpcHandlers.get("motorist_stage_transition_v1")!;
    let rejected = false;
    h.db.registerRpc("motorist_stage_transition_v1", (args, db) => {
      if (args.p_guard && !rejected) {
        rejected = true;
        expect(h.legs(call.sessionId).some(leg => leg.telnyx_call_control_id === unknown.id)).toBe(false);
        expect(h.telnyx.of("bridge")).toHaveLength(0);
        h.db.update("motorist_call_sessions", { version: Number(h.session(call.sessionId).version) + 1 }, row => row.id === call.sessionId);
        return { applied: false };
      }
      return originalStage(args, db);
    });
    const result = await h.process(h.envelope("call.answered", { call_control_id: unknown.id, call_leg_id: `leg-${unknown.id}`,
      client_state: dial.params.clientState, to: dial.params.to, from: dial.params.from, direction: "outgoing" }));
    expect(rejected).toBe(true); expect(result.outcome).toBe("processed");
    expect(h.legs(call.sessionId).filter(leg => leg.telnyx_call_control_id === unknown.id)).toHaveLength(1);
    expect(h.telnyx.of("bridge")).toHaveLength(1);
  });
  it("does not bridge before early winner row creation succeeds and resumes the same durable entry", async () => {
    const h = world(), call = await start(h); h.telnyx.loseNextResponse("dial");
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    const dial = h.telnyx.of("dial")[1], unknown = [...h.telnyx.physical.legs.values()].find(leg => leg.to === dial.params.to)!;
    h.db.failNext("motorist_call_legs", "insert", "temporary row insert failure");
    await h.process(h.envelope("call.answered", { call_control_id: unknown.id, call_leg_id: `leg-${unknown.id}`,
      client_state: dial.params.clientState, to: dial.params.to, from: dial.params.from, direction: "outgoing" }));
    expect(h.legs(call.sessionId).some(leg => leg.telnyx_call_control_id === unknown.id)).toBe(false);
    expect(h.telnyx.of("bridge")).toHaveLength(0);
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries.length).toBeGreaterThan(0);
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", id: h.nextEventId(), type: "sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(h.legs(call.sessionId).filter(leg => leg.telnyx_call_control_id === unknown.id)).toHaveLength(1);
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    expect(h.telnyx.physical.legs.size).toBe(3);
  });

  it("excludes an expired background push lease but admits the current exact lease", async () => {
    const h = world(); vi.stubEnv("MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED", "true");
    h.db.update("motorist_operator_mobile_devices", { device_seen_at: new Date(h.now().getTime() - 180_000).toISOString(), telnyx_credential_id: "owned-test",
      metadata: { native_voip: { v: 1, platform: "ios", deviceSessionId: "00000000-0000-4000-8000-000000009001", until: h.now().toISOString() } } }, () => true);
    const expired = await start(h); expect((h.session(expired.sessionId).metadata as { internal: { endpoints?: unknown[] } }).internal.endpoints).toBeUndefined();
    const another = world();
    another.db.update("motorist_operator_mobile_devices", { device_seen_at: new Date(another.now().getTime() - 180_000).toISOString(), telnyx_credential_id: "owned-test",
      metadata: { native_voip: { v: 1, platform: "ios", deviceSessionId: "00000000-0000-4000-8000-000000009001", until: new Date(another.now().getTime() + 60_000).toISOString() } } }, () => true);
    const current = await start(another); expect((another.session(current.sessionId).metadata as { internal: { endpoints: unknown[] } }).internal.endpoints).toHaveLength(2);
  });
  it("retains frozen endpoint targets on an uncertain initial request retry", async () => {
    const h = world(), call = await start(h);
    h.db.update("motorist_operator_mobile_devices", { sip_username: "rotated", device_session_id: "different" }, () => true);
    await expect(start(h)).rejects.toMatchObject({ code: "provider_outcome_unknown" }); expect(h.telnyx.of("dial")).toHaveLength(1);
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    expect(targets(h, call.sessionId).map(leg => leg.to_number)).toContain("sip:native-colleague@sip.telnyx.com");
    expect(targets(h, call.sessionId).map(leg => leg.to_number)).not.toContain("sip:rotated@sip.telnyx.com");
  });

  it("links an early legacy NULL-web attempt without linking the mobile sibling", async () => {
    const h = world(), call = await h.inbound();
    const web = h.legs(call.sessionId).find(leg => leg.profile_id === PROFILES.o1)!;
    const state = h.clientStateOf(String(web.telnyx_call_control_id));
    const attempt = h.attempts(call.sessionId).find(row => row.leg_id === web.id)!;
    h.db.delete("motorist_call_legs", row => row.id === web.id);
    h.db.update("motorist_ring_attempts", { leg_id: null, application_device: null }, row => row.id === attempt.id);
    h.db.seed("motorist_ring_attempts", [{ ...attempt, id: "00000000-0000-4000-8000-000000009088", leg_id: null, application_device: "mobile" }]);
    const { encodeClientState } = await import("../telnyx/client-state");
    await h.process(h.envelope("call.initiated", { call_control_id: web.telnyx_call_control_id, call_leg_id: web.telnyx_call_leg_id,
      client_state: encodeClientState(state), to: web.to_number, from: web.from_number, direction: "outgoing" }));
    const restored = h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === web.telnyx_call_control_id)!;
    expect(restored).toBeDefined();
    expect(h.attempts(call.sessionId).find(row => row.id === attempt.id)?.leg_id).toBe(restored.id);
    expect(h.attempts(call.sessionId).find(row => row.application_device === "mobile")?.leg_id).toBeNull();
  });

});
