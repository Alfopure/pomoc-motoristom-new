import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  getSelection: vi.fn(),
  mutateSelection: vi.fn(),
  readLeaseFence: vi.fn(),
  requireActor: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/telephony-access", () => ({
  readWorkplaceLeaseFence: mocks.readLeaseFence,
  requireTelephonyActor: mocks.requireActor,
}));
vi.mock("@/server/telephony/live-mutation-gate", () => ({
  assertTelephonyLiveMutationEnabled: mocks.gate,
}));
vi.mock("@/server/telephony/workplace-selection", () => ({
  getWorkplaceSelection: mocks.getSelection,
  mutateWorkplaceSelection: mocks.mutateSelection,
}));

import { MutationError } from "@/server/motorist-mutations";
import { GET, PATCH } from "./route";

const actor = {
  userId: "user-1",
  profileId: "profile-1",
  organizationId: "organization-1",
  displayName: "Operátor",
  role: "dispatcher",
};
const workplace = {
  checkedAt: "2026-08-05T12:00:00.000Z",
  selection: { extension: null, queue: null },
  seats: [],
  priorities: [],
  routingStatus: { state: "collecting", selectedCount: 0, capacityCount: 3, message: "Čakám." },
};
const browserInstanceId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const leaseFence = {
  assignmentGeneration: "44444444-4444-4444-8444-444444444444",
  browserInstanceId: "55555555-5555-4555-8555-555555555555",
  leaderEpoch: 2,
  leaseId: "66666666-6666-4666-8666-666666666666",
  leaseVersion: 3,
};

describe("self-service workplace selection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActor.mockResolvedValue(actor);
    mocks.readLeaseFence.mockReturnValue(leaseFence);
    mocks.getSelection.mockResolvedValue(workplace);
    mocks.mutateSelection.mockResolvedValue({
      result: { state: "confirmed", message: "Hotovo." },
      workplace,
    });
  });

  it("returns a private member-level snapshot without opening the mutation gate", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireActor).toHaveBeenCalledWith();
    expect(mocks.getSelection).toHaveBeenCalledWith(actor);
    expect(mocks.gate).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ ok: true, workplace });
  });

  it("authenticates the same-origin mutation before opening the live gate", async () => {
    const request = jsonRequest({ action: "claim_seat", extension: "20" });
    const response = await PATCH(request);

    expect(response.status).toBe(200);
    expect(mocks.requireActor).toHaveBeenCalledWith(request);
    expect(mocks.requireActor.mock.invocationCallOrder[0]).toBeLessThan(mocks.gate.mock.invocationCallOrder[0]);
    expect(mocks.gate).toHaveBeenCalledWith("workplace.claim_seat");
    expect(mocks.mutateSelection).toHaveBeenCalledWith(actor, { action: "claim_seat", extension: "20" });
  });

  it("returns 401 for an unauthenticated mutation before the gate or service can run", async () => {
    mocks.requireActor.mockRejectedValueOnce(new MutationError("Na túto operáciu sa musíš prihlásiť.", 401));
    const request = jsonRequest({ action: "claim_seat", extension: "20" });

    const response = await PATCH(request);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireActor).toHaveBeenCalledWith(request);
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.mutateSelection).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Na túto operáciu sa musíš prihlásiť.",
    });
  });

  it("uses 202 only while a provider-confirmed routing operation is pending", async () => {
    mocks.mutateSelection.mockResolvedValueOnce({
      result: { state: "pending", message: "Čakám na VIPTel." },
      workplace: { ...workplace, routingStatus: { ...workplace.routingStatus, state: "activating" } },
    });

    const response = await PATCH(jsonRequest({ action: "claim_priority", queue: "601" }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: { state: "pending" },
      workplace: { routingStatus: { state: "activating" } },
    });
  });

  it("returns 200 for a persisted pre-bootstrap draft without pretending a provider operation started", async () => {
    mocks.mutateSelection.mockResolvedValueOnce({
      result: { state: "draft", message: "Uložená 1 z 3." },
      workplace,
    });

    const response = await PATCH(jsonRequest({ action: "claim_priority", queue: "601" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, result: { state: "draft" } });
  });

  it.each([
    {
      action: "select_seat",
      extension: "23",
      browserInstanceId,
      idempotencyKey,
      expected: { action: "select_seat", extension: "23", browserInstanceId, idempotencyKey },
    },
    {
      action: "leave_seat",
      browserInstanceId,
      idempotencyKey,
      expected: { action: "leave_seat", browserInstanceId, idempotencyKey },
    },
    {
      action: "confirm_seat_change",
      browserInstanceId,
      browserDisconnectOutcome: "accepted",
      idempotencyKey,
      operationId,
      expected: {
        action: "confirm_seat_change",
        browserDisconnectOutcome: "accepted",
        browserInstanceId,
        idempotencyKey,
        operationId,
      },
    },
    {
      action: "cancel_seat_change",
      browserInstanceId,
      idempotencyKey,
      operationId,
      expected: { action: "cancel_seat_change", browserInstanceId, idempotencyKey, operationId },
    },
    { action: "release_seat", expected: { action: "release_seat" } },
    { action: "takeover_seat", extension: "21", expected: { action: "takeover_seat", extension: "21" } },
    {
      action: "release_occupied_seat",
      extension: "22",
      expected: { action: "release_occupied_seat", extension: "22" },
    },
    { action: "claim_priority", queue: "602", expected: { action: "claim_priority", queue: "602" } },
    {
      action: "recover_priority",
      operationId,
      ...leaseFence,
      expected: { action: "recover_priority", operationId, leaseFence },
    },
    { action: "release_priority", expected: { action: "release_priority" } },
  ])("accepts $action with the exact public contract", async ({ expected, ...body }) => {
    const response = await PATCH(jsonRequest(body));
    expect(response.status).toBe(200);
    expect(mocks.mutateSelection).toHaveBeenCalledWith(actor, expected);
  });

  it("requires an exact operation id before parsing the recovery lease fence", async () => {
    const response = await PATCH(jsonRequest({ action: "recover_priority", ...leaseFence }));

    expect(response.status).toBe(400);
    expect(mocks.readLeaseFence).not.toHaveBeenCalled();
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.mutateSelection).not.toHaveBeenCalled();
  });

  it("validates hot-desk fencing identifiers before opening the mutation gate", async () => {
    const response = await PATCH(jsonRequest({
      action: "select_seat",
      extension: "20",
      browserInstanceId: "copied-tab",
      idempotencyKey,
    }));

    expect(response.status).toBe(400);
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.mutateSelection).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "Relácia prehliadača nemá platný identifikátor.",
    });
  });

  it("rejects a fabricated browser disconnect result before opening the mutation gate", async () => {
    const response = await PATCH(jsonRequest({
      action: "confirm_seat_change",
      browserDisconnectOutcome: "timed_out",
      browserInstanceId,
      idempotencyKey: operationId,
      operationId,
    }));

    expect(response.status).toBe(400);
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.mutateSelection).not.toHaveBeenCalled();
  });

  it("never accepts an arbitrary takeover target profile from the client", async () => {
    const response = await PATCH(jsonRequest({
      action: "takeover_seat",
      extension: "21",
      targetProfileId: "profile-forged",
    }));

    expect(response.status).toBe(200);
    expect(mocks.mutateSelection).toHaveBeenCalledWith(actor, {
      action: "takeover_seat",
      extension: "21",
    });
  });

  it.each([
    null,
    [],
    {},
    { action: "claim" },
    { action: "priority" },
    { action: "claim-seat" },
  ])("rejects an invalid action without opening the gate", async (body) => {
    const response = await PATCH(jsonRequest(body));
    expect(response.status).toBe(400);
    expect(mocks.gate).not.toHaveBeenCalled();
    expect(mocks.mutateSelection).not.toHaveBeenCalled();
  });

  it("returns a conflict without presenting a false success", async () => {
    mocks.mutateSelection.mockRejectedValueOnce(new MutationError("Miesto je obsadené.", 409));
    const response = await PATCH(jsonRequest({ action: "claim_seat", extension: "21" }));
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Miesto je obsadené." });
  });

  it("returns stable service error codes without exposing unexpected internals", async () => {
    mocks.mutateSelection.mockRejectedValueOnce(new MutationError(
      "Toto miesto už používa iné aktívne okno.",
      409,
      "lease_lost",
    ));
    const response = await PATCH(jsonRequest({
      action: "select_seat",
      extension: "20",
      browserInstanceId,
      idempotencyKey,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Toto miesto už používa iné aktívne okno.",
      code: "lease_lost",
    });
  });

  it("exposes source unregister convergence as an exact-confirm retry contract", async () => {
    mocks.mutateSelection.mockRejectedValueOnce(new MutationError(
      "VIPTel ešte dokončuje odpojenie telefónu na pracovnom mieste 20. Bezpečne opakuj rovnaké potvrdenie.",
      423,
      "workplace_source_unregister_pending",
    ));

    const response = await PATCH(jsonRequest({
      action: "confirm_seat_change",
      browserInstanceId,
      idempotencyKey: operationId,
      operationId,
    }));

    expect(response.status).toBe(423);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "VIPTel ešte dokončuje odpojenie telefónu na pracovnom mieste 20. Bezpečne opakuj rovnaké potvrdenie.",
      code: "workplace_source_unregister_pending",
    });
  });

  it("returns the occupied-priority conflict code without presenting a successful reorder", async () => {
    mocks.mutateSelection.mockRejectedValueOnce(new MutationError(
      "Priorita už patrí inému pracovnému miestu.",
      409,
      "priority_slot_active",
    ));

    const response = await PATCH(jsonRequest({ action: "claim_priority", queue: "602" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "priority_slot_active", ok: false });
  });

  it("preserves the service-level role denial for administrative takeover", async () => {
    mocks.mutateSelection.mockRejectedValueOnce(new MutationError(
      "Pracovné miesto môže prevziať iba administrátor alebo manažér.",
      403,
    ));

    const response = await PATCH(jsonRequest({ action: "takeover_seat", extension: "21" }));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Pracovné miesto môže prevziať iba administrátor alebo manažér.",
    });
  });

  it("redacts unexpected internal failures from the public response", async () => {
    mocks.mutateSelection.mockRejectedValueOnce(new Error(
      "postgres connection failed for internal-host.example table private_assignments",
    ));

    const response = await PATCH(jsonRequest({ action: "takeover_seat", extension: "21" }));

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Výber pracoviska sa nepodarilo spracovať.",
    });
  });
});

function jsonRequest(body: unknown) {
  return new Request("https://app.test/api/telephony/workplace-selection", {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: "https://app.test" },
    body: JSON.stringify(body),
  });
}
