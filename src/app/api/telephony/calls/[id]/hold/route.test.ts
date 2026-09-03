import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MutationError } from "@/server/motorist-mutations";
import { CallActionError } from "@/server/telephony/call-actions";

const requireDefaultMotoristActor = vi.fn();
const assertSameOriginRequest = vi.fn();
const holdCall = vi.fn();
const createTelephonyDeps = vi.fn(async () => ({ marker: "deps" }));

vi.mock("@/server/api-auth", () => ({
  requireDefaultMotoristActor: (...args: unknown[]) => requireDefaultMotoristActor(...args),
  assertSameOriginRequest: (...args: unknown[]) => assertSameOriginRequest(...args),
}));

vi.mock("@/server/telephony/call-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/call-actions")>();
  return { ...actual, holdCall: (...args: unknown[]) => holdCall(...args) };
});

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: (...args: unknown[]) => createTelephonyDeps(...(args as [])) };
});

import { POST } from "./route";

const ACTOR = { userId: "user-1", profileId: "profile-1", organizationId: "org-1", displayName: "Jana", role: "dispatcher" as const };

function request(body: Record<string, unknown> = {}) {
  return new Request("https://app.test/api/telephony/calls/sess-1/hold", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ id: "sess-1" }) };

describe("POST /api/telephony/calls/[id]/hold", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtest";
    requireDefaultMotoristActor.mockReset().mockResolvedValue(ACTOR);
    assertSameOriginRequest.mockReset();
    holdCall.mockReset();
    createTelephonyDeps.mockClear();
  });

  afterEach(() => {
    delete process.env.TELNYX_API_KEY;
  });

  it("holds the call for the session actor", async () => {
    holdCall.mockResolvedValue({ sessionId: "sess-1", state: "held", commands: [{ kind: "conference_hold", ok: true, error: null }], ignored: null });

    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, sessionId: "sess-1", state: "held" });
    expect(holdCall).toHaveBeenCalledWith({ marker: "deps" }, { profileId: "profile-1", role: "dispatcher", displayName: "Jana" }, "sess-1");
    expect(createTelephonyDeps).toHaveBeenCalledWith({ organizationId: "org-1" });
  });

  it("runs the CSRF check before authentication", async () => {
    assertSameOriginRequest.mockImplementation(() => {
      throw new MutationError("Požiadavka neprešla bezpečnostnou kontrolou.", 403);
    });

    const response = await POST(request(), context);

    expect(response.status).toBe(403);
    expect(requireDefaultMotoristActor).not.toHaveBeenCalled();
    expect(holdCall).not.toHaveBeenCalled();
  });

  it("returns 401 for an anonymous request", async () => {
    requireDefaultMotoristActor.mockRejectedValue(new MutationError("Na túto operáciu sa musíš prihlásiť.", 401));

    const response = await POST(request(), context);

    expect(response.status).toBe(401);
    expect(holdCall).not.toHaveBeenCalled();
  });

  it("returns 503 with the Slovak notice while telephony is not configured", async () => {
    delete process.env.TELNYX_API_KEY;

    const response = await POST(request(), context);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Telefónia nie je nakonfigurovaná." });
    expect(holdCall).not.toHaveBeenCalled();
  });

  it("maps a rejected action onto its own status and code", async () => {
    holdCall.mockRejectedValue(new CallActionError("Hovor už nie je aktívny.", 409, "not_active"));

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Hovor už nie je aktívny.", code: "not_active" });
  });

  it("maps the kill switch onto 423", async () => {
    holdCall.mockRejectedValue(new CallActionError("Živé hovory sú vypnuté (kill switch).", 423, "live_calls_disabled"));

    const response = await POST(request(), context);

    expect(response.status).toBe(423);
  });

  it("keeps an unexpected failure generic", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    holdCall.mockRejectedValue(new Error("supabase down"));

    const response = await POST(request(), context);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Podržanie hovoru zlyhalo." });
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
