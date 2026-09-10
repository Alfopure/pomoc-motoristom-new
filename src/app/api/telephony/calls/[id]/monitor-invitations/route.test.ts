import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), csrf: vi.fn(), invite: vi.fn(), accept: vi.fn(), revoke: vi.fn() }));
vi.mock("@/server/api-auth", () => ({ requireDefaultMotoristActor: mocks.auth, assertSameOriginRequest: mocks.csrf }));
vi.mock("@/server/telephony/call-actions", async importOriginal => ({ ...await importOriginal<typeof import("@/server/telephony/call-actions")>(), inviteCallMonitor: mocks.invite, superviseCall: mocks.accept, revokeCallMonitorInvitation: mocks.revoke }));
vi.mock("@/server/telephony/runtime", async importOriginal => ({ ...await importOriginal<typeof import("@/server/telephony/runtime")>(), createTelephonyDeps: vi.fn(async () => ({ organizationId: "org" })), telephonyConfiguredOrResponse: () => null }));
import { POST } from "./route";
const actor = { profileId: "20000000-0000-4000-8000-000000000001", organizationId: "org", role: "dispatcher", displayName: "Trainee" };
const invitationId = "50000000-0000-4000-8000-000000000001";
function request(body: Record<string, unknown>) { return POST(new Request("https://dispatch.test/api/telephony/calls/call/monitor-invitations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: "call" }) }); }
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue(actor); mocks.accept.mockResolvedValue({ operatorLegCallControlId: "exact-own-leg" }); });
describe("monitor invitation route", () => {
  it("binds accept to authenticated recipient and returns exact local leg for existing webphone handshake", async () => {
    const response = await request({ action: "accept", invitationId, actorProfileId: "forged", mode: "monitor" });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ operatorLegCallControlId: "exact-own-leg" });
    expect(mocks.accept).toHaveBeenCalledWith({ organizationId: "org" }, { profileId: actor.profileId, role: "dispatcher", displayName: "Trainee" }, "call", "monitor", invitationId);
    expect(mocks.csrf).toHaveBeenCalledBefore(mocks.auth);
  });
  it.each(["whisper", "barge", "none"])("rejects requested %s escalation before service", async mode => {
    expect((await request({ action: "accept", invitationId, mode })).status).toBe(403); expect(mocks.accept).not.toHaveBeenCalled();
  });
  it("forwards only selected invitation on revoke and rejects invalid ids", async () => {
    expect((await request({ action: "revoke", invitationId })).status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ profileId: actor.profileId }), "call", invitationId);
    expect((await request({ action: "accept", invitationId: "no" })).status).toBe(400);
  });
});
