import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/server/api-auth", () => ({ assertSameOriginRequest: vi.fn(), requireDefaultMotoristActor: vi.fn() }));
vi.mock("@/server/case-draft-preview", () => ({ caseDraftPreviewBody: vi.fn(), loadCaseDraftPreview: vi.fn(), publishCaseDraftPreview: vi.fn() }));
vi.mock("@/data/dispatch-repository", () => ({ loadDispatchNotifications: vi.fn(), mapCase: vi.fn() }));
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { caseDraftPreviewBody, loadCaseDraftPreview, publishCaseDraftPreview } from "@/server/case-draft-preview";
import { MutationError } from "@/server/mutation-error";
import { GET, PUT } from "./route";

const actor = { profileId: "actor", organizationId: "organization", role: "dispatcher", userId: "user", displayName: "Actor" } as const;
const context = { params: Promise.resolve({ sessionId: "00000000-0000-4000-8000-000000000001" }) };
const snapshot = { available: true, preview: null, sequence: 0, updatedAt: null, expiresAt: "2026-09-21T11:01:00Z", displayName: "Author" };
afterEach(() => { vi.resetAllMocks(); });

describe("draft preview routes", () => {
  it("reads only the requested authorized draft with no-store headers", async () => {
    vi.mocked(requireDefaultMotoristActor).mockResolvedValue(actor);
    vi.mocked(loadCaseDraftPreview).mockResolvedValue(snapshot);
    const request = new Request("https://example.test/api/cases/drafts/session");
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot);
    expect(requireDefaultMotoristActor).toHaveBeenCalledExactlyOnceWith(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    expect(loadCaseDraftPreview).toHaveBeenCalledExactlyOnceWith(actor, (await context.params).sessionId, request.signal);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });

  it("checks same origin before authentication or publishing", async () => {
    vi.mocked(assertSameOriginRequest).mockImplementation(() => { throw new MutationError("Foreign origin", 403); });
    const response = await PUT(new Request("https://example.test", { method: "PUT" }), context);
    expect(response.status).toBe(403);
    expect(requireDefaultMotoristActor).not.toHaveBeenCalled();
    expect(caseDraftPreviewBody).not.toHaveBeenCalled();
    expect(publishCaseDraftPreview).not.toHaveBeenCalled();
  });

  it("publishes the parsed body under server-derived identity", async () => {
    const input = { sequence: 1, preview: { version: 1, fields: { note: "In progress" } } };
    vi.mocked(requireDefaultMotoristActor).mockResolvedValue(actor);
    vi.mocked(caseDraftPreviewBody).mockResolvedValue(input);
    vi.mocked(publishCaseDraftPreview).mockResolvedValue(snapshot);
    const request = new Request("https://example.test", { method: "PUT", body: JSON.stringify(input) });
    const response = await PUT(request, context);
    expect(response.status).toBe(200);
    expect(publishCaseDraftPreview).toHaveBeenCalledExactlyOnceWith(actor, (await context.params).sessionId, input, request.signal);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it.each([401, 403])("prevents unauthenticated or unauthorized reads (%s)", async status => {
    vi.mocked(requireDefaultMotoristActor).mockRejectedValue(new MutationError("Denied", status));
    expect((await GET(new Request("https://example.test"), context)).status).toBe(status);
    expect(loadCaseDraftPreview).not.toHaveBeenCalled();
  });

  it("preserves closed-session 404 with private headers", async () => {
    vi.mocked(requireDefaultMotoristActor).mockResolvedValue(actor);
    vi.mocked(loadCaseDraftPreview).mockRejectedValue(new MutationError("Closed", 404));
    const response = await GET(new Request("https://example.test"), context);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
