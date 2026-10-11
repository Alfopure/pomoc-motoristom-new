import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as token } from "@/app/api/mobile/v1/voice/token/route";
import { POST as heartbeat } from "@/app/api/mobile/v1/voice/heartbeat/route";
import { POST as offers } from "@/app/api/mobile/v1/voice/offers/route";
import { POST as calls } from "@/app/api/mobile/v1/voice/calls/route";
import { POST as disconnect } from "@/app/api/mobile/v1/voice/disconnect/route";
import { POST as presence } from "@/app/api/mobile/v1/voice/presence/route";
import { POST as end } from "@/app/api/mobile/v1/voice/calls/[id]/end/route";
import { POST as status } from "@/app/api/mobile/v1/voice/calls/[id]/status/route";
import { MutationError } from "@/server/mutation-error";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), deps: vi.fn(), lease: vi.fn(), session: vi.fn(), token: vi.fn(), touch: vi.fn(),
  dial: vi.fn(), disconnect: vi.fn(), hangup: vi.fn(), continue: vi.fn(), after: vi.fn() }));
vi.mock("./auth", () => ({ requireMobileActor: mocks.actor, mobileEnvironment: () => "test" }));
vi.mock("./voice", () => ({ nativeVoiceDeps: mocks.deps, requireNativeLease: mocks.lease, requireNativeSession: mocks.session,
  NativeLeaseError: class extends Error { status = 409; code = "native_lease_stale"; } }));
vi.mock("@/server/telephony/operator-devices", () => ({ issueWebphoneToken: mocks.token, touchDevice: mocks.touch, disconnectDevice: mocks.disconnect }));
vi.mock("@/server/telephony/call-actions", () => ({ startOutboundCall: mocks.dial, hangupCall: mocks.hangup, continueAcceptedHangup: mocks.continue }));
vi.mock("next/server", () => ({ after: mocks.after }));
const actor = { userId: "user", profileId: "operator", organizationId: "organization", displayName: "Operátor", role: "dispatcher" };
const id = "00000000-0000-4000-8000-000000000071";
const context = { params: Promise.resolve({ id }) };
const request = (body: object = {}) => new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks(); mocks.actor.mockResolvedValue(actor); mocks.deps.mockResolvedValue({ deviceKind: "mobile" });
  mocks.lease.mockResolvedValue({ device_session_id: id, registration_state: "registered" });
  mocks.session.mockResolvedValue({ id, answered_by_profile_id: actor.profileId, direction: "outbound", state: "talking", answered_at: "2026-10-11T12:00:00Z", ended_at: null, nativeConnected: true, nativeEnded: false });
});
describe("mobile voice HTTP contract", () => {
  const routes = [token, heartbeat, offers, calls, disconnect, presence, (r: Request) => end(r, context), (r: Request) => status(r, context)];
  it.each(routes)("authenticates before configuration, provider operations or request parsing", async route => {
    mocks.actor.mockRejectedValue(new MutationError("denied", 401)); const response = await route(request());
    expect(response.status).toBe(401); expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store"); expect(mocks.deps).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled(); expect(mocks.dial).not.toHaveBeenCalled(); expect(mocks.disconnect).not.toHaveBeenCalled();
  });
  it("returns a short-lived JWT and lease without SIP passwords or credential IDs", async () => {
    mocks.token.mockResolvedValue({ token: "jwt", deviceSessionId: id, expiresAt: "2026-10-12T12:00:00Z", sipUsername: "private-sip", credentialId: "private-provider" });
    const response = await token(request({ deviceSessionId: id, profileId: "foreign", organizationId: "foreign" }));
    expect(await response.json()).toEqual(expect.objectContaining({ token: "jwt", deviceSessionId: id, profileId: actor.profileId, environment: "test" }));
    expect(mocks.token).toHaveBeenCalledWith(expect.objectContaining({ deviceKind: "mobile" }), expect.objectContaining({ profileId: actor.profileId, organizationId: actor.organizationId, takeover: false }));
  });
  it("requires an outbound operation UUID before dialing", async () => {
    expect((await calls(request({ deviceSessionId: id, to: "+421900000001" }))).status).toBe(400); expect(mocks.dial).not.toHaveBeenCalled();
  });
  it("delegates dialing rules to the existing server phone service", async () => {
    mocks.dial.mockResolvedValue({ sessionId: id, operatorLegCallControlId: "exact-leg", to: "+421900000001", from: "private-line" });
    const response = await calls(request({ deviceSessionId: id, requestId: id, to: "+421900000001", from: "untrusted", profileId: "foreign" }));
    expect(response.status).toBe(200); expect(mocks.dial).toHaveBeenCalledWith(expect.objectContaining({ deviceKind: "mobile" }),
      { profileId: actor.profileId, displayName: actor.displayName, role: actor.role }, { requestId: id, to: "+421900000001" });
    expect(JSON.stringify(await response.json())).not.toContain("private-line");
  });
  it("returns 202 for a durable pending hangup and retains its bounded continuation", async () => {
    mocks.hangup.mockResolvedValue({ sessionId: id, terminationPending: true }); const response = await end(request({ deviceSessionId: id }), context);
    expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ sessionId: id, terminationPending: true }); expect(mocks.after).toHaveBeenCalledOnce();
  });
  it("acknowledges an already-ended owned native session without another provider hangup", async () => {
    mocks.session.mockResolvedValue({ id, ended_at: "2026-10-11T12:01:00Z" });
    const response = await end(request({ deviceSessionId: id }), context);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ terminationPending: false });
    expect(mocks.hangup).not.toHaveBeenCalled();
  });
  it("does not display another operator's winning call as connected", async () => {
    mocks.session.mockResolvedValue({ id, answered_by_profile_id: "another", direction: "inbound", state: "talking", answered_at: "now", ended_at: null, nativeConnected: false, nativeEnded: true });
    expect(await (await status(request({ deviceSessionId: id }), context)).json()).toMatchObject({ connected: false });
  });
  it("reports a losing mobile offer ended even when this operator answered on web", async () => {
    mocks.session.mockResolvedValue({ id, answered_by_profile_id: actor.profileId, direction: "inbound", state: "talking", answered_at: "now", ended_at: null, nativeConnected: false, nativeEnded: true });
    expect(await (await status(request({ deviceSessionId: id }), context)).json()).toMatchObject({ connected: false, ended: true });
  });
  it("reports the verified mobile participant connected", async () => {
    expect(await (await status(request({ deviceSessionId: id }), context)).json()).toMatchObject({ connected: true, ended: false });
  });
  it("permits heartbeat recovery only through the current lease check", async () => {
    mocks.touch.mockResolvedValue({ ok: true, device: { registration_state: "registered" } });
    expect((await heartbeat(request({ deviceSessionId: id, registrationState: "registered" }))).status).toBe(200);
    expect(mocks.lease).toHaveBeenCalledWith(expect.anything(), actor, id, { heartbeat: true });
  });
  it("uses cleanup permission and the exact current lease when disconnecting", async () => {
    expect((await disconnect(request({ deviceSessionId: id }))).status).toBe(200);
    expect(mocks.deps).toHaveBeenCalledWith(actor, { cleanup: true });
    expect(mocks.disconnect).toHaveBeenCalledWith(expect.objectContaining({ deviceKind: "mobile" }), { organizationId: actor.organizationId, profileId: actor.profileId, deviceSessionId: id });
  });
  it("sanitizes provider errors while preserving status", async () => {
    mocks.token.mockRejectedValue(new MutationError("private-provider-secret", 502)); const response = await token(request());
    expect(response.status).toBe(502); expect(JSON.stringify(await response.json())).not.toContain("private-provider-secret");
  });
});
