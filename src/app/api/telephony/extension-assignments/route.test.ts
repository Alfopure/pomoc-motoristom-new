import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  gate: vi.fn(),
  listAssignments: vi.fn(),
  requireActor: vi.fn(),
  setAssignment: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/api-auth", () => ({
  assertSameOriginRequest: mocks.assertSameOrigin,
  requireDefaultMotoristActor: mocks.requireActor,
}));
vi.mock("@/server/telephony-extensions", () => ({
  listTelephonyExtensionAssignments: mocks.listAssignments,
  setTelephonyExtensionAssignment: mocks.setAssignment,
}));
vi.mock("@/server/telephony/live-mutation-gate", () => ({
  assertTelephonyLiveMutationEnabled: mocks.gate,
}));

import { MutationError } from "@/server/motorist-mutations";
import { GET, PATCH } from "./route";

const actor = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  profileId: "00000000-0000-4000-8000-000000000002",
  role: "manager",
};
const extensionId = "00000000-0000-4000-8000-000000000003";
const profileId = "00000000-0000-4000-8000-000000000004";

describe("extension assignment route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActor.mockResolvedValue(actor);
    mocks.listAssignments.mockResolvedValue([{ id: extensionId, extension: "20" }]);
    mocks.setAssignment.mockResolvedValue({ id: extensionId, extension: "20", profile_id: profileId });
  });

  it("keeps manager assignment reads available without opening the mutation gate", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireActor).toHaveBeenCalledWith(["manager", "admin"]);
    expect(mocks.listAssignments).toHaveBeenCalledWith(actor);
    expect(mocks.gate).not.toHaveBeenCalled();
  });

  it("runs same-origin and actor authorization before a disabled assignment gate", async () => {
    mocks.gate.mockImplementationOnce(() => {
      throw new MutationError("Telekomunikačné zásahy nie sú povolené.", 503);
    });
    const request = jsonRequest({ extensionId, profileId });

    const response = await PATCH(request);

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.assertSameOrigin).toHaveBeenCalledWith(request);
    expect(mocks.assertSameOrigin.mock.invocationCallOrder[0]).toBeLessThan(mocks.requireActor.mock.invocationCallOrder[0]);
    expect(mocks.requireActor.mock.invocationCallOrder[0]).toBeLessThan(mocks.gate.mock.invocationCallOrder[0]);
    expect(mocks.setAssignment).not.toHaveBeenCalled();
  });

  it("persists an exceptional assignment only after the gate succeeds", async () => {
    const response = await PATCH(jsonRequest({
      extensionId,
      profileId,
      rotationAttested: true,
      rotationReference: "VIPTEL-2026-08-04-20",
    }));

    expect(response.status).toBe(200);
    expect(mocks.gate).toHaveBeenCalledWith("extension.assignment.update");
    expect(mocks.setAssignment).toHaveBeenCalledWith(
      actor,
      extensionId,
      profileId,
      "VIPTEL-2026-08-04-20",
      true,
      undefined,
    );
  });

  it("preserves the machine-readable hot-desk legacy-block code", async () => {
    mocks.setAssignment.mockRejectedValueOnce(new MutationError(
      "Použi bezpečné prevzatie v pohľade Pracovisko.",
      409,
      "hotdesk_legacy_assignment_blocked",
    ));

    const response = await PATCH(jsonRequest({ extensionId, profileId }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "hotdesk_legacy_assignment_blocked",
      ok: false,
    });
  });
});

function jsonRequest(body: Record<string, unknown>) {
  return new Request("https://app.test/api/telephony/extension-assignments", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Origin: "https://app.test" },
    body: JSON.stringify(body),
  });
}
