import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  record: vi.fn(),
  requireActor: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/integrations/viptel/client", () => ({
  serializeViptelError: (error: unknown) => ({
    message: error instanceof Error ? error.message : "provider error",
    status: 500,
  }),
}));
vi.mock("@/server/telephony-access", () => ({
  readWorkplaceLeaseFence: (value: Record<string, unknown>) => ({
    assignmentGeneration: value.assignmentGeneration,
    browserInstanceId: value.browserInstanceId,
    leaderEpoch: value.leaderEpoch,
    leaseId: value.leaseId,
    leaseVersion: value.leaseVersion,
  }),
  requireTelephonyActor: mocks.requireActor,
}));
vi.mock("@/server/telephony/call-commands", () => ({
  enqueueBrowserDtmfTransferCommand: mocks.enqueue,
}));
vi.mock("@/server/telephony/telephony-commands", () => ({
  recordBrowserDtmfTransferDelivery: mocks.record,
}));

import { MutationError } from "@/server/motorist-mutations";
import { PATCH, POST } from "./route";

const actor = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  profileId: "00000000-0000-4000-8000-000000000002",
};
const callId = "00000000-0000-4000-8000-000000000003";
const commandId = "00000000-0000-4000-8000-000000000004";
const fence = {
  assignmentGeneration: "00000000-0000-4000-8000-000000000005",
  browserInstanceId: "00000000-0000-4000-8000-000000000006",
  leaderEpoch: 1,
  leaseId: "00000000-0000-4000-8000-000000000007",
  leaseVersion: 2,
};
const context = { params: Promise.resolve({ id: callId }) };

describe("DTMF transfer route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActor.mockResolvedValue(actor);
    mocks.enqueue.mockResolvedValue({
      id: commandId,
      authorizedViptelUniqueId: "1779959213.4",
      tonePlan: ["#", "#", "2", "3"],
    });
    mocks.record.mockResolvedValue({ id: commandId, status: "accepted" });
  });

  it("creates an owned accepted/unconfirmed intent before returning the server tone plan", async () => {
    const response = await POST(jsonRequest("POST", { destination: "23", mode: "blind", ...fence }), context);

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      command: { confirmationModel: "unconfirmed", id: commandId, status: "accepted" },
      ok: true,
      authorizedViptelUniqueId: "1779959213.4",
      tonePlan: ["#", "#", "2", "3"],
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(actor, callId, "blind", "23", fence);
  });

  it("maps ownership and active-call failures without creating a tone plan", async () => {
    mocks.enqueue.mockRejectedValueOnce(new MutationError("Hovor nepatrí tejto klapke.", 403));

    const response = await POST(jsonRequest("POST", { destination: "23", mode: "blind" }), context);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "Hovor nepatrí tejto klapke." });
  });

  it("returns the machine-readable lease error when a stale browser fence is rejected", async () => {
    mocks.enqueue.mockRejectedValueOnce(new MutationError("Relácia pracoviska už neplatí.", 409, "lease_lost"));

    const response = await POST(jsonRequest("POST", { destination: "23", mode: "blind", ...fence }), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "lease_lost",
      error: "Relácia pracoviska už neplatí.",
      ok: false,
    });
  });

  it("stores a complete result as unconfirmed without accepting client tone counts", async () => {
    const response = await PATCH(jsonRequest("PATCH", {
      commandId,
      outcome: "complete",
      sentToneCount: 999,
    }), context);

    expect(response.status).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith({
      callId,
      commandId,
      organizationId: actor.organizationId,
      requestedBy: actor.profileId,
      report: { outcome: "complete" },
    });
    await expect(response.json()).resolves.toMatchObject({
      command: { confirmationModel: "unconfirmed", status: "accepted" },
      ok: true,
    });
  });

  it("stores zero-tone and partial reports using only the minimal client evidence", async () => {
    await PATCH(jsonRequest("PATCH", {
      commandId,
      error: "session ended",
      failedToneIndex: 0,
      outcome: "failed",
      sentToneCount: 0,
    }), context);
    expect(mocks.record).toHaveBeenLastCalledWith(expect.objectContaining({
      report: {
        error: "session ended",
        failedToneIndex: 0,
        outcome: "failed",
        sentToneCount: 0,
      },
    }));

    await PATCH(jsonRequest("PATCH", {
      commandId,
      error: "media failed",
      failedToneIndex: 63,
      outcome: "partial",
      recoveryInstruction: "client supplied and ignored",
      sentToneCount: 2,
    }), context);
    expect(mocks.record).toHaveBeenLastCalledWith(expect.objectContaining({
      report: { error: "media failed", outcome: "partial", sentToneCount: 2 },
    }));
  });

  it("rejects malformed zero-tone evidence before touching the audit row", async () => {
    const response = await PATCH(jsonRequest("PATCH", {
      commandId,
      failedToneIndex: 1,
      outcome: "failed",
      sentToneCount: 0,
    }), context);

    expect(response.status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each([
    { label: "an empty object", body: {} },
    { label: "Unicode digits", body: { destination: "１２３", mode: "blind" } },
    { label: "an injected target", body: { destination: "23#*", mode: "blind" } },
    { label: "more than 18 digits", body: { destination: "1".repeat(19), mode: "attended" } },
    { label: "an oversized mode", body: { destination: "23", mode: `blind${"x".repeat(4096)}` } },
  ])("rejects $label before creating an audited DTMF intent", async ({ body }) => {
    const response = await POST(jsonRequest("POST", body), context);

    expect(response.status).toBe(400);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before creating an intent", async () => {
    const response = await POST(rawRequest("POST", "{broken"), context);

    expect(response.status).toBe(400);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: "partial", sentToneCount: -1 },
    { outcome: "partial", sentToneCount: 0 },
    { outcome: "partial", sentToneCount: 1.5 },
    { outcome: "unknown", sentToneCount: 1 },
  ])("rejects an invalid delivery report %# before touching the audit row", async (body) => {
    const response = await PATCH(jsonRequest("PATCH", { commandId, ...body }), context);

    expect(response.status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });
});

function jsonRequest(method: "PATCH" | "POST", body: Record<string, unknown>) {
  return rawRequest(method, JSON.stringify(body));
}

function rawRequest(method: "PATCH" | "POST", body: string) {
  return new Request(`https://app.test/api/telephony/calls/${callId}/dtmf-transfer`, {
    method,
    headers: { "Content-Type": "application/json" },
    body,
  });
}
