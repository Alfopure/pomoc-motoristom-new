import { beforeEach, describe, expect, it, vi } from "vitest";
import { MutationError } from "@/server/mutation-error";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), deployment: vi.fn(), admin: vi.fn(), status: vi.fn() }));
vi.mock("@/server/api-auth", () => ({ requireDefaultMotoristActor: mocks.actor }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/server/telephony/runtime", async original => ({ ...await original<typeof import("@/server/telephony/runtime")>(), assertTelephonyDeployment: mocks.deployment, telephonyEnvironment: () => "development" }));
vi.mock("@/server/telephony/webphone-offer-status", async original => ({ ...await original<typeof import("@/server/telephony/webphone-offer-status")>(), getWebphoneOfferStatus: mocks.status }));
import { GET } from "./route";
const lease = "00000000-0000-4000-8000-000000000071";
const request = (query = `deviceSessionId=${lease}&callControlId=exact`) => new Request(`https://test.dispecing.linkapomoci.sk/api/telephony/webphone/offer-status?${query}`);
beforeEach(() => {
  vi.resetAllMocks(); mocks.actor.mockResolvedValue({ organizationId: "own-org", profileId: "own-profile", role: "dispatcher" });
  mocks.admin.mockReturnValue({ marker: "readonly-admin" });
  mocks.status.mockResolvedValue({ callControlId: "exact", sessionId: null, status: "pending" });
});
describe("GET exact browser offer", () => {
  it("binds actor/environment without constructing provider dependencies", async () => {
    const response = await GET(request()); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ callControlId: "exact", sessionId: null, status: "pending" });
    expect(mocks.status).toHaveBeenCalledWith({ admin: { marker: "readonly-admin" }, organizationId: "own-org", environment: "development" }, "own-profile", { deviceSessionId: lease, callControlId: "exact" });
    expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("vary")).toBe("Cookie");
  });
  it.each([401, 403])("auth %s precedes malformed input and all application reads", async status => {
    mocks.actor.mockRejectedValue(new MutationError("Denied", status));
    const response = await GET(request("profileId=spoof")); expect(response.status).toBe(status);
    expect(mocks.admin).not.toHaveBeenCalled(); expect(mocks.status).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("rejects duplicate and spoofed fields before admin construction", async () => {
    const response = await GET(request(`deviceSessionId=${lease}&callControlId=a&callControlId=b`));
    expect(response.status).toBe(400); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("rejects a forbidden deployment before application reads", async () => {
    mocks.deployment.mockImplementation(() => { throw new MutationError("Unavailable", 503); });
    const response = await GET(request()); expect(response.status).toBe(503); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("retains transient error without returning a terminal status", async () => {
    mocks.status.mockRejectedValue(new MutationError("Unavailable", 503));
    const response = await GET(request()); expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("status"); expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
