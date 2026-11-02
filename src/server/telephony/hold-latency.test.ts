import { afterEach, describe, expect, it, vi } from "vitest";

import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { readNativeMedia } from "@/server/mobile/voice-hold";
import { holdCall, unholdCall, CallActionError, type CallActor } from "./call-actions";
import { defaultLatencyFlags, type LatencyFlags } from "./latency-flags";
import { payloadFingerprint } from "./provider-journal";
import type { TelephonyRuntimeDeps } from "./runtime";
import { loadRoutingContext, loadSessionSnapshot } from "./session-runner";
import { pendingCallControl } from "./state/control-progress";
import { reduce } from "./state/transitions";
import { readMeta, toJson, type AppEvent, type SessionRow } from "./state/types";
import { TelnyxCommandError } from "./telnyx/client";

/**
 * Call-speed S7 on the server side of a hold: join-with-hold on the first hold
 * (S7b, `hold_join_with_hold`, frozen per session) and the lean routing
 * context for hold/unhold (S7a.4, `hold_lean_context`). Every switch defaults
 * off, and off means today's commands and reads.
 */

const o1: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Jana" };

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function harness(flags: Partial<LatencyFlags> = {}) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  h.deps.latencyFlags = { ...defaultLatencyFlags(), ...flags };
  return h;
}

async function talking(h: TelephonyHarness) {
  const call = await h.inbound({ to: NUMBERS.allianz });
  const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  await h.legEvent(winner, "call.answered");
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  expect(h.session(call.sessionId)).toMatchObject({ state: "talking", writer_contract: 2 });
  return { ...call, operatorLeg: winner };
}

const meta = (h: TelephonyHarness, sessionId: string) => readMeta(h.session(sessionId) as SessionRow);
const providerMethods = (h: TelephonyHarness, from: number) => h.telnyx.calls.slice(from).map(call => call.method);

describe("join-with-hold on the first hold (S7b)", () => {
  it("is frozen into a new session only while the switch is on", async () => {
    const off = harness();
    expect(meta(off, (await talking(off)).sessionId).start_mode).not.toHaveProperty("holdJoinWithHold");
    const on = harness({ hold_join_with_hold: true });
    expect(meta(on, (await talking(on)).sessionId).start_mode).toMatchObject({ holdJoinWithHold: true });
  });

  it("joins the customer held: two provider commands, then hold and unhold as before", async () => {
    const h = harness({ hold_join_with_hold: true });
    const call = await talking(h);
    const from = h.telnyx.calls.length;

    const result = await holdCall(h.deps, o1, call.sessionId);

    expect(result).toMatchObject({ state: "held", ignored: null });
    expect(providerMethods(h, from)).toEqual(["createConference", "conference:join"]);
    const join = h.telnyx.of("conference:join").at(-1)!.params;
    expect(join).toMatchObject({ call_control_id: call.callControlId, hold: true, hold_audio_url: expect.stringMatching(/^https:\/\/media\.test\/telephony\/.+/) });
    expect(h.session(call.sessionId)).toMatchObject({ state: "held", conference_id: expect.any(String) });
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)).toMatchObject({ state: "held" });
    // The join is the hold's witness (the phone's media view reads it).
    expect(meta(h, call.sessionId).holdControl).toMatchObject({ held: true, customerControlId: call.callControlId,
      commandId: h.telnyx.of("conference:join").at(-1)!.params.commandId });

    await unholdCall(h.deps, o1, call.sessionId);
    expect(h.telnyx.of("conference:unhold").at(-1)!.params).toMatchObject({ call_control_ids: [call.callControlId] });
    expect(h.session(call.sessionId).state).toBe("talking");

    const later = h.telnyx.calls.length;
    await holdCall(h.deps, o1, call.sessionId);
    // The conference exists now: an ordinary conference hold.
    expect(providerMethods(h, later)).toEqual(["conference:hold"]);
    expect(h.session(call.sessionId).state).toBe("held");
  });

  it("keeps three commands for a session started with the switch off, even after it is turned on", async () => {
    const h = harness();
    const call = await talking(h);
    h.deps.latencyFlags = { ...defaultLatencyFlags(), hold_join_with_hold: true };
    const from = h.telnyx.calls.length;
    await holdCall(h.deps, o1, call.sessionId);
    expect(providerMethods(h, from)).toEqual(["createConference", "conference:join", "conference:hold"]);
    expect(h.telnyx.of("conference:join").at(-1)!.params).not.toHaveProperty("hold");
  });

  it("keeps three commands when the call is recorded or the phone holds it", async () => {
    const h = harness({ hold_join_with_hold: true });
    const call = await talking(h);
    const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
    const context = await loadRoutingContext(h.deps, snapshot.session, undefined, snapshot.legs);
    const event: AppEvent = { kind: "app", type: "hold", id: "evt-hold", actorProfileId: PROFILES.o1, occurredAt: h.now().toISOString() };
    const kinds = (session: SessionRow, input: AppEvent = event) => reduce(session, snapshot.legs, snapshot.attempts, input, context).commands.map(command => command.kind);
    expect(kinds(snapshot.session)).toEqual(["conference_create", "conference_join"]);
    const recorded = readMeta(snapshot.session);
    const withRecording = { ...snapshot.session, metadata: toJson({ ...recorded, recording: { ...recorded.recording!, policy: { ...recorded.recording!.policy, enabled: true } } }) } as SessionRow;
    expect(kinds(withRecording)).toContain("conference_hold");
    const nativeHold = { profileId: PROFILES.o1, deviceSessionId: "00000000-0000-4000-8000-000000000999", callControlId: call.operatorLeg,
      expectedVersion: Number(snapshot.session.version), customerControlId: call.callControlId };
    expect(kinds(snapshot.session, { ...event, nativeHold })).toEqual(["conference_create", "conference_join", "conference_hold"]);
  });

  it("lets the phone on the call see a held join as held, with its journal row as the witness", async () => {
    for (const [key, value] of Object.entries({ MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
      VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co",
      APP_BASE_URL: "https://test.dispecing.linkapomoci.sk", MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true" })) vi.stubEnv(key, value);
    const h = harness({ hold_join_with_hold: true });
    const call = await talking(h);
    const lease = "00000000-0000-4000-8000-000000000072";
    const web = h.rows("motorist_operator_devices").find(row => row.profile_id === PROFILES.o1)!;
    h.db.seed("motorist_operator_mobile_devices", [{ ...web, sip_username: "native-hold", device_session_id: lease, registration_state: "registered", metadata: {} }]);
    h.db.update("motorist_call_legs", { to_number: "sip:native-hold@sip.telnyx.com" }, row => row.telnyx_call_control_id === call.operatorLeg);
    const phone = { userId: PROFILES.o1, profileId: PROFILES.o1, organizationId: ORG, displayName: "Jana", role: "dispatcher" as const };
    const mobile = { ...h.deps, deviceKind: "mobile" } as TelephonyRuntimeDeps;

    await holdCall(h.deps, o1, call.sessionId);
    expect(h.telnyx.of("conference:hold")).toHaveLength(0);
    expect(await readNativeMedia(mobile, phone, call.sessionId, lease)).toMatchObject({ state: "held", canHold: true });
    // A join that did not carry the hold is no hold witness.
    const join = h.rows("motorist_provider_commands").find(row => String(row.path).endsWith("/actions/join"))!;
    const body = { ...(join.request_payload as Record<string, unknown>) };
    delete body.hold;
    h.db.update("motorist_provider_commands", { request_payload: body, fingerprint: payloadFingerprint({ method: "POST", path: String(join.path), body }) },
      row => row.command_id === join.command_id);
    await expect(readNativeMedia(mobile, phone, call.sessionId, lease)).rejects.toMatchObject({ status: 503 });
  });

  it("shows the hold as pending until the held join is done", async () => {
    const h = harness({ hold_join_with_hold: true });
    const call = await talking(h);
    h.telnyx.loseNextResponse("conference:join");
    await expect(holdCall(h.deps, o1, call.sessionId)).rejects.toBeInstanceOf(CallActionError);
    expect(pendingCallControl(h.session(call.sessionId) as SessionRow)?.progress).toMatchObject({ action: "hold" });
  });

  it("a refused held join leaves the call bridged and talking, the customer's leg as it was", async () => {
    const h = harness({ hold_join_with_hold: true });
    const call = await talking(h);
    const before = h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)!.state;
    h.telnyx.failNext("conference:join", new TelnyxCommandError({ code: "90000", status: 422, detail: "refused" }));

    await expect(holdCall(h.deps, o1, call.sessionId)).rejects.toBeInstanceOf(CallActionError);

    expect(h.telnyx.of("conference:leave").at(-1)!.params).toMatchObject({ call_control_id: call.operatorLeg });
    expect(h.telnyx.of("bridge").at(-1)!.params).toMatchObject({ callControlId: call.callControlId, targetCallControlId: call.operatorLeg });
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", hold_started_at: null, conference_id: null });
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)!.state).toBe(before);
    expect(meta(h, call.sessionId).holdControl ?? null).toBeNull();
  });
});

describe("lean routing context for hold and unhold (S7a.4)", () => {
  const appEvent = (h: TelephonyHarness, type: "hold" | "unhold"): AppEvent =>
    ({ kind: "app", type, id: `evt-${type}`, actorProfileId: PROFILES.o1, occurredAt: h.now().toISOString() });

  async function contexts(h: TelephonyHarness, sessionId: string, type: "hold" | "unhold") {
    const snapshot = await loadSessionSnapshot(h.deps, sessionId);
    const event = appEvent(h, type);
    const before = h.db.log.length;
    h.deps.latencyFlags = { ...defaultLatencyFlags(), hold_lean_context: true };
    const lean = await loadRoutingContext(h.deps, snapshot.session, event, snapshot.legs);
    const leanReads = h.db.log.length - before;
    h.deps.latencyFlags = defaultLatencyFlags();
    const full = await loadRoutingContext(h.deps, snapshot.session, event, snapshot.legs);
    return { snapshot, event, lean, full, leanReads };
  }

  it("reads nothing for a hold or an unhold with recording frozen off", async () => {
    const h = harness();
    const call = await talking(h);
    const hold = await contexts(h, call.sessionId, "hold");
    expect(hold.lean.lean).toBe(true);
    expect(hold.leanReads).toBe(0);
    expect(hold.full.lean).toBeUndefined();
    await holdCall(h.deps, o1, call.sessionId);
    const unhold = await contexts(h, call.sessionId, "unhold");
    expect(unhold.lean.lean).toBe(true);
    expect(unhold.leanReads).toBe(0);
  });

  it("keeps the full context when recording, pending effects or no frozen announcements are in play", async () => {
    const h = harness({ hold_lean_context: true });
    const call = await talking(h);
    const base = h.session(call.sessionId) as SessionRow;
    const baseMeta = readMeta(base);
    const event = appEvent(h, "hold");
    const legs = h.legs(call.sessionId) as never;
    const variants: Array<[string, SessionRow]> = [
      ["recording enabled", { ...base, metadata: toJson({ ...baseMeta, recording: { ...baseMeta.recording!, policy: { ...baseMeta.recording!.policy, enabled: true } } }) } as SessionRow],
      ["pending effects", { ...base, pending_effects: toJson({ version: 1, entries: [{ id: "x", commands: [], completedCommands: [] }] }) } as SessionRow],
      ["no frozen announcements", { ...base, metadata: toJson({ ...baseMeta, announcements: undefined }) } as SessionRow],
      ["announcement in flight", { ...base, metadata: toJson({ ...baseMeta, announcement_sequence: { id: "seq" } }) } as SessionRow],
    ];
    for (const [name, session] of variants) {
      expect((await loadRoutingContext(h.deps, session, event, legs)).lean, name).toBeUndefined();
    }
    expect((await loadRoutingContext(h.deps, base, appEvent(h, "hold"), legs)).lean).toBe(true);
    // The contact check a promotion stages (no command) does not count as pending work.
    const contactCheck = { ...base, pending_effects: toJson({ version: 1, entries: [{ id: "contact-check:op-1", commands: [], completedCommands: [] }] }) } as SessionRow;
    expect((await loadRoutingContext(h.deps, contactCheck, event, legs)).lean).toBe(true);
    // Only hold and unhold.
    expect((await loadRoutingContext(h.deps, base, { ...event, type: "park" }, legs)).lean).toBeUndefined();
  });

  // Completeness (as lean-answer-context.test.ts): the lean context must give
  // the reducer exactly what the full one gives it, for every hold shape.
  it.each([
    ["first hold", "hold", false, false],
    ["first hold with join-with-hold", "hold", true, false],
    ["first hold with action prompts", "hold", false, true],
    ["unhold", "unhold", false, false],
    ["unhold with action prompts", "unhold", false, true],
  ] as const)("reduces a %s exactly as the full context does", async (_name, type, joinHeld, prompts) => {
    if (prompts) vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "true");
    const h = harness(joinHeld ? { hold_join_with_hold: true } : {});
    const call = await talking(h);
    if (type === "unhold") {
      await completeAnnouncedAction(h, holdCall(h.deps, o1, call.sessionId));
      expect(h.session(call.sessionId).state).toBe("held");
      // A finished hold can leave its announcement and contact bookkeeping behind;
      // the comparison is about the reducer's inputs, not about that history.
      h.db.update("motorist_call_sessions", { pending_effects: null, metadata: toJson({ ...meta(h, call.sessionId), announcement_sequence: null }) }, row => row.id === call.sessionId);
    }
    const { snapshot, event, lean, full } = await contexts(h, call.sessionId, type);
    expect(lean.lean).toBe(true);
    const now = new Date(h.now().getTime());
    const reduceWith = (context: typeof lean) => JSON.stringify(reduce(snapshot.session, snapshot.legs, snapshot.attempts, event, { ...context, now }));
    expect(reduceWith(lean)).toBe(reduceWith(full));
  });
});
