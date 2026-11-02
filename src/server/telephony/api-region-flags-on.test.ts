import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TelephonyHarness } from "@/test/telephony-harness";

import { envLatencyFlags, sessionApiRegion } from "./latency-flags";

/**
 * The start, recovery, hangup, pause and callback contracts again with
 * `api_region: "eu"` (call-speed S5): every session these suites create
 * through the application freezes `.eu`, so the whole state machine runs
 * against the EU base URL, while an inbound call stays `us`.
 *
 * After each test, every provider request made under a session's ownership is
 * checked against the region frozen into that session's row: a command that
 * left a session's region would fail the test it happened in.
 */
const ON = { api_region: "eu" };
beforeEach(() => { vi.stubEnv("TELEPHONY_LATENCY_FLAGS", JSON.stringify(ON)); });

const seen = vi.hoisted(() => ({ harnesses: [] as TelephonyHarness[], eu: 0, us: 0, euSessions: new Set<string>(), inbound: 0, unownedReads: 0 }));
vi.mock("@/test/telephony-harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/test/telephony-harness")>();
  return { ...actual, createTelephonyHarness: (...args: Parameters<typeof actual.createTelephonyHarness>) => {
    const h = actual.createTelephonyHarness(...args);
    seen.harnesses.push(h);
    return h;
  } };
});

afterEach(() => {
  for (const h of seen.harnesses.splice(0)) {
    const sessions = new Map(h.rows("motorist_call_sessions").map(row => [String(row.id), row]));
    for (const row of sessions.values()) {
      const startMode = (row.metadata as { start_mode?: { apiRegion?: string } } | null)?.start_mode;
      if (!startMode) continue;
      // Telnyx created an inbound call; only sessions we create follow the flag.
      if (row.direction === "inbound") { expect(startMode.apiRegion).toBe("us"); seen.inbound += 1; }
    }
    const legs = h.rows("motorist_call_legs");
    // An unowned provider read (reconcile, the TEST guard) names its session
    // only through the leg or conference it asks about. Unowned commands occur
    // only in suites whose rows predate writer contracts, which production
    // never has; they are not checked.
    const unownedRead = (path: string) => {
      const [, kind, id] = /^\/(calls|conferences)\/([^/]+)/.exec(path) ?? [];
      const key = id ? decodeURIComponent(id) : null;
      if (kind === "calls") return sessions.get(String(legs.find(leg => leg.telnyx_call_control_id === key)?.session_id));
      return kind === "conferences" ? [...sessions.values()].find(row => row.conference_id === key) : undefined;
    };
    for (const route of h.telnyx.routes) {
      const row = route.sessionId ? sessions.get(route.sessionId) : route.method === "GET" ? unownedRead(route.path) : undefined;
      if (!row) continue;
      if (!route.sessionId) seen.unownedReads += 1;
      expect(`${route.method} ${route.path} ${route.region}`).toBe(`${route.method} ${route.path} ${sessionApiRegion(row.metadata)}`);
      if (route.region === "eu") { seen.eu += 1; seen.euSessions.add(String(row.id)); expect(route.baseUrl).toBe("https://api.telnyx.eu/v2"); }
      else seen.us += 1;
    }
  }
});

describe("API region switch", () => {
  it("is on for every suite below", () => {
    expect(envLatencyFlags(process.env)).toMatchObject(ON);
  });
});

afterAll(() => {
  // The suites below really ran sessions in .eu, command by command...
  // (45 sessions and 154 commands when written; the margin absorbs edits to those suites.)
  expect(seen.euSessions.size).toBeGreaterThan(30);
  expect(seen.unownedReads).toBeGreaterThan(0);
  expect(seen.eu).toBeGreaterThan(100);
  // ...and inbound calls among them stayed `us`.
  expect(seen.inbound).toBeGreaterThan(20);
});

// Their only root-level setup is an `afterEach` that restores the environment
// this file's `beforeEach` sets again for the next test. The start contracts
// (as `start-flags-on.test.ts`), then the contract-2 outbound and colleague
// journeys, whose commands run under each session's ownership.
await import("./initial-call-operation.test");
await import("./colleague-call.test");
await import("./state/outbound-direct.test");
await import("./hangup-acceptance.test");
await import("./session-contention.test");
await import("./callbacks-v1.test");
await import("./state/dispatch-pause-boundaries.test");
await import("./own-leg-request-header.test");
await import("./mobile-calling.test");
await import("./call-setup-latency.test");
await import("./start-fast-path.test");
await import("./internal-lean-path.test");
await import("./lean-answer-context.test");
await import("./bridged-observation.test");
await import("./state/colleague-application-endpoints.test");
