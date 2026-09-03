import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring test for the conference and supervision routes (design §4 Phase 4).
 *
 * The shared behaviour (CSRF → auth → 503 → error mapping) is covered by
 * `hold/route.test.ts`; asserted here is what only these wrappers know: the
 * service they call, the `legId` segment they forward, the supervisor mode they
 * validate and the Slovak fallback they carry.
 */

const actions = {
  addCallParty: vi.fn(),
  setCallPartyMuted: vi.fn(),
  removeCallParty: vi.fn(),
  leaveConferenceCall: vi.fn(),
  superviseCall: vi.fn(),
  stopSupervisingCall: vi.fn(),
};

const requireDefaultMotoristActor = vi.fn();
const assertSameOriginRequest = vi.fn();
const createTelephonyDeps = vi.fn(async () => ({ marker: "deps" }));

vi.mock("@/server/api-auth", () => ({
  requireDefaultMotoristActor: (...args: unknown[]) => requireDefaultMotoristActor(...args),
  assertSameOriginRequest: (...args: unknown[]) => assertSameOriginRequest(...args),
}));

vi.mock("@/server/telephony/call-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/call-actions")>();
  return {
    ...actual,
    addCallParty: (...args: unknown[]) => actions.addCallParty(...args),
    setCallPartyMuted: (...args: unknown[]) => actions.setCallPartyMuted(...args),
    removeCallParty: (...args: unknown[]) => actions.removeCallParty(...args),
    leaveConferenceCall: (...args: unknown[]) => actions.leaveConferenceCall(...args),
    superviseCall: (...args: unknown[]) => actions.superviseCall(...args),
    stopSupervisingCall: (...args: unknown[]) => actions.stopSupervisingCall(...args),
  };
});

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: (...args: unknown[]) => createTelephonyDeps(...(args as [])) };
});

const ACTOR = { userId: "user-1", profileId: "profile-1", organizationId: "org-1", displayName: "Manažér", role: "manager" as const };
const EXPECTED_ACTOR = { profileId: "profile-1", role: "manager", displayName: "Manažér" };
const DEPS = { marker: "deps" };

type RouteModule = { POST: (request: Request, context: { params: Promise<never> }) => Promise<Response> };

type Case = {
  name: string;
  path: string;
  params: Record<string, string>;
  action: keyof typeof actions;
  fallback: string;
  body?: Record<string, unknown>;
  args: unknown[];
  load: () => Promise<RouteModule>;
};

const CASES: Case[] = [
  {
    name: "add-party",
    path: "add-party",
    params: { id: "sess-1" },
    action: "addCallParty",
    fallback: "Účastníka sa nepodarilo pridať.",
    body: { number: " +421905123456 " },
    args: [DEPS, EXPECTED_ACTOR, "sess-1", { profileId: null, number: "+421905123456" }],
    load: () => import("./add-party/route") as unknown as Promise<RouteModule>,
  },
  {
    name: "leave",
    path: "leave",
    params: { id: "sess-1" },
    action: "leaveConferenceCall",
    fallback: "Z konferencie sa nepodarilo odísť.",
    args: [DEPS, EXPECTED_ACTOR, "sess-1"],
    load: () => import("./leave/route") as unknown as Promise<RouteModule>,
  },
  {
    name: "parties/[legId]/mute",
    path: "parties/leg-9/mute",
    params: { id: "sess-1", legId: "leg-9" },
    action: "setCallPartyMuted",
    fallback: "Účastníka sa nepodarilo stlmiť.",
    args: [DEPS, EXPECTED_ACTOR, "sess-1", "leg-9", true],
    load: () => import("./parties/[legId]/mute/route") as unknown as Promise<RouteModule>,
  },
  {
    name: "parties/[legId]/unmute",
    path: "parties/leg-9/unmute",
    params: { id: "sess-1", legId: "leg-9" },
    action: "setCallPartyMuted",
    fallback: "Účastníka sa nepodarilo odtlmiť.",
    args: [DEPS, EXPECTED_ACTOR, "sess-1", "leg-9", false],
    load: () => import("./parties/[legId]/unmute/route") as unknown as Promise<RouteModule>,
  },
  {
    name: "parties/[legId]/kick",
    path: "parties/leg-9/kick",
    params: { id: "sess-1", legId: "leg-9" },
    action: "removeCallParty",
    fallback: "Účastníka sa nepodarilo odpojiť.",
    args: [DEPS, EXPECTED_ACTOR, "sess-1", "leg-9"],
    load: () => import("./parties/[legId]/kick/route") as unknown as Promise<RouteModule>,
  },
  {
    name: "supervise",
    path: "supervise",
    params: { id: "sess-1" },
    action: "superviseCall",
    fallback: "Dozor nad hovorom sa nepodarilo spustiť.",
    body: { mode: "whisper" },
    args: [DEPS, EXPECTED_ACTOR, "sess-1", "whisper"],
    load: () => import("./supervise/route") as unknown as Promise<RouteModule>,
  },
  {
    name: "stop-supervise",
    path: "stop-supervise",
    params: { id: "sess-1" },
    action: "stopSupervisingCall",
    fallback: "Dozor sa nepodarilo ukončiť.",
    args: [DEPS, EXPECTED_ACTOR, "sess-1"],
    load: () => import("./stop-supervise/route") as unknown as Promise<RouteModule>,
  },
];

function request(path: string, body: Record<string, unknown> = {}) {
  return new Request(`https://app.test/api/telephony/calls/sess-1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const context = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as { params: Promise<never> };

describe("conference and supervision route wiring", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtest";
    requireDefaultMotoristActor.mockReset().mockResolvedValue(ACTOR);
    assertSameOriginRequest.mockReset();
    createTelephonyDeps.mockClear();
    for (const action of Object.values(actions)) action.mockReset();
  });

  for (const entry of CASES) {
    it(`${entry.name} calls ${entry.action} with the actor, session and segments`, async () => {
      actions[entry.action].mockResolvedValue({ sessionId: "sess-1", state: "conference", commands: [], ignored: null });
      const { POST } = await entry.load();

      const response = await POST(request(entry.path, entry.body), context(entry.params));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true, sessionId: "sess-1" });
      expect(actions[entry.action]).toHaveBeenCalledWith(...entry.args);
    });

    it(`${entry.name} answers an unexpected failure with its own fallback message`, async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      actions[entry.action].mockRejectedValue(new Error("supabase down"));
      const { POST } = await entry.load();

      const response = await POST(request(entry.path, entry.body), context(entry.params));

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: entry.fallback });
      consoleError.mockRestore();
    });
  }

  it("refuses an unknown supervisor mode before touching the call", async () => {
    const { POST } = (await import("./supervise/route")) as unknown as RouteModule;
    const response = await POST(request("supervise", { mode: "spy" }), context({ id: "sess-1" }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Neplatný režim dozoru.", code: "invalid_mode" });
    expect(actions.superviseCall).not.toHaveBeenCalled();
  });

  it("refuses a missing supervisor mode", async () => {
    const { POST } = (await import("./supervise/route")) as unknown as RouteModule;
    const response = await POST(request("supervise"), context({ id: "sess-1" }));
    expect(response.status).toBe(400);
    expect(actions.superviseCall).not.toHaveBeenCalled();
  });
});
