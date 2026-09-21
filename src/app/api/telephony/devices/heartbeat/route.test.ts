import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const touchDevice = vi.fn();
const scheduled: Array<() => Promise<void>> = [];
const logBrowserCallObservations = vi.fn();
vi.mock("next/server", () => ({ after: (callback: () => Promise<void>) => { scheduled.push(callback); } }));
vi.mock("@/server/telephony/browser-call-telemetry", () => ({ logBrowserCallObservations: (...args: unknown[]) => logBrowserCallObservations(...args) }));

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
    scheduled.length = 0;
    logBrowserCallObservations.mockReset();
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
      { admin: { marker: "admin" }, telnyx: null, environment: "development", deviceKind: "web" },
      { organizationId: "org-1", profileId: "profile-1", deviceSessionId: "dev-1", registrationState: "registered", userAgent: "vitest" },
    );
  });

  it("answers 409 to a superseded tab so it can disconnect itself", async () => {
    touchDevice.mockResolvedValue({ ok: false, reason: "stale_session" });

    const response = await POST(request({ deviceSessionId: "dev-old" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Telefón bol prihlásený v inom okne.", reason: "stale_session" });
  });

  it("validates browser timings and schedules only after a current-device heartbeat succeeds", async () => {
    const timing = { id: "11111111-1111-4111-8111-111111111111", pageId: "22222222-2222-4222-8222-222222222222", callControlId: "opaque", phase: "sdk_invite", atMs: 123, token: "discard" };
    touchDevice.mockResolvedValue({ ok: false, reason: "stale_session" });
    expect((await POST(request({ deviceSessionId: "stale", callTimings: [timing] }))).status).toBe(409);
    expect(scheduled).toHaveLength(0);
    touchDevice.mockResolvedValue({ ok: true, device: { device_seen_at: null, registration_state: "registered" } });
    expect((await POST(request({ deviceSessionId: "current", callTimings: [timing] }))).status).toBe(200);
    expect(scheduled).toHaveLength(1);
    expect(logBrowserCallObservations).not.toHaveBeenCalled();
    await scheduled[0]();
    expect(logBrowserCallObservations).toHaveBeenCalledWith(expect.objectContaining({ organizationId: "org-1", environment: "development" }), "profile-1", [{ id: timing.id, pageId: timing.pageId, callControlId: "opaque", phase: "sdk_invite", atMs: 123 }]);
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

  it.each([
    ["a full report", { blocked: false, remoteMedia: true }, { blocked: false, remoteMedia: true }],
    ["a blocked device", { blocked: true, remoteMedia: true }, { blocked: true, remoteMedia: true }],
    ["a report without a stream", { blocked: false, remoteMedia: false }, { blocked: false, remoteMedia: false }],
  ])("passes %s of the device's own audio through", async (_label, audio, expected) => {
    touchDevice.mockResolvedValue({ ok: true, device: { device_seen_at: "2026-09-17T11:00:00.000Z", registration_state: "registered" } });

    const response = await POST(request({ deviceSessionId: "device-1", registrationState: "registered", audio }));

    expect(response.status).toBe(200);
    expect(touchDevice).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ audio: expected }));
  });

  it.each([
    ["a missing report", undefined],
    ["a half report", { blocked: true }],
    ["the wrong types", { blocked: "yes", remoteMedia: 1 }],
    ["an array", [true, false]],
    ["a string", "connected"],
  ])("drops %s instead of storing it", async (_label, audio) => {
    touchDevice.mockResolvedValue({ ok: true, device: { device_seen_at: "2026-09-17T11:00:00.000Z", registration_state: "registered" } });

    const response = await POST(request({ deviceSessionId: "device-1", registrationState: "registered", ...(audio === undefined ? {} : { audio }) }));

    expect(response.status).toBe(200);
    expect(touchDevice.mock.calls[0][1]).not.toHaveProperty("audio");
  });
});
