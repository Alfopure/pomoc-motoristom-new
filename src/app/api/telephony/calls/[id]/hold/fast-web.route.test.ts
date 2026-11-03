import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { delayDatabase, WAVE_MS } from "@/test/delay-database";
import { defaultLatencyFlags, type LatencyFlags } from "@/server/telephony/latency-flags";
import { readPendingEffects } from "@/server/telephony/state/continuation";
import { commandKey, type SessionRow } from "@/server/telephony/state/types";
import { TelnyxCommandError } from "@/server/telephony/telnyx/client";

/**
 * Early answer of the web hold and unhold (`hold_fast_web`, call-speed S7a.5)
 * through the real route, reducer, effects and fake provider: the response
 * leaves once the control's last provider command is accepted and its cursor
 * durable; the leg projection, history, audit, lease release and the usual
 * maintenance follow in `after()`.
 */

let h: TelephonyHarness;
const deferred = vi.hoisted(() => ({ after: [] as Array<() => Promise<unknown>>, unavailable: false }));
vi.mock("next/server", async importOriginal => ({
  ...await importOriginal<typeof import("next/server")>(), after: (task: () => Promise<unknown>) => {
    if (deferred.unavailable) throw new Error("after() unavailable");
    deferred.after.push(task);
  },
}));
vi.mock("@/server/api-auth", () => ({
  requireDefaultMotoristActor: async () => ({ userId: "user-1", profileId: PROFILES.o1, organizationId: ORG, displayName: "Jana", role: "dispatcher" as const }),
  assertSameOriginRequest: () => {},
}));
vi.mock("@/server/telephony/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@/server/telephony/runtime")>(), createTelephonyDeps: async () => h.deps,
}));

import { POST as hold } from "./route";
import { POST as unhold } from "../unhold/route";

const post = (handler: typeof hold, sessionId: string, action: string) =>
  handler(new Request(`https://app.test/api/telephony/calls/${sessionId}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    { params: Promise.resolve({ id: sessionId }) });

beforeEach(() => {
  vi.stubEnv("TELNYX_API_KEY", "KEYtest");
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  deferred.after.length = 0;
  deferred.unavailable = false;
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

async function talking(fastWeb: boolean, more: Partial<LatencyFlags> = {}) {
  // Until spike S7.0 passes only a TEST deployment freezes join-with-hold: the stable TEST project's identity.
  if (more.hold_join_with_hold) {
    for (const [key, value] of Object.entries({ MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
      VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co",
      APP_BASE_URL: "https://test.dispecing.linkapomoci.sk" })) vi.stubEnv(key, value);
  }
  h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  h.deps.latencyFlags = { ...defaultLatencyFlags(), hold_fast_web: fastWeb, ...more };
  const call = await h.inbound({ to: NUMBERS.allianz });
  await h.legEvent(String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id), "call.answered");
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  return call.sessionId;
}

/** Waves until the response, and until the run and its maintenance are done. */
async function timed(sessionId: string, handler: typeof hold, action: string) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const meter = delayDatabase(h);
  h.telnyx.setFetchDelay(WAVE_MS);
  let respondedAt = -1;
  let stateAtResponse: string | null = null;
  let holdEntryAtResponse = false;
  const response = post(handler, sessionId, action).then(result => {
    respondedAt = meter.waves();
    stateAtResponse = String(h.session(sessionId).state);
    holdEntryAtResponse = readPendingEffects(h.session(sessionId) as SessionRow).entries.some(entry => entry.event.kind === "app" && entry.event.type === action);
    return result;
  });
  await vi.runAllTimersAsync();
  const result = await response;
  const tails = deferred.after.splice(0).map(task => task());
  await vi.runAllTimersAsync();
  await Promise.all(tails);
  const doneAt = meter.waves();
  meter.restore();
  h.telnyx.setFetchDelay(0);
  vi.useRealTimers();
  return { result, body: await result.json() as Record<string, unknown>, respondedAt, doneAt, stateAtResponse, holdEntryAtResponse };
}

describe("hold_fast_web", () => {
  it("off: answers after the whole run, as before", async () => {
    const sessionId = await talking(false);
    const first = await timed(sessionId, hold, "hold");
    expect(first.result.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, sessionId, state: "held", ignored: null });
    expect(first.body).not.toHaveProperty("confirmedState");
    // Finalized and released before the response.
    expect(first.holdEntryAtResponse).toBe(false);
  });

  it("on: answers the first hold and the unhold once the provider took the control, then finishes after the response", async () => {
    const sessionId = await talking(true);
    const first = await timed(sessionId, hold, "hold");
    expect(first.result.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, sessionId, state: "held", confirmedState: "held", ignored: null,
      commands: expect.arrayContaining([{ kind: "conference_hold", ok: true, error: null }]) });
    expect(first.stateAtResponse).toBe("held");
    expect(h.telnyx.of("conference:hold")).toHaveLength(1);
    // Answered before the bookkeeping, which still held the session then…
    expect(first.holdEntryAtResponse).toBe(true);
    expect(first.respondedAt).toBeLessThanOrEqual(first.doneAt - 5);
    // …and which completed after the response.
    expect(readPendingEffects(h.session(sessionId) as SessionRow).entries.some(entry => entry.event.kind === "app" && entry.event.type === "hold")).toBe(false);
    expect(h.legs(sessionId).find(leg => leg.role === "customer")).toMatchObject({ state: "held" });
    expect(h.callEvents(sessionId).some(row => row.event_type === "app.hold" && row.handled_status === "processed")).toBe(true);

    const back = await timed(sessionId, unhold, "unhold");
    expect(back.body).toMatchObject({ state: "talking", confirmedState: "talking" });
    expect(back.respondedAt).toBeLessThanOrEqual(back.doneAt - 5);
    expect(h.session(sessionId).state).toBe("talking");

    const later = await timed(sessionId, hold, "hold");
    expect(later.body).toMatchObject({ state: "held", confirmedState: "held" });
    expect(later.respondedAt).toBeLessThanOrEqual(later.doneAt - 5);
    expect(h.telnyx.of("conference:hold")).toHaveLength(2);
  });

  it("with every web hold switch, the first hold answers after two provider commands and no configuration read", async () => {
    const sessionId = await talking(true, { hold_lean_context: true, hold_join_with_hold: true });
    const first = await timed(sessionId, hold, "hold");
    expect(first.body).toMatchObject({ state: "held", confirmedState: "held" });
    expect(h.telnyx.of("conference:hold")).toHaveLength(0);
    expect(h.telnyx.of("conference:join").at(-1)!.params).toMatchObject({ hold: true });
    // 30 waves to the answer with every switch off (contract-two-command-cost).
    expect(first.respondedAt).toBeLessThanOrEqual(17);
  });

  it("on: without after() nothing would keep the tail alive, so it answers after the whole run", async () => {
    const sessionId = await talking(true);
    deferred.unavailable = true;
    const first = await timed(sessionId, hold, "hold");
    expect(first.result.status).toBe(200);
    expect(first.body).toMatchObject({ state: "held", confirmedState: "held" });
    expect(first.holdEntryAtResponse).toBe(false);
    expect(h.callEvents(sessionId).some(row => row.event_type === "app.hold" && row.handled_status === "processed")).toBe(true);
  });

  it("on: a refused hold is answered as before, with no early answer", async () => {
    const sessionId = await talking(true);
    await timed(sessionId, hold, "hold");
    await timed(sessionId, unhold, "unhold");
    h.telnyx.failNext("conference:hold", new TelnyxCommandError({ code: "90000", status: 422, detail: "refused" }));
    const refused = await timed(sessionId, hold, "hold");
    expect(refused.result.status).toBe(502);
    expect(refused.body).not.toHaveProperty("confirmedState");
    expect(h.session(sessionId).state).toBe("talking");
  });

  it("on: a hold waiting for its action prompt is not confirmed early", async () => {
    vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "true");
    const sessionId = await talking(true);
    const prompted = await timed(sessionId, hold, "hold");
    expect(prompted.result.status).toBe(200);
    expect(prompted.body).not.toHaveProperty("confirmedState");
    expect(prompted.body.state).not.toBe("held");
    expect(h.telnyx.of("conference:hold")).toHaveLength(0);
  });

  it("on: bookkeeping that fails after the answer leaves the durable entry for recovery", async () => {
    const sessionId = await talking(true);
    await timed(sessionId, hold, "hold");
    await timed(sessionId, unhold, "unhold");
    h.db.failNext("motorist_apply_critical_v2", "rpc", { code: "08006", message: "connection lost", details: null, hint: null });
    const answered = await timed(sessionId, hold, "hold");
    expect(answered.body).toMatchObject({ state: "held", confirmedState: "held" });
    // The provider has the hold; the entry that records it is still owed.
    expect(h.telnyx.of("conference:hold")).toHaveLength(2);
    const entry = readPendingEffects(h.session(sessionId) as SessionRow).entries.find(item => item.event.kind === "app" && item.event.type === "hold");
    expect(entry && entry.commands.every(command => entry.completedCommands.includes(commandKey(command)))).toBe(true);
    expect(entry?.lastError).toBeTruthy();
  });
});
