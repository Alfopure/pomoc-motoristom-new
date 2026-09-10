import { beforeEach, expect, it, vi } from "vitest";
import { MutationError } from "@/server/mutation-error";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), origin: vi.fn(), read: vi.fn(), save: vi.fn(), resolve: vi.fn() }));
vi.mock("@/server/api-auth", () => ({ requireDefaultMotoristActor: mocks.actor, assertSameOriginRequest: mocks.origin }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => "admin-client" }));
vi.mock("@/server/callback-targets", () => ({ readCallbackPolicy: mocks.read, saveCallbackPolicy: mocks.save, resolveCallbackTarget: mocks.resolve }));
vi.mock("@/data/dispatch-repository", () => ({ loadDispatchData: vi.fn() }));
import { GET, PUT } from "./route";
import { GET as resolve } from "@/app/api/telephony/callback-target/route";
const actor = { profileId: "authenticated-actor", organizationId: "authenticated-org", role: "manager" };
const context = { params: Promise.resolve({ id: "source-id" }) };
beforeEach(() => { Object.values(mocks).forEach(mock => mock.mockReset()); mocks.actor.mockResolvedValue(actor); mocks.read.mockResolvedValue({ revision: 2 }); mocks.save.mockResolvedValue({ revision: 3 }); mocks.resolve.mockResolvedValue({ status: "original", originalNumber: "02/32 408 700" }); });
it("uses authenticated actor and private no-store for policy reads and resolver", async () => {
  const result = await GET(new Request("https://app.test"), context);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.read).toHaveBeenCalledWith("admin-client", actor, "source-id");
  const response = await resolve(new Request("https://app.test/api/telephony/callback-target?number=02%2F32%20408%20700&organizationId=forged"));
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.resolve).toHaveBeenCalledWith("admin-client", actor.organizationId, "02/32 408 700");
});
it("rejects origin before authentication or write", async () => {
  mocks.origin.mockImplementation(() => { throw new MutationError("Denied", 403); });
  const result = await PUT(new Request("https://app.test", { method: "PUT", body: "{}" }), context);
  expect(result.status).toBe(403); expect(mocks.actor).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
});
it("requires manager/admin and forwards explicit verification plus CAS revision", async () => {
  const body = { nonCallback: true, targetContactId: "target-id", verified: true, expectedRevision: 2 };
  const result = await PUT(new Request("https://app.test", { method: "PUT", body: JSON.stringify(body) }), context);
  expect(result.status).toBe(200); expect(mocks.actor).toHaveBeenCalledWith(["manager", "admin"]);
  expect(mocks.save).toHaveBeenCalledWith("admin-client", actor, "source-id", body);
});
it("does not access directory when session is revoked", async () => {
  mocks.actor.mockRejectedValue(new MutationError("Session revoked", 401));
  expect((await GET(new Request("https://app.test"), context)).status).toBe(401);
  expect((await resolve(new Request("https://app.test/api/telephony/callback-target?number=0900123456"))).status).toBe(401);
  expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
});
