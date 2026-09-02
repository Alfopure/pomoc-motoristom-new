import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOriginRequest: vi.fn(),
  bootstrap: vi.fn(),
  bootstrapEmpty: vi.fn(),
  getOverview: vi.fn(),
  previewOrStart: vi.fn(),
  recover: vi.fn(),
  requireActor: vi.fn(),
}));

vi.mock("@/server/api-auth", () => ({
  assertSameOriginRequest: mocks.assertSameOriginRequest,
  requireDefaultMotoristActor: mocks.requireActor,
}));
vi.mock("@/server/telephony/dispatch-routing", () => ({
  bootstrapDispatchQueueCatalog: mocks.bootstrap,
  getStoredDispatchRoutingOverview: mocks.getOverview,
  previewOrStartEmptyDispatchRoutingPlan: mocks.bootstrapEmpty,
  previewOrStartDispatchRoutingPlan: mocks.previewOrStart,
  recoverDispatchRoutingOperation: mocks.recover,
}));

import { MutationError } from "@/server/motorist-mutations";
import { GET, POST } from "./route";

const actor = {
  userId: "user-1",
  profileId: "profile-1",
  organizationId: "organization-1",
  displayName: "Manager",
  role: "manager",
};

describe("manager priority routing API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActor.mockResolvedValue(actor);
    mocks.getOverview.mockResolvedValue({ revision: 2 });
    mocks.bootstrap.mockResolvedValue({ ready: false, queues: [] });
    mocks.bootstrapEmpty.mockResolvedValue({ dryRun: true, preview: { targetRevision: 3 } });
    mocks.previewOrStart.mockResolvedValue({ dryRun: true, preview: { targetRevision: 3 } });
    mocks.recover.mockResolvedValue({ revision: 2, operation: null });
  });

  it("returns a manager-only stored overview without caching", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireActor).toHaveBeenCalledWith(["manager", "admin"]);
    await expect(response.json()).resolves.toMatchObject({ ok: true, routing: { revision: 2 } });
  });

  it("keeps bootstrap read-only unless dryRun is explicitly false", async () => {
    const response = await POST(request({ action: "bootstrap" }));
    expect(response.status).toBe(200);
    expect(mocks.bootstrap).toHaveBeenCalledWith(actor, true);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("passes exact slots, revision and fallback to apply and uses 202 only for explicit live apply", async () => {
    mocks.previewOrStart.mockResolvedValueOnce({ dryRun: false, preview: {}, routing: { revision: 2 } });
    const body = {
      action: "apply",
      dryRun: false,
      baseRevision: 2,
      slots: [
        { queue: "601", extension: "20" },
        { queue: "602", extension: "21" },
        { queue: "603", extension: "22" },
      ],
      fallback: { queue: "603", extension: "23" },
      previewDigest: "approved-preview-digest",
    };
    const response = await POST(request(body));
    expect(response.status).toBe(202);
    expect(mocks.previewOrStart).toHaveBeenCalledWith(actor, {
      baseRevision: 2,
      slots: body.slots,
      fallback: body.fallback,
      previewDigest: body.previewDigest,
      dryRun: false,
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("exposes an explicit empty-queue bootstrap without accepting a client fallback", async () => {
    const slots = [
      { queue: "601", extension: "20" },
      { queue: "602", extension: "21" },
      { queue: "603", extension: "22" },
    ];
    mocks.bootstrapEmpty.mockResolvedValueOnce({ dryRun: false, preview: {}, routing: { revision: 1 } });

    const response = await POST(request({
      action: "bootstrap-empty",
      baseRevision: 0,
      dryRun: false,
      fallback: { queue: "601", extension: "99" },
      previewDigest: "approved-bootstrap-digest",
      slots,
    }));

    expect(response.status).toBe(202);
    expect(mocks.bootstrapEmpty).toHaveBeenCalledWith(actor, {
      baseRevision: 0,
      slots,
      previewDigest: "approved-bootstrap-digest",
      dryRun: false,
    });
    expect(mocks.previewOrStart).not.toHaveBeenCalled();
  });

  it("returns routing after resume/rollback/reconcile", async () => {
    for (const action of ["resume", "rollback", "reconcile"] as const) {
      const response = await POST(request({ action }));
      expect(response.status).toBe(action === "reconcile" ? 200 : 202);
      await expect(response.json()).resolves.toMatchObject({ ok: true, action, routing: { revision: 2 } });
    }
  });

  it("maps stale/blocked service errors to 409 without caching", async () => {
    mocks.previewOrStart.mockRejectedValueOnce(new MutationError("stale", 409));
    const response = await POST(request({ action: "apply", baseRevision: 1, slots: [], fallback: {} }));
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ ok: false, error: "stale" });
  });

  it.each([
    { label: "an empty body", body: "" },
    { label: "malformed JSON", body: "{broken" },
    { label: "an array", body: "[]" },
    { label: "a scalar", body: JSON.stringify("apply") },
    { label: "a Unicode action", body: JSON.stringify({ action: "použiť" }) },
    { label: "an oversized action", body: JSON.stringify({ action: "a".repeat(4096) }) },
  ])("rejects $label before calling any routing operation", async ({ body }) => {
    const response = await POST(rawRequest(body));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.bootstrapEmpty).not.toHaveBeenCalled();
    expect(mocks.previewOrStart).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it("treats non-literal dryRun values as read-only", async () => {
    const slots = [
      { queue: "601", extension: "20" },
      { queue: "602", extension: "21" },
      { queue: "603", extension: "22" },
    ];

    const response = await POST(request({
      action: "apply",
      baseRevision: 2,
      dryRun: "false",
      fallback: { queue: "603", extension: "23" },
      previewDigest: "client-value-is-ignored-for-dry-run",
      slots,
    }));

    expect(response.status).toBe(200);
    expect(mocks.previewOrStart).toHaveBeenCalledWith(actor, expect.objectContaining({ dryRun: true }));
  });
});

function request(body: unknown) {
  return rawRequest(JSON.stringify(body));
}

function rawRequest(body: string) {
  return new Request("https://app.test/api/telephony/routing/priority", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.test",
    },
    body,
  });
}
