import { beforeEach, describe, expect, it, vi } from "vitest";
import { MutationError } from "@/server/mutation-error";

const mocks = vi.hoisted(() => ({ user: vi.fn(), list: vi.fn() }));
vi.mock("./user", () => ({ requireMobileUser: mocks.user }));
vi.mock("./tasks", async importOriginal => ({
  ...await importOriginal<object>(), listMobileMyTasks: mocks.list,
}));
import { GET } from "@/app/api/mobile/v1/tasks/route";

const actor = { organizationId: "org", profileId: "actor", userId: "user", role: "dispatcher", displayName: "Dispečer" };
const client = { fixture: "verified-user-RLS-client" };
const selection = { view: "assigned", category: "open", q: "" };
function request(query = "") {
  return new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/tasks?" + query);
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("MOTORIST_APP_ENV", "test");
  mocks.user.mockResolvedValue({ actor, client });
  mocks.list.mockResolvedValue({ tasks: [], nextCursor: null, capabilities: { create: false, workflow: false, messages: false }, selection });
});

describe("My tasks HTTP boundary", () => {
  it.each([401, 403, 409])("authenticates before parsing or task access on denied status %i", async status => {
    mocks.user.mockRejectedValue(new MutationError("Prístup nie je dostupný.", status));
    const result = await GET(request("userId=spoof&cursor=bad"));
    expect(result.status).toBe(status);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(result.headers.get("Vary")).toBe("Authorization, X-PM-App-Environment");
    expect(result.headers.get("WWW-Authenticate")).toBe(status === 401 ? "Bearer" : null);
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("passes exact verified actor/user client and returns the private versioned selection", async () => {
    const result = await GET(request());
    expect(result.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(actor, { ...selection, limit: 25, cursor: null }, client);
    expect(await result.json()).toEqual({ ok: true, apiVersion: 1, environment: "test", profileId: actor.profileId,
      checkedAt: expect.any(String), tasks: [], nextCursor: null,
      capabilities: { create: false, workflow: false, messages: false }, selection });
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(result.headers.get("Vary")).toContain("Authorization");
  });
  it("accepts review/all/search only after auth and passes normalized filters", async () => {
    await GET(request("view=review&category=all&q=%20Doklady%20&limit=3"));
    expect(mocks.list).toHaveBeenCalledWith(actor, { view: "review", category: "all", q: "Doklady", limit: 3, cursor: null }, client);
  });
  it.each(["userId=spoof", "organizationId=spoof", "view=all", "category=closed", "limit=100", "q=a&q=b"])("returns authenticated bad input without task reads for %s", async query => {
    const result = await GET(request(query));
    expect(result.status).toBe(400); expect(mocks.user).toHaveBeenCalledOnce(); expect(mocks.list).not.toHaveBeenCalled();
  });
  it("sanitizes unexpected user database failures", async () => {
    mocks.list.mockRejectedValue(new Error("PRIVATE_TASK_PAYLOAD"));
    const result = await GET(request());
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ ok: false, error: "Vaše úlohy sa nepodarilo načítať." });
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
