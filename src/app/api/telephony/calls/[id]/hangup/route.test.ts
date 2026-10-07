import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutationError } from "@/server/motorist-mutations";
import { SessionEventDeferredError } from "@/server/telephony/service-errors";

const mocks = vi.hoisted(() => ({ after: vi.fn(), hangup: vi.fn(), resume: vi.fn(), replay: vi.fn(), contact: vi.fn(), auth: vi.fn(), origin: vi.fn(), logger: vi.fn() }));
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after: mocks.after }));
vi.mock("@/server/api-auth", () => ({ requireDefaultMotoristActor: mocks.auth, assertSameOriginRequest: mocks.origin }));
vi.mock("@/server/telephony/call-actions", async original => ({ ...await original<typeof import("@/server/telephony/call-actions")>(), hangupCall: mocks.hangup, continueAcceptedHangup: mocks.resume }));
vi.mock("@/server/telephony/telnyx/event-processor", async original => ({ ...await original<typeof import("@/server/telephony/telnyx/event-processor")>(), replayDeferredSessionEvents: mocks.replay }));
vi.mock("@/server/telephony/session-runner", async original => ({ ...await original<typeof import("@/server/telephony/session-runner")>(), recoverSessionContactChecks: mocks.contact }));
vi.mock("@/server/telephony/runtime", async original => ({ ...await original<typeof import("@/server/telephony/runtime")>(), createTelephonyDeps: async () => ({ logger: mocks.logger }) }));
import { POST } from "./route";
const request = () => new Request("https://app.test/api/telephony/calls/session/hangup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const context = () => ({ params: Promise.resolve({ id: "session" }) });
const pending = { sessionId: "session", state: "talking", commands: [], ignored: null, terminationPending: true };

describe("accepted hangup response and retained recovery", () => {
  beforeEach(() => {
    vi.stubEnv("TELNYX_API_KEY", "KEYtest");
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.auth.mockResolvedValue({ profileId: "profile", organizationId: "org", role: "dispatcher" });
    mocks.hangup.mockResolvedValue(pending);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("returns pending 202 before one retained continuation under the original request deadline", async () => {
    const started = Date.now();
    const response = await POST(request(), context());
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, terminationPending: true, state: "talking" });
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.after).toHaveBeenCalledTimes(1);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.resume).toHaveBeenCalledExactlyOnceWith({ logger: mocks.logger }, "session", expect.any(Number));
    expect(mocks.resume.mock.calls[0][2]).toBeGreaterThanOrEqual(started + 55_000);
    expect(mocks.resume.mock.calls[0][2]).toBeLessThanOrEqual(Date.now() + 55_000);
    expect(mocks.replay).not.toHaveBeenCalled();
    expect(mocks.contact).not.toHaveBeenCalled();
  });

  it("reports deferred completion without starting more work after the recovery budget", async () => {
    mocks.resume.mockRejectedValue(new SessionEventDeferredError("DB unavailable"));
    expect((await POST(request(), context())).status).toBe(202);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.logger).toHaveBeenCalledWith(expect.objectContaining({ code: "termination_completion_deferred" }));
    expect(mocks.replay).not.toHaveBeenCalled();
    expect(mocks.contact).not.toHaveBeenCalled();
  });

  it("does not reset the host deadline after a slow foreground request", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    mocks.hangup.mockImplementation(async () => { now.mockReturnValue(1_020_000); return pending; });
    expect((await POST(request(), context())).status).toBe(202);
    now.mockReturnValue(1_030_000);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.resume.mock.calls[0][2]).toBe(1_055_000);
  });

  it("keeps durable acceptance truthful if the host cannot schedule its continuation", async () => {
    mocks.after.mockImplementation(() => { throw new Error("host unavailable"); });
    const response = await POST(request(), context());
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ terminationPending: true });
    expect(mocks.logger).toHaveBeenCalledWith(expect.objectContaining({ code: "event_replay_deferred" }));
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("returns ordinary completion only when the action actually completed", async () => {
    mocks.hangup.mockResolvedValue({ sessionId: "session", state: "wrap_up", commands: [], ignored: null });
    expect((await POST(request(), context())).status).toBe(200);
    await mocks.after.mock.calls[0][0]();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.replay).toHaveBeenCalledTimes(1);
  });

  it("never turns unconfirmed writes into accepted work", async () => {
    mocks.hangup.mockRejectedValue(new SessionEventDeferredError("DB unavailable"));
    expect((await POST(request(), context())).status).toBe(503);
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("preserves origin checks before authentication or any accepted work", async () => {
    mocks.origin.mockImplementation(() => { throw new MutationError("Wrong origin", 403); });
    expect((await POST(request(), context())).status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.hangup).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });
});
