import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { PATCH } from "./[id]/route";
import { PATCH as READ } from "./[id]/read/route";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), status: vi.fn(), read: vi.fn(), snooze: vi.fn(),
  actor: vi.fn(async () => ({ profileId: "20000000-0000-0000-0000-000000000002", organizationId: "10000000-0000-0000-0000-000000000001", role: "admin" })),
}));
vi.mock("@/data/dispatch-repository", () => ({ loadDispatchNotifications: mocks.list }));
vi.mock("@/server/api-auth", () => ({ assertSameOriginRequest: vi.fn(), requireDefaultMotoristActor: mocks.actor }));
vi.mock("@/server/motorist-mutations", () => ({
  MutationError: class extends Error { constructor(message: string, readonly status = 400) { super(message); } },
  updateNotificationStatus: mocks.status, markNotificationRead: mocks.read, snoozeNotification: mocks.snooze,
}));
const params = { params: Promise.resolve({ id: "notice-a" }) };
const actor = { id: "20000000-0000-0000-0000-000000000002", organization_id: "10000000-0000-0000-0000-000000000001" };
function request(body: unknown) { return new Request("https://dispatch-copy.example/api/notifications/notice-a", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue([]); });
describe("notification routes carry the session actor", () => {
  it("lists the actual actor's scope, even for an administrator", async () => {
    expect((await GET()).status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(actor.organization_id, actor.id);
  });
  it.each(["read", "archived", "unread"])("keeps %s mutation and returned snapshot scoped to the same actor", async (status) => {
    expect((await PATCH(request({ status, recipientProfileId: "forged" }), params)).status).toBe(200);
    expect(mocks.status).toHaveBeenCalledWith("notice-a", status, actor);
    expect(mocks.list).toHaveBeenCalledWith(actor.organization_id, actor.id);
  });
  it("preserves actor scope for the legacy read endpoint", async () => {
    expect((await READ(request({}), params)).status).toBe(200);
    expect(mocks.read).toHaveBeenCalledWith("notice-a", actor);
  });
  it("passes authenticated identity rather than a claimed snooze recipient", async () => {
    expect((await PATCH(request({ snoozedUntil: "2099-01-01", profileId: "forged" }), params)).status).toBe(200);
    expect(mocks.snooze).toHaveBeenCalledWith("notice-a", "2099-01-01", actor);
  });
});
