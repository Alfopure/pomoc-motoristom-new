import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TelephonyHarness } from "@/test/telephony-harness";

import { envLatencyFlags, latencyFlagsOf } from "./latency-flags";
import { decodeClientState } from "./telnyx/client-state";
import { telnyxSipUsername } from "./state/types";

/** The expected address, spelled out independently of the builder under test. */
const expected = (user: string, domain: "com" | "eu") => `sip:${user}@sip.telnyx.${domain}`;

/**
 * Outbound, colleague, mobile, transfer, consult and termination journeys
 * again with `api_region: "eu"` and `sip_domain: "eu"` on a TEST deployment
 * (call-speed S5 SIP-domain spike; only `test` may freeze it, and only for a
 * session we create in `eu`). Inbound calls never get it.
 *
 * Both switches are forced on wherever the application reads its flags
 * (`latencyFlagsOf`), so a suite that sets its own (`h.deps.latencyFlags = …`
 * or `{ ...deps, latencyFlags }`) keeps them with these two on. Every suite
 * below creates outbound or colleague sessions, and `afterAll` requires each
 * one to have run at least one of them in `eu`.
 *
 * After each test, every SIP-credential destination the application sent to
 * Telnyx (a dial or a transfer) and every operator leg it recorded is checked
 * against the domain frozen into its session, and every ring fan-out (inbound
 * only) against `com`: a URI on the other domain fails the test it happened
 * in. The suites' own assertions then prove that what reads those addresses
 * back accepts `eu`.
 */
const ON = { api_region: "eu", sip_domain: "eu" } as const;
beforeEach(() => {
  vi.stubEnv("TELEPHONY_LATENCY_FLAGS", JSON.stringify(ON));
  vi.stubEnv("MOTORIST_APP_ENV", "test");
});

vi.mock("./latency-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./latency-flags")>();
  return { ...actual, latencyFlagsOf: (deps: Parameters<typeof actual.latencyFlagsOf>[0]) => ({ ...actual.latencyFlagsOf(deps), ...ON }) };
});

type SuiteSeen = { created: number; eu: number };
const seen = vi.hoisted(() => ({ harnesses: [] as TelephonyHarness[], suites: new Map<string, SuiteSeen>(), eu: new Map<string, number>(),
  com: 0, ring: 0, inbound: 0, legs: 0 }));
vi.mock("@/test/telephony-harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/test/telephony-harness")>();
  return { ...actual, createTelephonyHarness: (...args: Parameters<typeof actual.createTelephonyHarness>) => {
    const h = actual.createTelephonyHarness(...args);
    seen.harnesses.push(h);
    return h;
  } };
});

afterEach(() => {
  // The suite is the outermost describe below, named after its file.
  const suite = expect.getState().currentTestName?.split(" > ")[0] ?? "";
  const counts = seen.suites.get(suite) ?? { created: 0, eu: 0 };
  seen.suites.set(suite, counts);
  for (const h of seen.harnesses.splice(0)) {
    const sessions = new Map(h.rows("motorist_call_sessions").map(row => [String(row.id), row]));
    // The domain frozen into the row (a suite's own `afterEach` has already restored the environment `sessionSipDomain` reads).
    const frozenDomain = (row: { metadata?: unknown }) => (row.metadata as { start_mode?: { sipDomain?: string } } | null)?.start_mode?.sipDomain === "eu" ? "eu" : "com";
    for (const row of sessions.values()) {
      const startMode = (row.metadata as { start_mode?: { apiRegion?: string; sipDomain?: string } } | null)?.start_mode;
      if (!startMode) continue;
      // Telnyx created an inbound call; only a session we create in `eu` may dial `sip.telnyx.eu`.
      if (row.direction === "inbound") { expect(startMode).not.toHaveProperty("sipDomain"); seen.inbound += 1; continue; }
      counts.created += 1;
      if (startMode.sipDomain !== undefined) {
        expect([startMode.apiRegion, startMode.sipDomain]).toEqual(["eu", "eu"]);
        counts.eu += 1;
      }
    }
    // What the application sent: the dial's or the transfer's own client state names its session.
    for (const { method, params } of h.telnyx.calls) {
      if (method !== "dial" && method !== "transfer") continue;
      const username = telnyxSipUsername(params.to);
      if (!username) continue;
      const state = decodeClientState(method === "dial" ? params.clientState : params.targetLegClientState);
      const row = state ? sessions.get(state.sid) : undefined;
      if (!row) continue;
      const domain = frozenDomain(row);
      const kind = `${method}:${state!.intent ?? state!.role}`;
      expect(`${kind} → ${String(params.to)}`).toBe(`${kind} → ${expected(username, domain)}`);
      // Ring fan-out serves inbound calls only, so it never reaches `eu`.
      if (state!.intent === "ring") { expect(params.to).toBe(expected(username, "com")); seen.ring += 1; }
      if (domain === "eu") seen.eu.set(kind, (seen.eu.get(kind) ?? 0) + 1);
      else seen.com += 1;
    }
    // What it recorded: every leg to a credential carries its session's domain.
    for (const leg of h.rows("motorist_call_legs")) {
      const username = telnyxSipUsername(leg.to_number);
      const row = sessions.get(String(leg.session_id));
      if (!username || !row) continue;
      expect(leg.to_number, `leg ${String(leg.telnyx_call_control_id)}`).toBe(expected(username, frozenDomain(row)));
      seen.legs += 1;
    }
  }
});

// Suites that create outbound or colleague sessions and whose assertions do not
// spell `sip.telnyx.com` themselves (those pin today's default and keep running
// in the ordinary pass). Inbound-only suites (hangup-acceptance,
// session-contention, transfer-music, park-control-progress, termination,
// termination-priority, transfer-to-mobile, consult-mobile-presence) create no
// session that could freeze `eu`, so they add nothing here.
const SUITES: Array<[string, () => Promise<unknown>]> = [
  ["state/outbound-direct", () => import("./state/outbound-direct.test")],
  ["callbacks-v1", () => import("./callbacks-v1.test")],
  ["state/dispatch-pause-boundaries", () => import("./state/dispatch-pause-boundaries.test")],
  ["own-leg-request-header", () => import("./own-leg-request-header.test")],
  ["mobile-calling", () => import("./mobile-calling.test")],
  ["call-setup-latency", () => import("./call-setup-latency.test")],
  ["internal-lean-path", () => import("./internal-lean-path.test")],
  ["lean-answer-context", () => import("./lean-answer-context.test")],
  ["bridged-observation", () => import("./bridged-observation.test")],
  ["conference-departure", () => import("./conference-departure.test")],
  ["call-reconciliation", () => import("./call-reconciliation.test")],
  ["outbound-pickup-context", () => import("./outbound-pickup-context.test")],
];

describe("SIP-domain switch", () => {
  it("is on for every suite below, also where a suite sets its own flags", () => {
    expect(envLatencyFlags(process.env)).toMatchObject(ON);
    expect(latencyFlagsOf({ latencyFlags: { ...envLatencyFlags({}), api_region: "us", sip_domain: "com" } })).toMatchObject(ON);
  });
});

for (const [name, load] of SUITES) describe(name, async () => { await load(); });

afterAll(() => {
  // Each suite really ran sessions in `eu`, not only inbound calls or defaults.
  const report = Object.fromEntries(SUITES.map(([name]) => [name, seen.suites.get(name) ?? { created: 0, eu: 0 }]));
  for (const [name] of SUITES) expect(report[name].eu, `${name} in ${JSON.stringify(report)}`).toBeGreaterThan(0);
  // Own legs, colleague endpoints and pickups went to `sip.telnyx.eu` (transfers,
  // consults, parties and supervisors in an `eu` session: `sip-domain.test.ts`).
  const kinds = Object.fromEntries([...seen.eu].sort());
  for (const kind of ["dial:outbound", "dial:internal_caller", "dial:internal", "dial:pickup"]) {
    expect(kinds[kind] ?? 0, `${kind} in ${JSON.stringify(kinds)}`).toBeGreaterThan(0);
  }
  // Inbound calls among them stayed on `com`, and so did their ring fan-out.
  expect(seen.inbound).toBeGreaterThan(20);
  expect(seen.ring).toBeGreaterThan(20);
  expect(seen.legs).toBeGreaterThan(100);
});
