import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const touchDevice = vi.fn();

vi.mock("@/server/api-auth", () => ({
  requireDefaultMotoristActor: async () => ({ userId: "user-1", profileId: "profile-1", organizationId: "org-1", displayName: "Jana", role: "dispatcher" as const }),
  assertSameOriginRequest: () => {},
}));

vi.mock("@/server/telephony/operator-devices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/operator-devices")>();
  return { ...actual, touchDevice: (...args: unknown[]) => touchDevice(...args) };
});

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: async () => ({ admin: { marker: "admin" }, telnyx: null, environment: "development", organizationId: "org-1", config: { configured: true } }) };
});

import { POST } from "./route";

function request(body: Record<string, unknown>) {
  return new Request("https://app.test/api/telephony/devices/heartbeat", { method: "POST", headers: { "content-type": "application/json", "user-agent": "vitest" }, body: JSON.stringify(body) });
}

describe("POST /api/telephony/devices/heartbeat", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtest";
    touchDevice.mockReset();
  });

  afterEach(() => {
    delete process.env.TELNYX_API_KEY;
  });

  it("records the heartbeat of the current device session", async () => {
    touchDevice.mockResolvedValue({ ok: true, device: { device_seen_at: "2026-09-03T08:00:00.000Z", registration_state: "registered" } });

    const response = await POST(request({ deviceSessionId: "dev-1", registrationState: "registered" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, seenAt: "2026-09-03T08:00:00.000Z", registrationState: "registered" });
    expect(touchDevice).toHaveBeenCalledWith(
      { admin: { marker: "admin" }, telnyx: null, environment: "development" },
      { organizationId: "org-1", profileId: "profile-1", deviceSessionId: "dev-1", registrationState: "registered", userAgent: "vitest" },
    );
  });

  it("answers 409 to a superseded tab so it can disconnect itself", async () => {
    touchDevice.mockResolvedValue({ ok: false, reason: "stale_session" });

    const response = await POST(request({ deviceSessionId: "dev-old" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Telefón bol prihlásený v inom okne.", reason: "stale_session" });
  });

  it("answers 409 when no device row exists yet", async () => {
    touchDevice.mockResolvedValue({ ok: false, reason: "unknown_device" });

    const response = await POST(request({ deviceSessionId: "dev-1" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: "unknown_device" });
  });

  it("rejects a heartbeat without a device session id", async () => {
    const response = await POST(request({}));

    expect(response.status).toBe(400);
    expect(touchDevice).not.toHaveBeenCalled();
  });

  it("ignores an unknown registration state instead of writing it", async () => {
    touchDevice.mockResolvedValue({ ok: true, device: { device_seen_at: null, registration_state: "registered" } });

    await POST(request({ deviceSessionId: "dev-1", registrationState: "nonsense" }));

    expect(touchDevice).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ registrationState: undefined }));
  });

  it("returns 503 while telephony is not configured", async () => {
    delete process.env.TELNYX_API_KEY;

    const response = await POST(request({ deviceSessionId: "dev-1" }));

    expect(response.status).toBe(503);
    expect(touchDevice).not.toHaveBeenCalled();
  });
});
