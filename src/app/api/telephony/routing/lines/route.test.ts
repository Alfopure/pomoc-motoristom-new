import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  configure: vi.fn(),
  gateStatus: vi.fn(),
  requireActor: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/api-auth", () => ({
  assertSameOriginRequest: mocks.assertSameOrigin,
  requireDefaultMotoristActor: mocks.requireActor,
}));
vi.mock("@/server/telephony/viptel-line-catalog-config", () => ({
  configureViptelLineCatalog: mocks.configure,
}));
vi.mock("@/server/telephony/live-mutation-gate", () => ({
  telephonyLiveMutationGateStatus: mocks.gateStatus,
}));

import { POST } from "./route";

const actor = { organizationId: "org-1", profileId: "profile-1", role: "manager" };

describe("VIPTel line catalog route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActor.mockResolvedValue(actor);
    mocks.configure.mockResolvedValue({ applied: false, plan: [] });
    mocks.gateStatus.mockReturnValue({ enabled: false, reason: "flag_disabled" });
  });

  it.each([
    { label: "an empty body", body: "" },
    { label: "malformed JSON", body: "{broken" },
    { label: "an array", body: "[]" },
    { label: "a scalar", body: JSON.stringify(false) },
  ])("rejects $label after origin/auth and before catalog access", async ({ body }) => {
    const request = rawRequest(body);
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.assertSameOrigin).toHaveBeenCalledWith(request);
    expect(mocks.requireActor).toHaveBeenCalledWith(["manager", "admin"]);
    expect(mocks.configure).not.toHaveBeenCalled();
  });

  it("defaults a valid object to dry-run and requires literal false for apply", async () => {
    await POST(jsonRequest({}));
    expect(mocks.configure).toHaveBeenLastCalledWith(actor, true);

    await POST(jsonRequest({ dryRun: "false" }));
    expect(mocks.configure).toHaveBeenLastCalledWith(actor, true);

    await POST(jsonRequest({ dryRun: false }));
    expect(mocks.configure).toHaveBeenLastCalledWith(actor, false);
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return rawRequest(JSON.stringify(body));
}

function rawRequest(body: string) {
  return new Request("https://app.test/api/telephony/routing/lines", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test" },
    body,
  });
}
