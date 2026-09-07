import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), actor: vi.fn(), send: vi.fn(), sendCase: vi.fn() }));
vi.mock("@/server/api-auth", () => ({ motoristAccessGuard: mocks.guard, requireDefaultMotoristActor: mocks.actor }));
vi.mock("@/server/sms-workflow", async (original) => ({ ...await original<typeof import("./sms-workflow")>(), sendCustomSms: mocks.send, sendCaseSms: mocks.sendCase }));
import { POST as globalPost } from "@/app/api/sms/send/route";
import { POST as casePost } from "@/app/api/cases/[id]/sms/route";
import { SMS_ROLES } from "./sms-workflow";
beforeEach(() => { vi.clearAllMocks(); mocks.guard.mockResolvedValue(null); mocks.actor.mockResolvedValue({ profileId: "authenticated", organizationId: "org" }); mocks.send.mockResolvedValue({ status: "sent" }); mocks.sendCase.mockResolvedValue({ status: "sent" }); });
function request(body: unknown) { return new Request("https://sms.test/api/sms/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
describe("SMS route authorization", () => {
  it("uses identical roles and denies both routes before workflow access", async () => {
    mocks.guard.mockImplementation(async () => Response.json({ error: "forbidden" }, { status: 403 }));
    expect((await globalPost(request({}))).status).toBe(403);
    expect((await casePost(request({}), { params: Promise.resolve({ id: "case" }) })).status).toBe(403);
    for (const [options] of mocks.guard.mock.calls) expect(options.roles).toEqual(SMS_ROLES);
    expect(mocks.actor).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.sendCase).not.toHaveBeenCalled();
  });
  it("takes organization and author from the session and requires a preview", async () => {
    expect((await globalPost(request({ template: "unknown" }))).status).toBe(400);
    await globalPost(request({ draft: { caseId: null }, proof: "proof", message: "Body", actorProfileId: "forged", organizationId: "foreign" }));
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ actorProfileId: "authenticated", organizationId: "org", message: "Body" }));
  });
});
