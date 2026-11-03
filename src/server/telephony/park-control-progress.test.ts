import { afterEach, describe, expect, it, vi } from "vitest";
import { completeCallAnnouncements } from "@/test/complete-call-announcements";
import { createTelephonyHarness, PROFILES } from "@/test/telephony-harness";
import { buildPhoneBarModel } from "@/lib/telephony/active-calls-model";
import { phoneBarCapabilities, phoneBarStateLabel } from "@/components/dispatch/phone-bar-model";
import { loadActiveCalls } from "./active-calls";
import { holdCall, parkCall, unholdCall } from "./call-actions";
import { TelnyxCommandError } from "./telnyx/client";
import { runSessionEvent } from "./session-runner";
import { readPendingEffects } from "./state/continuation";
import type { SessionRow } from "./state/types";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };

async function talking() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "false");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  const call = await h.inbound();
  await completeCallAnnouncements(h, call.sessionId);
  const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  h.telnyx.physical.answered(operator);
  await h.legEvent(operator, "call.answered");
  for (const leg of h.legs(call.sessionId)) if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) {
    await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  return { h, call, operator };
}

describe("confirmed hold and waiting-room controls", () => {
  it.each(["hold", "unhold", "park"] as const)("sends %s before a stalled state-only leg projection", async actionName => {
    const { h, call } = await talking();
    if (actionName !== "hold") await holdCall(h.deps, actor, call.sessionId);
    h.telnyx.calls.length = 0;
    const original = h.db.rpcHandlers.get("motorist_apply_critical_v2")!;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let reached = false;
    h.db.registerRpc("motorist_apply_critical_v2", async (args, db) => {
      if (Array.isArray(args.p_legs) && args.p_legs.length) { reached = true; await blocked; }
      return original(args, db);
    });
    const action = { hold: holdCall, unhold: unholdCall, park: parkCall }[actionName](h.deps, actor, call.sessionId);
    try {
      await vi.waitFor(() => expect(reached).toBe(true));
      expect(h.telnyx.of({ hold: "conference:hold", unhold: "conference:unhold", park: "hangup" }[actionName])).toHaveLength(1);
      if (actionName === "park") expect(h.telnyx.of("playbackStart")).toHaveLength(1);
    } finally { release(); await action; }
  });

  it("recovers a failed post-media projection without repeating accepted provider actions", async () => {
    const { h, call } = await talking();
    const original = h.db.rpcHandlers.get("motorist_apply_critical_v2")!;
    h.db.registerRpc("motorist_apply_critical_v2", (args, db) => {
      if (Array.isArray(args.p_legs) && args.p_legs.length) throw new Error("state projection unavailable");
      return original(args, db);
    });
    await expect(parkCall(h.deps, actor, call.sessionId)).rejects.toThrow("state projection unavailable");
    const before = structuredClone(h.telnyx.calls);
    expect(h.telnyx.of("playbackStart").at(-1)?.params.callControlId).toBe(call.callControlId);
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries.length).toBeGreaterThan(0);
    h.db.registerRpc("motorist_apply_critical_v2", original);
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", type: "sweep", id: "recover-park-projection", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(h.telnyx.calls).toEqual(before);
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toEqual([]);
    expect(h.session(call.sessionId).state).toBe("parked");
  });

  it("disconnects the operator and starts waiting audio before reading slow wrap-up settings", async () => {
    const { h, call, operator } = await talking();
    await holdCall(h.deps, actor, call.sessionId);
    await unholdCall(h.deps, actor, call.sessionId);
    h.telnyx.calls.length = 0;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const wrapUp = vi.fn(async () => { await blocked; return { data: { wrap_up_seconds: 30 }, error: null }; });
    const from = h.client.from.bind(h.client);
    vi.spyOn(h.client, "from").mockImplementation(table => {
      const query = from(table);
      if (table === "motorist_operator_telephony_settings") vi.spyOn(query, "maybeSingle").mockImplementation(wrapUp as unknown as typeof query.maybeSingle);
      return query;
    });
    const action = parkCall(h.deps, actor, call.sessionId);
    try {
      await vi.waitFor(() => expect(wrapUp).toHaveBeenCalled());
      expect(h.telnyx.of("conference:leave")).toHaveLength(1);
      expect(h.telnyx.of("hangup").some(command => command.params.callControlId === operator)).toBe(true);
      expect(h.telnyx.of("playbackStart").some(command => command.params.callControlId === call.callControlId)).toBe(true);
      expect(h.presence(PROFILES.o1).current_session_id).toBe(call.sessionId);
    } finally { release(); await action; }
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "after_call_work", current_session_id: null });
  });

  it("retries a failed presence release without repeating the accepted waiting-room commands", async () => {
    const { h, call } = await talking();
    const from = h.client.from.bind(h.client);
    const unavailable = vi.spyOn(h.client, "from").mockImplementation(table => {
      const query = from(table);
      if (table === "motorist_operator_telephony_settings") vi.spyOn(query, "maybeSingle").mockRejectedValue(new Error("wrap-up settings unavailable"));
      return query;
    });
    await expect(parkCall(h.deps, actor, call.sessionId)).rejects.toMatchObject({ status: 502 });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
    const before = structuredClone(h.telnyx.calls);
    expect(h.telnyx.of("playbackStart").at(-1)?.params.callControlId).toBe(call.callControlId);
    unavailable.mockRestore();
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", type: "sweep", id: "recover-park-presence", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(h.telnyx.calls).toEqual(before);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "after_call_work", current_session_id: null });
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toEqual([]);
  });

  it.each(["hold", "unhold", "park"] as const)("shows %s as pending across refresh while its provider command is blocked", async actionName => {
    const { h, call } = await talking();
    if (actionName === "unhold" || actionName === "park") await holdCall(h.deps, actor, call.sessionId);
    const before = h.session(call.sessionId).state;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const conference = h.telnyx.client.conferenceAction.bind(h.telnyx.client);
    const target = actionName === "hold" ? "hold" : actionName === "unhold" ? "unhold" : "leave";
    let reached = false;
    vi.spyOn(h.telnyx.client, "conferenceAction").mockImplementation(async (...args) => {
      if (args[1] === target) { reached = true; await blocked; }
      return conference(...args);
    });
    const actions = { hold: holdCall, unhold: unholdCall, park: parkCall };
    const action = actions[actionName](h.deps, actor, call.sessionId);
    try {
      await vi.waitFor(() => expect(reached).toBe(true));
      const snapshot = await loadActiveCalls({ ...h.deps, configured: true }, { profileId: PROFILES.o1, canManageAssignments: false });
      expect(snapshot.waiting).toEqual([]);
      expect(snapshot.calls[0]).toMatchObject({ state: before, answeredByProfileId: PROFILES.o1, controlPending: { action: actionName } });
      const active = buildPhoneBarModel(snapshot).active!;
      expect(active).not.toBeNull();
      expect(phoneBarStateLabel(active).label).toBe({ hold: "Podržiavam…", unhold: "Obnovujem hovor…", park: "Presúvam do čakárne…" }[actionName]);
      expect(phoneBarCapabilities({ call: active, browserCallActive: true, browserCallRinging: false }))
        .toMatchObject({ hold: false, unhold: false, park: false, pickup: false, hangup: true, mute: true });
    } finally { release(); await action; }
    const snapshot = await loadActiveCalls({ ...h.deps, configured: true }, { profileId: PROFILES.o1, canManageAssignments: false });
    expect(snapshot.calls[0].controlPending).toBeNull();
    expect(snapshot.calls[0].state).toBe({ hold: "held", unhold: "talking", park: "parked" }[actionName]);
  });

  it("keeps the operator reserved and reports an unconfirmed park when the hangup fails", async () => {
    const { h, call } = await talking();
    h.telnyx.failAlways("hangup", new TelnyxCommandError({ detail: "temporary provider failure", status: 503, code: "provider_unavailable" }));
    await expect(parkCall(h.deps, actor, call.sessionId)).rejects.toMatchObject({ status: 502 });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
    const pending = await loadActiveCalls({ ...h.deps, configured: true }, { profileId: PROFILES.o1, canManageAssignments: false });
    expect(pending.waiting).toEqual([]);
    expect(pending.calls[0]).toMatchObject({ controlPending: { action: "park" } });
    expect(phoneBarStateLabel(buildPhoneBarModel(pending).active!).label).toBe("Presun do čakárne nepotvrdený");
  });
});
