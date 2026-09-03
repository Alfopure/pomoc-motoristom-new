import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring test for the thin call-action routes: each one is an eight-line wrapper
 * over `handleCallActionRoute`, so the shared behaviour (CSRF → auth → 503 →
 * error mapping) is covered by `hold/route.test.ts` and `transfer/route.test.ts`.
 * What is asserted here is what only the wrapper knows: which action it calls,
 * with which arguments, and which Slovak fallback message it carries.
 */

const actions = {
  unholdCall: vi.fn(),
  parkCall: vi.fn(),
  hangupCall: vi.fn(),
  pickupWaitingCall: vi.fn(),
  startConsult: vi.fn(),
  completeTransfer: vi.fn(),
  cancelConsult: vi.fn(),
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
    unholdCall: (...args: unknown[]) => actions.unholdCall(...args),
    parkCall: (...args: unknown[]) => actions.parkCall(...args),
    hangupCall: (...args: unknown[]) => actions.hangupCall(...args),
    pickupWaitingCall: (...args: unknown[]) => actions.pickupWaitingCall(...args),
    startConsult: (...args: unknown[]) => actions.startConsult(...args),
    completeTransfer: (...args: unknown[]) => actions.completeTransfer(...args),
    cancelConsult: (...args: unknown[]) => actions.cancelConsult(...args),
  };
});

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: (...args: unknown[]) => createTelephonyDeps(...(args as [])) };
});

const ACTOR = { userId: "user-1", profileId: "profile-1", organizationId: "org-1", displayName: "Jana", role: "dispatcher" as const };
const EXPECTED_ACTOR = { profileId: "profile-1", role: "dispatcher", displayName: "Jana" };
const DEPS = { marker: "deps" };

type Case = {
  path: string;
  action: keyof typeof actions;
  fallback: string;
  body?: Record<string, unknown>;
  args: unknown[];
  load: () => Promise<{ POST: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> }>;
};

const CASES: Case[] = [
  { path: "unhold", action: "unholdCall", fallback: "Obnovenie hovoru zlyhalo.", args: [DEPS, EXPECTED_ACTOR, "sess-1"], load: () => import("./unhold/route") },
  { path: "park", action: "parkCall", fallback: "Zaparkovanie hovoru zlyhalo.", args: [DEPS, EXPECTED_ACTOR, "sess-1"], load: () => import("./park/route") },
  { path: "hangup", action: "hangupCall", fallback: "Ukončenie hovoru zlyhalo.", args: [DEPS, EXPECTED_ACTOR, "sess-1"], load: () => import("./hangup/route") },
  { path: "pickup", action: "pickupWaitingCall", fallback: "Prevzatie hovoru zlyhalo.", args: [DEPS, EXPECTED_ACTOR, "sess-1"], load: () => import("./pickup/route") },
  {
    path: "consult",
    action: "startConsult",
    fallback: "Konzultáciu sa nepodarilo začať.",
    body: { number: " +421905123456 " },
    args: [DEPS, EXPECTED_ACTOR, "sess-1", { profileId: null, number: "+421905123456" }],
    load: () => import("./consult/route"),
  },
  { path: "complete-transfer", action: "completeTransfer", fallback: "Dokončenie prepojenia zlyhalo.", args: [DEPS, EXPECTED_ACTOR, "sess-1"], load: () => import("./complete-transfer/route") },
  { path: "cancel-consult", action: "cancelConsult", fallback: "Zrušenie konzultácie zlyhalo.", args: [DEPS, EXPECTED_ACTOR, "sess-1"], load: () => import("./cancel-consult/route") },
];

function request(path: string, body: Record<string, unknown> = {}) {
  return new Request(`https://app.test/api/telephony/calls/sess-1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const context = () => ({ params: Promise.resolve({ id: "sess-1" }) });

describe("call-action route wiring", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtest";
    requireDefaultMotoristActor.mockReset().mockResolvedValue(ACTOR);
    assertSameOriginRequest.mockReset();
    createTelephonyDeps.mockClear();
    for (const action of Object.values(actions)) action.mockReset();
  });

  for (const entry of CASES) {
    it(`${entry.path} calls ${entry.action} with the actor and session`, async () => {
      actions[entry.action].mockResolvedValue({ sessionId: "sess-1", state: "talking", commands: [], ignored: null });
      const { POST } = await entry.load();

      const response = await POST(request(entry.path, entry.body), context());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true, sessionId: "sess-1" });
      expect(actions[entry.action]).toHaveBeenCalledWith(...entry.args);
    });

    it(`${entry.path} answers an unexpected failure with its own fallback message`, async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      actions[entry.action].mockRejectedValue(new Error("supabase down"));
      const { POST } = await entry.load();

      const response = await POST(request(entry.path, entry.body), context());

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: entry.fallback });
      consoleError.mockRestore();
    });
  }
});
