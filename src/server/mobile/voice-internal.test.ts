import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { createRateLimiter, hangupCall, startOutboundCall } from "@/server/telephony/call-actions";
import type { TelephonyRuntimeDeps } from "@/server/telephony/runtime";
import { createTelnyxClient } from "@/server/telephony/telnyx/client";
import { resolveNativeAttempt, startNativeInternalCall } from "./voice";
const actor = { userId: PROFILES.o1, profileId: PROFILES.o1, organizationId: ORG, displayName: "Caller", role: "dispatcher" as const };
const lease = "00000000-0000-4000-8000-000000000071", requestId = "00000000-0000-4000-8000-000000000991";
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const h = createTelephonyHarness({ writerContract: 2 });
  h.db.update("motorist_profiles", { kind: "human" }, () => true);
  const web = h.rows("motorist_operator_devices").find(row => row.profile_id === actor.profileId)!;
  h.db.seed("motorist_operator_mobile_devices", [{ ...web, sip_username: "native-caller", device_session_id: lease, registration_state: "registered", metadata: {} }]);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { call_control_id: "native-own-leg", call_leg_id: "provider-leg", call_session_id: "provider-session", is_alive: true } }), { status: 200 }));
  const telnyx = createTelnyxClient({ config: h.deps.config, fetch, liveGate: { callsEnabled: true, smsEnabled: false } });
  const deps = { ...h.deps, telnyx, deviceKind: "mobile", rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) } as TelephonyRuntimeDeps;
  const body = { deviceSessionId: lease, requestId, targetProfileId: PROFILES.o2 };
  return { h, deps, body, fetch, start: (input: unknown = body) => startNativeInternalCall(deps, actor, input) };
}
describe("native internal call command", () => {
  it("calls from the exact mobile endpoint and replays the same durable operation without another dial", async () => {
    const { h, start, fetch } = fixture(); const first = await start();
    expect(first).toMatchObject({ targetProfileId: PROFILES.o2, to: h.rows("motorist_profiles").find(row => row.id === PROFILES.o2)!.display_name });
    expect(first.to).not.toMatch(/sip:|@/);
    expect(h.legs(first.sessionId)).toMatchObject([{ profile_id: actor.profileId, to_number: "sip:native-caller@sip.telnyx.com", client_state: expect.objectContaining({ intent: "internal_caller" }) }]);
    expect(await start()).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.rows("motorist_call_sessions")).toHaveLength(1);
    expect(h.db.log.some(row => row.table === "motorist_provider_command_lookup_v2")).toBe(true);
  });
  it("never adopts a different target or call kind on replay", async () => {
    const { deps, body, start, fetch } = fixture(); await start();
    await expect(start({ ...body, targetProfileId: PROFILES.o3 })).rejects.toMatchObject({ status: 409, code: "request_id_conflict" });
    await expect(startOutboundCall(deps, actor, { requestId, to: "+421905123456" })).rejects.toMatchObject({ status: 409, code: "request_id_conflict" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([null, [], { requestId: undefined }, { requestId: "invalid" }, { targetProfileId: "invalid" }, { profileId: PROFILES.o3 }])("rejects malformed or spoofed input %j", async patch => {
    const { body, start, fetch } = fixture(); const input = patch && !Array.isArray(patch) ? { ...body, ...patch } : patch;
    await expect(start(input)).rejects.toMatchObject({ status: 400 }); expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a stale lease before target lookup and any provider operation", async () => {
    const { h, body, start, fetch } = fixture();
    await expect(start({ ...body, deviceSessionId: requestId })).rejects.toMatchObject({ code: "native_lease_stale" });
    expect(fetch).not.toHaveBeenCalled(); expect(h.db.log.some(row => row.table === "motorist_profiles")).toBe(false);
  });
  it.each([{ active: false }, { access_status: "invited" }, { kind: "ai" }, { role: "driver" }, { organization_id: PROFILES.o3 }])("requires a current eligible target even on replay: %j", async patch => {
    const { h, start, fetch } = fixture(); await start(); h.db.update("motorist_profiles", patch, row => row.id === PROFILES.o2);
    await expect(start()).rejects.toMatchObject({ status: 404 }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("revalidates colleague busy state rather than trusting a cached directory hint", async () => {
    const { h, start, fetch } = fixture(); h.setPresence(PROFILES.o2, { status: "on_call", current_session_id: requestId });
    await expect(start()).rejects.toMatchObject({ status: 409, code: "colleague_busy" }); expect(fetch).not.toHaveBeenCalled();
  });
});

describe("native call journal uncertainty", () => {
  it("retains an unknown original operation instead of issuing another provider request", async () => {
    const { h, start, fetch } = fixture();
    fetch.mockRejectedValue(new TypeError("transport outcome unknown"));
    await expect(start()).rejects.toBeDefined();
    const dispatched = fetch.mock.calls.length;
    expect(dispatched).toBeGreaterThan(0);
    await expect(start()).rejects.toMatchObject({ status: 503, code: "provider_outcome_unknown" });
    expect(fetch).toHaveBeenCalledTimes(dispatched); expect(h.rows("motorist_call_sessions")).toHaveLength(1);
  });
});


describe("internal command safe target label", () => {
  it("returns a sanitized profile label without adopting the shared core SIP destination", async () => {
    const { h, start } = fixture(); h.db.update("motorist_profiles", { display_name: "  Pe\nter  " }, row => row.id === PROFILES.o2);
    expect(await start()).toMatchObject({ to: "Peter", targetProfileId: PROFILES.o2 });
  });
});


describe("explicit cancellation of the original native command", () => {
  it("resolves and ends an owned original even after its target is deactivated", async () => {
    const { h, start, deps, body, fetch } = fixture();
    const original = await start(); // The client may lose this HTTP response.
    h.db.update("motorist_profiles", { active: false }, row => row.id === PROFILES.o2);
    await expect(start()).rejects.toMatchObject({ status: 404 });
    const session = await resolveNativeAttempt(deps, actor, { ...body, kind: "internal" });
    expect(session?.id).toBe(original.sessionId);
    await hangupCall(deps, actor, session!.id);
    expect(h.session(original.sessionId).ended_at).toBeTruthy();
    expect(fetch.mock.calls.length).toBeGreaterThan(1);
    expect(h.rows("motorist_call_sessions")).toHaveLength(1);
  });
  it("keeps an absent original unresolved, without a provider call or cancellation marker", async () => {
    const { h, deps, body, fetch } = fixture();
    expect(await resolveNativeAttempt(deps, actor, { ...body, kind: "internal" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled(); expect(h.rows("motorist_call_sessions")).toEqual([]);
    expect(h.db.log.every(query => query.operation === "select")).toBe(true);
  });
  it("matches external original text exactly, without target normalization or kind adoption", async () => {
    const { deps, body } = fixture();
    const to = "+421905123456";
    const started = await startOutboundCall(deps, actor, { requestId, to });
    const cancel = { deviceSessionId: lease, requestId, kind: "external", to };
    expect((await resolveNativeAttempt(deps, actor, cancel))?.id).toBe(started.sessionId);
    await expect(resolveNativeAttempt(deps, actor, { ...cancel, to: "+421905000000" })).rejects.toMatchObject({ status: 409, code: "request_id_conflict" });
    await expect(resolveNativeAttempt(deps, actor, { ...body, kind: "internal" })).rejects.toMatchObject({ status: 409, code: "request_id_conflict" });
  });
  it("does not cancel a different colleague under the original UUID", async () => {
    const { deps, body, start } = fixture(); await start();
    await expect(resolveNativeAttempt(deps, actor, { ...body, kind: "internal", targetProfileId: PROFILES.o3 })).rejects.toMatchObject({ status: 409, code: "request_id_conflict" });
  });
  it.each(["lease", "environment", "sip", "leg-profile", "no-leg"])("denies cleanup without current mobile authority: %s", async changed => {
    const { h, deps, body, start, fetch } = fixture(); const original = await start();
    if (changed === "lease") h.db.update("motorist_operator_mobile_devices", { device_session_id: requestId }, () => true);
    if (changed === "environment") h.db.update("motorist_call_sessions", { metadata: { ...h.session(original.sessionId).metadata as object, environment: "production" } }, () => true);
    if (changed === "sip") h.db.update("motorist_call_legs", { to_number: "sip:web@sip.telnyx.com" }, () => true);
    if (changed === "leg-profile") h.db.update("motorist_call_legs", { profile_id: PROFILES.o2 }, () => true);
    if (changed === "no-leg") h.db.delete("motorist_call_legs", () => true);
    await expect(resolveNativeAttempt(deps, actor, { ...body, kind: "internal" })).rejects.toMatchObject({ status: changed === "lease" ? 409 : 403 });
    expect(fetch).toHaveBeenCalledTimes(1); expect(h.session(original.sessionId).termination_requested_at).toBeFalsy();
  });
  it("allows an already-ended exact original only after the same own-leg proof", async () => {
    const { h, deps, body, start } = fixture(); const original = await start();
    h.db.update("motorist_call_sessions", { ended_at: h.now().toISOString(), state: "completed" }, () => true);
    h.db.update("motorist_call_legs", { ended_at: h.now().toISOString() }, () => true);
    expect(await resolveNativeAttempt(deps, actor, { ...body, kind: "internal" })).toMatchObject({ id: original.sessionId, ended_at: h.now().toISOString() });
    h.db.update("motorist_call_legs", { to_number: "sip:web@sip.telnyx.com" }, () => true);
    await expect(resolveNativeAttempt(deps, actor, { ...body, kind: "internal" })).rejects.toMatchObject({ status: 403 });
  });
  it("returns an actual durable pending hangup under lease contention", async () => {
    const { h, deps, body, start } = fixture(); const original = await start();
    const session = await resolveNativeAttempt(deps, actor, { ...body, kind: "internal" });
    h.db.registerRpc("motorist_session_lease_acquire_v2", () => null);
    expect(await hangupCall(deps, actor, session!.id)).toMatchObject({ terminationPending: true });
    expect(h.session(original.sessionId).termination_requested_at).toBeTruthy();
  });
  it.each([{ kind: "invalid" }, { to: "spoof" }, { requestId: "bad" }, { targetProfileId: undefined }, { profileId: PROFILES.o3 }])("rejects changed command shape %j", async patch => {
    const { deps, body, fetch } = fixture();
    await expect(resolveNativeAttempt(deps, actor, { ...body, kind: "internal", ...patch })).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
});


describe("original cancellation scope and cleanup lease", () => {
  it.each(["organization", "actor"])("does not adopt an otherwise identical %s attempt", async changed => {
    const { h, deps, body, start, fetch } = fixture(); const original = await start();
    const row = h.session(original.sessionId);
    if (changed === "organization") h.db.update("motorist_call_sessions", { organization_id: PROFILES.o3 }, () => true);
    else {
      const metadata = row.metadata as { initial_operation: object };
      h.db.update("motorist_call_sessions", { metadata: { ...metadata, initial_operation: { ...metadata.initial_operation, actorId: PROFILES.o3 } } }, () => true);
    }
    expect(await resolveNativeAttempt(deps, actor, { ...body, kind: "internal" })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retains cleanup through exact revoked lease proof but denies another revoked identity", async () => {
    const { h, deps, body, start } = fixture(); const original = await start();
    h.db.update("motorist_operator_mobile_devices", { device_session_id: "revoked:" + lease, registration_state: "unregistered", metadata: { native_revocation_session_id: lease } }, () => true);
    expect(await resolveNativeAttempt(deps, actor, { ...body, kind: "internal" })).toMatchObject({ id: original.sessionId });
    await expect(resolveNativeAttempt(deps, actor, { ...body, kind: "internal", deviceSessionId: requestId })).rejects.toMatchObject({ code: "native_lease_stale" });
  });
});
