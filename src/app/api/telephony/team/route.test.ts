import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), load: vi.fn() }));
vi.mock("@/server/api-auth", () => ({ requireDefaultMotoristActor: mocks.auth }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => "admin" }));
vi.mock("@/server/telephony/team", () => ({ loadTelephonyTeam: mocks.load }));
import { MutationError } from "@/server/mutation-error";
import { GET } from "./route";
describe("operational team authorization", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ organizationId: "org", profileId: "actor", role: "dispatcher" }); mocks.load.mockResolvedValue({ operators: [], checkedAt: "now" }); });
  it("permits dispatcher without opening manager report endpoint", async () => {
    const response = await GET(); expect(response.status).toBe(200);
    expect(mocks.auth).toHaveBeenCalledWith(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    expect(mocks.load).toHaveBeenCalledWith({ admin: "admin", organizationId: "org" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each([401,403])("does not read team on denied access %s", async status => {
    mocks.auth.mockRejectedValue(new MutationError("Denied",status));
    expect((await GET()).status).toBe(status); expect(mocks.load).not.toHaveBeenCalled();
  });
});
