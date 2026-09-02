import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  heartbeat: vi.fn(),
  requireActor: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/telephony-access", () => ({ requireTelephonyActor: mocks.requireActor }));
vi.mock("@/server/telephony/workplace-presence", () => ({
  heartbeatWorkplaceLease: mocks.heartbeat,
  resumeWorkplaceLease: mocks.resume,
}));

import { MutationError } from "@/server/motorist-mutations";
import { POST } from "./route";

const actor = { organizationId: "org", profileId: "profile", role: "dispatcher" };
const input = {
  leaseId: "11111111-1111-4111-8111-111111111111",
  assignmentGeneration: "22222222-2222-4222-8222-222222222222",
  browserInstanceId: "33333333-3333-4333-8333-333333333333",
  leaderEpoch: 2,
  leaseVersion: 4,
};
const lease = { ...input, seatId: "44444444-4444-4444-8444-444444444444", extension: "20", expiresAt: "2026-08-07T08:00:00.000Z", heartbeatIntervalMs: 15_000 };

describe("workplace presence route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActor.mockResolvedValue(actor);
    mocks.heartbeat.mockResolvedValue({ lease });
    mocks.resume.mockResolvedValue({ lease, resumeSecret: "n".repeat(43) });
  });

  it("authenticates same-origin and renews the exact canonical lease", async () => {
    const request = jsonRequest(input);
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireActor).toHaveBeenCalledWith(request);
    expect(mocks.heartbeat).toHaveBeenCalledWith(actor, input);
    await expect(response.json()).resolves.toEqual({ ok: true, lease });
  });

  it("rotates a one-time resume secret only for an explicit resume", async () => {
    const resumeSecret = "o".repeat(43);
    const idempotencyKey = "55555555-5555-4555-8555-555555555555";
    const response = await POST(jsonRequest({ action: "resume", ...input, idempotencyKey, resumeSecret }));

    expect(response.status).toBe(200);
    expect(mocks.resume).toHaveBeenCalledWith(actor, { ...input, idempotencyKey, resumeSecret });
    expect(mocks.heartbeat).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ ok: true, resumeSecret: "n".repeat(43) });
  });

  it("requires a stable resume idempotency key", async () => {
    const response = await POST(jsonRequest({ action: "resume", ...input, resumeSecret: "o".repeat(43) }));
    expect(response.status).toBe(400);
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("returns stable transitioning and terminal lease codes", async () => {
    mocks.heartbeat.mockRejectedValueOnce(new MutationError("Zmena prebieha.", 423, "lease_transitioning"));
    const transitioning = await POST(jsonRequest(input));
    expect(transitioning.status).toBe(423);
    await expect(transitioning.json()).resolves.toMatchObject({ code: "lease_transitioning" });

    mocks.heartbeat.mockRejectedValueOnce(new MutationError("Relácia zanikla.", 409, "lease_lost"));
    const lost = await POST(jsonRequest(input));
    expect(lost.status).toBe(409);
    await expect(lost.json()).resolves.toMatchObject({ code: "lease_lost" });
  });

  it("rejects malformed fencing before calling the repository service", async () => {
    const response = await POST(jsonRequest({ ...input, leaseVersion: 0 }));
    expect(response.status).toBe(400);
    expect(mocks.heartbeat).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("redacts unexpected failures", async () => {
    mocks.heartbeat.mockRejectedValueOnce(new Error("private database host"));
    const response = await POST(jsonRequest(input));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Prítomnosť pracoviska sa nepodarilo spracovať.",
    });
  });
});

function jsonRequest(body: unknown) {
  return new Request("https://app.test/api/telephony/workplace-presence", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test" },
    body: JSON.stringify(body),
  });
}
