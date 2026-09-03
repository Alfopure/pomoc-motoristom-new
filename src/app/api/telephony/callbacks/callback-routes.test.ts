import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring test for the callback-queue routes.
 *
 * Each POST is a wrapper over `handleCallbackActionRoute`, so what is asserted
 * here is what only the wrapper knows: which service function it calls, with
 * which arguments, and which Slovak fallback message it carries — plus the two
 * decisions the shared handler makes that are specific to this queue: the CSRF
 * check runs before the session guard, and only the one-click callback needs a
 * configured provider.
 */

const services = {
  loadCallbackQueue: vi.fn(),
  claimCallbackRequest: vi.fn(),
  resolveCallbackRequest: vi.fn(),
  callBackRequest: vi.fn(),
};

const requireDefaultMotoristActor = vi.fn();
const assertSameOriginRequest = vi.fn();
const createTelephonyDeps = vi.fn(async () => DEPS);

vi.mock("@/server/api-auth", () => ({
  requireDefaultMotoristActor: (...args: unknown[]) => requireDefaultMotoristActor(...args),
  assertSameOriginRequest: (...args: unknown[]) => assertSameOriginRequest(...args),
}));

vi.mock("@/server/telephony/callbacks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/callbacks")>();
  return {
    ...actual,
    loadCallbackQueue: (...args: unknown[]) => services.loadCallbackQueue(...args),
    claimCallbackRequest: (...args: unknown[]) => services.claimCallbackRequest(...args),
    resolveCallbackRequest: (...args: unknown[]) => services.resolveCallbackRequest(...args),
    callBackRequest: (...args: unknown[]) => services.callBackRequest(...args),
  };
});

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: (...args: unknown[]) => createTelephonyDeps(...(args as [])) };
});

const ACTOR = { userId: "user-1", profileId: "profile-1", organizationId: "org-1", displayName: "Jana", role: "dispatcher" as const };
const EXPECTED_ACTOR = { profileId: "profile-1", role: "dispatcher", displayName: "Jana" };
const DEPS = { admin: "admin-client", organizationId: "org-1", now: "now-fn", logger: "logger-fn", config: { configured: true } } as never;
const QUEUE_DEPS = { admin: "admin-client", organizationId: "org-1", now: "now-fn", logger: "logger-fn" };
const REQUEST = { id: "cb-1", status: "scheduled" };

type Case = {
  path: string;
  service: keyof typeof services;
  fallback: string;
  body?: Record<string, unknown>;
  args: unknown[];
  load: () => Promise<{ POST: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> }>;
};

const CASES: Case[] = [
  {
    path: "claim",
    service: "claimCallbackRequest",
    fallback: "Prevzatie požiadavky zlyhalo.",
    args: [QUEUE_DEPS, EXPECTED_ACTOR, "cb-1"],
    load: () => import("./[id]/claim/route"),
  },
  {
    path: "done",
    service: "resolveCallbackRequest",
    fallback: "Uzavretie požiadavky zlyhalo.",
    body: { notes: "  Volané, dohodnuté  " },
    args: [QUEUE_DEPS, EXPECTED_ACTOR, "cb-1", { status: "done", notes: "Volané, dohodnuté" }],
    load: () => import("./[id]/done/route"),
  },
  {
    path: "cancel",
    service: "resolveCallbackRequest",
    fallback: "Zrušenie požiadavky zlyhalo.",
    args: [QUEUE_DEPS, EXPECTED_ACTOR, "cb-1", { status: "cancelled", notes: null }],
    load: () => import("./[id]/cancel/route"),
  },
];

function post(path: string, body: Record<string, unknown> = {}) {
  return new Request(`https://app.test/api/telephony/callbacks/cb-1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const context = () => ({ params: Promise.resolve({ id: "cb-1" }) });

describe("callback route wiring", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtest";
    requireDefaultMotoristActor.mockReset().mockResolvedValue(ACTOR);
    assertSameOriginRequest.mockReset();
    createTelephonyDeps.mockClear();
    for (const service of Object.values(services)) service.mockReset();
  });

  for (const entry of CASES) {
    it(`${entry.path} calls ${entry.service} with the actor and the request id`, async () => {
      services[entry.service].mockResolvedValue({ request: REQUEST });
      const { POST } = await entry.load();

      const response = await POST(post(entry.path, entry.body), context());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, request: REQUEST });
      expect(services[entry.service]).toHaveBeenCalledWith(...entry.args);
      expect(assertSameOriginRequest).toHaveBeenCalledTimes(1);
    });

    it(`${entry.path} answers an unexpected failure with its own fallback message`, async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      services[entry.service].mockRejectedValue(new Error("supabase down"));
      const { POST } = await entry.load();

      const response = await POST(post(entry.path, entry.body), context());

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: entry.fallback });
      consoleError.mockRestore();
    });
  }

  it("dials through the ordinary outbound path and hands the browser its own leg", async () => {
    services.callBackRequest.mockResolvedValue({
      request: REQUEST,
      linked: true,
      call: { sessionId: "sess-1", operatorLegCallControlId: "cc-1" },
    });
    const { POST } = await import("./[id]/call/route");

    const response = await POST(post("call"), context());

    await expect(response.json()).resolves.toEqual({
      ok: true,
      request: REQUEST,
      linked: true,
      sessionId: "sess-1",
      operatorLegCallControlId: "cc-1",
    });
    expect(services.callBackRequest).toHaveBeenCalledWith(DEPS, EXPECTED_ACTOR, "cb-1");
  });

  it("refuses to dial without a provider but still lets the queue be cleared", async () => {
    delete process.env.TELNYX_API_KEY;
    services.claimCallbackRequest.mockResolvedValue({ request: REQUEST });

    const dial = await (await import("./[id]/call/route")).POST(post("call"), context());
    expect(dial.status).toBe(503);
    expect(services.callBackRequest).not.toHaveBeenCalled();

    // The rows are ordinary database records: a promise made to a caller has to
    // be settleable even with the provider switched off.
    const claim = await (await import("./[id]/claim/route")).POST(post("claim"), context());
    expect(claim.status).toBe(200);
    expect(services.claimCallbackRequest).toHaveBeenCalledTimes(1);
  });

  it("checks the origin before the session guard", async () => {
    assertSameOriginRequest.mockImplementation(() => {
      throw Object.assign(new Error("Neplatný pôvod požiadavky."), { status: 403 });
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = await import("./[id]/claim/route");

    const response = await POST(post("claim"), context());

    expect(requireDefaultMotoristActor).not.toHaveBeenCalled();
    expect(response.status).toBe(500);
    consoleError.mockRestore();
  });

  it("reads the queue with the actor's own role", async () => {
    services.loadCallbackQueue.mockResolvedValue({ open: [], resolved: [] });
    const { GET } = await import("./route");

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(services.loadCallbackQueue).toHaveBeenCalledWith(
      QUEUE_DEPS,
      { profileId: "profile-1", role: "dispatcher" },
      { configured: true },
    );
  });
});
