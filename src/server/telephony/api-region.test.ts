import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { createFakeSupabase } from "@/test/fake-supabase";
import { registerContractTwoRpcs } from "@/test/fake-stability";
import { FAKE_TELNYX_ENV } from "@/test/fake-telnyx";
import { CONNECTION_ID, createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import { addCallParty, blindTransfer, callColleague, createRateLimiter, hangupCall, holdCall, startConsult, startOutboundCall, unholdCall, type CallActor } from "./call-actions";
import { reconcileBrowserCall } from "./call-reconciliation";
import { reconcileWithTelnyx } from "./cron-jobs";
import { defaultLatencyFlags, type LatencyFlags } from "./latency-flags";
import { sessionOwnership, type Ownership } from "./ownership";
import { fetchTelnyxRecording, recordingApiBaseUrl, RecordingProcessingError, type RecordingJobContext } from "./recording-jobs";
import { refreshRecordingSource } from "./recording-storage";
import { ownedSessionWork } from "./session-runner";
import { readMeta, type SessionRow } from "./state/types";
import { CLOUDFLARE_SIGNATURE_BANNED_CODE, createTelnyxClient, TelnyxCommandError, type TelnyxRequestLog } from "./telnyx/client";
import { encodeClientState } from "./telnyx/client-state";
import { getTelnyxConfig } from "./telnyx/env";
import { createTelnyxRequestLogger } from "./telnyx/request-telemetry";

/**
 * Call-speed S5: the Telnyx EU API (`api.telnyx.eu`), pinned per session.
 *
 * Telnyx processes a call or conference in the region whose API created it,
 * and a call created through `.eu` must be controlled through `.eu`. So a
 * session we create freezes `start_mode.apiRegion` from `api_region`, every
 * call and conference command under its ownership goes there, unowned callers
 * pass it explicitly, and inbound calls (created by Telnyx) stay `us`.
 */

const US = "https://telnyx.test/v2";
const EU = "https://api.telnyx.eu/v2";
const o1: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Jana" };

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function json(status: number, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

function realClient(respond: (url: string, init?: RequestInit) => Response = () => json(200, { data: { result: "ok", call_control_id: "leg", id: "conference", token: "jwt" } }),
  env: Record<string, string> = FAKE_TELNYX_ENV) {
  const logs: TelnyxRequestLog[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init));
  const client = createTelnyxClient({ config: getTelnyxConfig(env), liveGate: { callsEnabled: true, smsEnabled: true }, fetch, onRequest: entry => { logs.push(entry); } });
  return { client, fetch, logs, urls: () => fetch.mock.calls.map(([input]) => String(input)) };
}

function owner(region?: "us" | "eu"): Ownership {
  const now = Date.now();
  // Contract 1: no journal, so the routing is all that is exercised.
  return { admin: {} as Ownership["admin"], sessionId: "session", organizationId: ORG, token: "token", generation: 1, contract: 1,
    deadline: now + 60_000, acquiredAt: now, ...(region ? { providerRegion: region } : {}) };
}

describe("API region of each request (real client)", () => {
  it("sends every call and conference command of an EU session to api.telnyx.eu, account-level calls to the default", async () => {
    const { client, urls, logs } = realClient();
    await sessionOwnership.run(owner("eu"), async () => {
      await client.dial({ commandId: "dial", to: NUMBERS.customer, from: NUMBERS.allianz });
      await client.bridge({ callControlId: "a", targetCallControlId: "b", commandId: "bridge" });
      await client.hangup({ callControlId: "a", commandId: "hangup" });
      await client.transfer({ callControlId: "a", commandId: "transfer", to: NUMBERS.external });
      await client.createConference({ commandId: "conference", callControlId: "a", name: "c" });
      await client.conferenceAction("conference", "join", { call_control_id: "b", commandId: "join" });
      await client.conferenceAction("conference", "hold", { call_control_ids: ["b"] });
      await client.request("GET", "/conferences/conference/participants");
      // An owned session's frozen region wins over a caller's explicit one.
      await client.retrieveCall("a", { region: "us" });
      await client.mintCredentialToken("credential");
      await client.listPhoneNumbers();
      await client.sendMessage({ to: NUMBERS.customer, text: "x", from: "+421232408718" });
    });
    expect(urls()).toEqual([
      `${EU}/calls`, `${EU}/calls/a/actions/bridge`, `${EU}/calls/a/actions/hangup`, `${EU}/calls/a/actions/transfer`,
      `${EU}/conferences`, `${EU}/conferences/conference/actions/join`, `${EU}/conferences/conference/actions/hold`,
      `${EU}/conferences/conference/participants`, `${EU}/calls/a`,
      `${US}/telephony_credentials/credential/token`, `${US}/phone_numbers?page%5Bsize%5D=100`, `${US}/messages`,
    ]);
    // The telnyx-http line names the region, so TEST can compare headersMs per command.
    expect(logs.map(entry => entry.region)).toEqual([...Array(9).fill("eu"), "us", "us", "us"]);
  });

  it("keeps a `us` session on the default host, whatever a caller passes", async () => {
    const { client, urls } = realClient();
    await sessionOwnership.run(owner("us"), async () => {
      await client.bridge({ callControlId: "a", targetCallControlId: "b", commandId: "bridge" });
      await client.retrieveCall("a", { region: "eu" });
      await client.request("GET", "/conferences/c", { region: "eu" });
    });
    // An ownership without a region (built outside `ownedSessionWork`) is `us` too.
    await sessionOwnership.run(owner(), () => client.hangup({ callControlId: "a", commandId: "hangup" }));
    expect(urls()).toEqual([`${US}/calls/a/actions/bridge`, `${US}/calls/a`, `${US}/conferences/c`, `${US}/calls/a/actions/hangup`]);
  });

  it("lets an unowned caller pass its session's region, and defaults to the default host", async () => {
    const { client, urls } = realClient();
    await client.retrieveCall("a");
    await client.retrieveCall("a", { region: "eu" });
    await client.request("GET", "/conferences/c", { region: "eu" });
    await client.request("GET", "conferences/c", { region: "eu" });
    // Account-level resources are global: never moved by a region.
    await client.request("GET", "/telephony_credentials/c", { region: "eu" });
    expect(urls()).toEqual([`${US}/calls/a`, `${EU}/calls/a`, `${EU}/conferences/c`, `${EU}/conferences/c`, `${US}/telephony_credentials/c`]);
  });

  it("honours TELNYX_EU_API_BASE_URL", async () => {
    const { client, urls } = realClient(undefined, { ...FAKE_TELNYX_ENV, TELNYX_EU_API_BASE_URL: "https://eu.telnyx.test/v2/" });
    await client.retrieveCall("a", { region: "eu" });
    expect(urls()).toEqual(["https://eu.telnyx.test/v2/calls/a"]);
  });
});

describe("the TEST guard's own conference read", () => {
  const TEST_ENV = {
    MOTORIST_APP_ENV: "test", MOTORIST_TEST_LIVE_INTEGRATIONS: "true", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
    VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk",
    SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
    MOTORIST_TEST_ALLOWED_NUMBERS: "+421900000001", MOTORIST_TEST_FROM_NUMBERS: "+421200000001",
    TELNYX_API_KEY: "fake-test-key", TELNYX_CALL_CONTROL_APP_ID: "test-app", TELNYX_CREDENTIAL_CONNECTION_ID: "test-connection",
  };
  const respond = (url: string, init?: RequestInit) => json(200, { data: init?.method === "GET" ? { connection_id: "test-app" } : { result: "ok" } });

  it.each([["eu", "https://api.telnyx.eu/v2"], ["us", "https://api.telnyx.com/v2"]] as const)("reads a %s session's conference in that region before acting on it", async (region, base) => {
    const owned = realClient(respond, TEST_ENV);
    await sessionOwnership.run(owner(region), () => owned.client.conferenceAction("conference", "hold", { call_control_ids: [] }));
    expect(owned.fetch.mock.calls.map(([input, init]) => `${init?.method} ${String(input)}`))
      .toEqual([`GET ${base}/conferences/conference`, `POST ${base}/conferences/conference/actions/hold`]);
    // Unowned, the caller's explicit region carries into the guard's read.
    const unowned = realClient(respond, TEST_ENV);
    await unowned.client.request("POST", "/conferences/conference/actions/hold", { body: { call_control_ids: [] }, region });
    expect(unowned.fetch.mock.calls.map(([input, init]) => `${init?.method} ${String(input)}`))
      .toEqual([`GET ${base}/conferences/conference`, `POST ${base}/conferences/conference/actions/hold`]);
  });
});

describe("the webhook TEST guard's conference read, before correlation", () => {
  const TEST_ENV = { ...FAKE_TELNYX_ENV, TELNYX_CALL_CONTROL_APP_ID: CONNECTION_ID,
    MOTORIST_APP_ENV: "test", MOTORIST_TEST_LIVE_INTEGRATIONS: "true", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
    VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co",
    APP_BASE_URL: "https://test.dispecing.linkapomoci.sk", MOTORIST_TEST_ALLOWED_NUMBERS: "+421900000001", MOTORIST_TEST_FROM_NUMBERS: "+421200000001" };
  const EU_SESSION = "00000000-0000-4000-8000-00000000c001";

  it.each([
    ["the session that owns the conference", { conference_id: "conf-eu" }, "eu"],
    ["the session named by the event's client state", { client_state: encodeClientState({ sid: EU_SESSION, role: "customer" }) }, "eu"],
    ["no known session", {}, "us"],
  ])("asks the region of %s", async (_case, extra, region) => {
    const h = createTelephonyHarness();
    h.deps.config = getTelnyxConfig(TEST_ENV);
    expect(h.deps.config.configured && h.deps.config.testSafety?.restricted).toBe(true);
    h.db.seed("motorist_call_sessions", [{ id: EU_SESSION, organization_id: ORG, direction: "outbound", state: "conference",
      conference_id: "conf-eu", metadata: { start_mode: { apiRegion: "eu" } } }]);
    const conferenceId = "conference_id" in extra ? extra.conference_id : "conf-unknown";
    await h.process(h.envelope("conference.participant.joined", { connection_id: null, conference_id: conferenceId, ...extra }));
    expect(h.telnyx.routes).toEqual([{ method: "GET", path: `/conferences/${conferenceId}`, region, sessionId: null,
      baseUrl: region === "eu" ? "https://api.telnyx.eu/v2" : "https://telnyx.test/v2" }]);
  });
});

describe("Cloudflare error 1010 on the EU host", () => {
  const banned = { title: "Error 1010: Access denied", status: 403, error_code: 1010, error_name: "browser_signature_banned", cloudflare_error: true, retryable: false };

  it.each([
    ["a JSON error", () => json(403, banned)],
    ["a plain-text error", () => json(403, "error code: 1010", { "content-type": "text/plain" })],
  ])("is a non-retryable configuration error from %s, logged as an error", async (_case, response) => {
    const logger = vi.fn();
    const fetch = vi.fn(async () => response());
    const client = createTelnyxClient({ config: getTelnyxConfig(FAKE_TELNYX_ENV), liveGate: { callsEnabled: true, smsEnabled: true }, fetch,
      onRequest: createTelnyxRequestLogger(logger), sleep: async () => { throw new Error("must not retry"); } });
    const error = await sessionOwnership.run(owner("eu"), () => client.bridge({ callControlId: "a", targetCallControlId: "b", commandId: "bridge" })).catch(failure => failure);
    expect(error).toBeInstanceOf(TelnyxCommandError);
    expect(error).toMatchObject({ code: CLOUDFLARE_SIGNATURE_BANNED_CODE, status: 403, retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(logger).toHaveBeenCalledWith(expect.objectContaining({ scope: "telnyx-http", level: "error",
      region: "eu", errorCode: CLOUDFLARE_SIGNATURE_BANNED_CODE, status: 403 })));
  });

  it("is never journalled as the dial's provider outcome, unlike a Telnyx refusal", async () => {
    const { db, admin } = createFakeSupabase();
    registerContractTwoRpcs(db);
    const now = Date.now();
    db.seed("motorist_call_sessions", [{ id: "session", organization_id: ORG, writer_contract: 2, state: "received",
      lease_token: "token", lease_generation: 1, lease_until: new Date(now + 15_000).toISOString() }]);
    const scope: Ownership = { ...owner("eu"), admin, contract: 2 };
    const outcomes = async (respond: () => Response, commandId: string) => {
      const fetch = vi.fn(async () => respond());
      const client = createTelnyxClient({ config: getTelnyxConfig(FAKE_TELNYX_ENV), liveGate: { callsEnabled: true, smsEnabled: true }, fetch });
      await expect(sessionOwnership.run(scope, () => client.dial({ commandId, to: NUMBERS.customer, from: NUMBERS.allianz }))).rejects.toBeInstanceOf(TelnyxCommandError);
      const batch = await sessionOwnership.run(scope, () => client.dialMany([{ commandId: `${commandId}-batch`, to: NUMBERS.customer, from: NUMBERS.allianz }]));
      expect(batch[0].status).toBe("rejected");
      return db.rows("motorist_provider_commands").filter(row => String(row.command_id).startsWith(commandId)).map(row => row.outcome);
    };
    // Telnyx never saw it: the entry stays open, as after a transport failure.
    expect(await outcomes(() => json(403, banned), "edge")).toEqual(["unknown", "unknown"]);
    expect(await outcomes(() => json(403, { errors: [{ code: "10010", title: "Forbidden" }] }), "telnyx")).toEqual(["rejected", "rejected"]);
  });

  it("goes out with Node's own User-Agent, never an empty or blocked one", async () => {
    const seen: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      seen.push(request.headers["user-agent"]);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: { call_control_id: "leg", is_alive: true } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2`;
      // The production wiring: no injected fetch, so the runtime's global one.
      const client = createTelnyxClient({ config: getTelnyxConfig({ ...FAKE_TELNYX_ENV, TELNYX_API_BASE_URL: base, TELNYX_EU_API_BASE_URL: base }),
        liveGate: { callsEnabled: true, smsEnabled: true } });
      await client.retrieveCall("a", { region: "eu" });
      await sessionOwnership.run(owner("eu"), () => client.hangup({ callControlId: "a", commandId: "hangup" }));
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    expect(seen).toHaveLength(2);
    for (const agent of seen) {
      expect(agent).toBeTruthy();
      expect(agent).not.toMatch(/python|urllib|^\s*$/i);
      // Measured 200 on api.telnyx.eu (Node fetch, 2 Nov 2026). Another UA needs that check again.
      expect(agent).toBe("node");
    }
  });
});

describe("session pinning (ownership)", () => {
  function seeded(metadata: Record<string, unknown>) {
    const { db, admin } = createFakeSupabase();
    registerContractTwoRpcs(db);
    db.seed("motorist_call_sessions", [{ id: "00000000-0000-4000-8000-00000000a001", organization_id: ORG, writer_contract: 2, state: "talking", lease_generation: 0, metadata }]);
    return { db, admin, id: "00000000-0000-4000-8000-00000000a001" };
  }
  const regionInside = (admin: Ownership["admin"], id: string, known?: SessionRow) =>
    ownedSessionWork({ admin, organizationId: ORG }, id, async () => sessionOwnership.getStore()?.providerRegion, { known });

  it("takes the region frozen into the session row; a row without one is `us` for good", async () => {
    const eu = seeded({ start_mode: { apiRegion: "eu" } });
    expect(await regionInside(eu.admin, eu.id)).toBe("eu");
    for (const metadata of [{}, { start_mode: { apiRegion: "us" } }, { start_mode: { concurrent: false } }, { start_mode: { apiRegion: "EU" } }]) {
      const other = seeded(metadata);
      expect(await regionInside(other.admin, other.id)).toBe("us");
    }
  });

  it("re-reads a known row that lacks metadata instead of losing the region", async () => {
    const eu = seeded({ start_mode: { apiRegion: "eu" } });
    const partial = { id: eu.id, organization_id: ORG, writer_contract: 2 } as unknown as SessionRow;
    const reads = () => eu.db.log.filter(row => row.table === "motorist_call_sessions" && row.operation === "select").length;
    const before = reads();
    expect(await regionInside(eu.admin, eu.id, partial)).toBe("eu");
    expect(reads()).toBe(before + 1);
    // A full row is used as is.
    const full = eu.db.rows("motorist_call_sessions")[0] as unknown as SessionRow;
    const after = reads();
    expect(await regionInside(eu.admin, eu.id, full)).toBe("eu");
    expect(reads()).toBe(after);
  });
});

function harness(flags: Partial<LatencyFlags> = {}) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  h.deps.latencyFlags = { ...defaultLatencyFlags(), ...flags };
  const deps = () => ({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) });
  return { h, deps };
}

let request = 0;
const requestId = () => `00000000-0000-4000-8000-${String(++request).padStart(12, "0")}`;
const regionOf = (h: TelephonyHarness, sessionId: string) => readMeta(h.session(sessionId) as SessionRow).start_mode?.apiRegion;
/** Every provider request made under this session's ownership. */
const routesOf = (h: TelephonyHarness, sessionId: string) => h.telnyx.routes.filter(route => route.sessionId === sessionId);

/** An outbound call through to both sides talking. */
async function outboundTalking(h: TelephonyHarness, deps: ReturnType<ReturnType<typeof harness>["deps"]>) {
  const call = await startOutboundCall(deps, o1, { to: NUMBERS.customer, requestId: requestId() });
  h.telnyx.physical.answered(call.operatorLegCallControlId);
  await h.legEvent(call.operatorLegCallControlId, "call.answered");
  const customer = String(h.legs(call.sessionId).find(leg => leg.role === "customer")!.telnyx_call_control_id);
  h.telnyx.physical.answered(customer);
  await h.legEvent(customer, "call.answered");
  await h.legEvent(customer, "call.bridged");
  await h.legEvent(call.operatorLegCallControlId, "call.bridged");
  expect(h.session(call.sessionId).state).toBe("talking");
  return { ...call, customer };
}

describe("an EU session end to end (fake provider)", () => {
  it("sends dial, hold, unhold, add party, conference and hangup to .eu, and so do the unowned reconcile reads", async () => {
    const { h, deps } = harness({ api_region: "eu" });
    const call = await outboundTalking(h, deps());
    expect(regionOf(h, call.sessionId)).toBe("eu");

    await completeAnnouncedAction(h, holdCall(deps(), o1, call.sessionId));
    expect(h.session(call.sessionId).state).toBe("held");
    await completeAnnouncedAction(h, unholdCall(deps(), o1, call.sessionId));
    await completeAnnouncedAction(h, addCallParty(deps(), o1, call.sessionId, { number: NUMBERS.external }));
    const party = String(h.legByNumber(call.sessionId, NUMBERS.external)!.telnyx_call_control_id);
    await h.legEvent(party, "call.answered", { direction: "outgoing" });
    expect(h.session(call.sessionId).state).toBe("conference");

    // Unowned: the browser's reconcile and the cron's reconcile pass the session's region.
    h.telnyx.setCallStatus(call.operatorLegCallControlId, { alive: true });
    expect(await reconcileBrowserCall(deps(), o1, call.sessionId, call.operatorLegCallControlId)).toMatchObject({ reason: "alive" });
    h.advance(10 * 60_000);
    await reconcileWithTelnyx({ ...deps(), reconcileIdleMs: 0 } as Parameters<typeof reconcileWithTelnyx>[0]);
    const reads = h.telnyx.routes.filter(route => route.method === "GET" && route.path.startsWith("/calls/"));
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads.every(route => route.sessionId === null && route.region === "eu" && route.baseUrl === "https://api.telnyx.eu/v2")).toBe(true);

    await hangupCall(deps(), o1, call.sessionId);
    const methods = new Set(routesOf(h, call.sessionId).map(route => route.method));
    for (const method of ["dial", "createConference", "conference:join", "conference:hold", "conference:unhold", "hangup"]) expect(methods).toContain(method);
    expect(routesOf(h, call.sessionId).filter(route => route.region !== "eu")).toEqual([]);
    expect(routesOf(h, call.sessionId).every(route => route.baseUrl === "https://api.telnyx.eu/v2")).toBe(true);
  });

  it.each([
    ["a consult", (deps: Parameters<typeof startConsult>[0], sessionId: string) => startConsult(deps, o1, sessionId, { number: NUMBERS.external }), "dial"],
    ["a blind transfer", (deps: Parameters<typeof blindTransfer>[0], sessionId: string) => blindTransfer(deps, o1, sessionId, { number: NUMBERS.external }), "transfer"],
  ])("sends %s to .eu", async (_case, action, method) => {
    const { h, deps } = harness({ api_region: "eu" });
    const call = await outboundTalking(h, deps());
    const from = routesOf(h, call.sessionId).length;
    await completeAnnouncedAction(h, action(deps(), call.sessionId));
    const routes = routesOf(h, call.sessionId);
    expect(routes.slice(from).map(route => route.method)).toContain(method);
    expect(routes.every(route => route.region === "eu")).toBe(true);
  });

  it("dials and bridges a colleague call in .eu", async () => {
    const { h, deps } = harness({ api_region: "eu" });
    const call = await callColleague(deps(), o1, { targetProfileId: PROFILES.o2, requestId: requestId() });
    expect(regionOf(h, call.sessionId)).toBe("eu");
    h.telnyx.physical.answered(call.operatorLegCallControlId);
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    const target = String(h.openLegFor(call.sessionId, PROFILES.o2)!.telnyx_call_control_id);
    h.telnyx.physical.answered(target);
    await h.legEvent(target, "call.answered");
    expect(routesOf(h, call.sessionId).map(route => route.method)).toEqual(expect.arrayContaining(["dial", "bridge"]));
    expect(routesOf(h, call.sessionId).every(route => route.region === "eu")).toBe(true);
  });

  it("keeps a `us` session on `us` after the flag flips, while the next session starts in .eu", async () => {
    const { h, deps } = harness({ api_region: "us" });
    const before = await startOutboundCall(deps(), o1, { to: NUMBERS.customer, requestId: requestId() });
    h.deps.latencyFlags = { ...defaultLatencyFlags(), api_region: "eu" };
    vi.stubEnv("TELEPHONY_LATENCY_FLAGS", JSON.stringify({ api_region: "eu" }));
    h.telnyx.physical.answered(before.operatorLegCallControlId);
    await h.legEvent(before.operatorLegCallControlId, "call.answered");
    const customer = String(h.legs(before.sessionId).find(leg => leg.role === "customer")!.telnyx_call_control_id);
    h.telnyx.physical.answered(customer);
    await h.legEvent(customer, "call.answered");
    await h.legEvent(customer, "call.bridged");
    await h.legEvent(before.operatorLegCallControlId, "call.bridged");
    await completeAnnouncedAction(h, holdCall(deps(), o1, before.sessionId));
    await hangupCall(deps(), o1, before.sessionId);
    expect(regionOf(h, before.sessionId)).toBe("us");
    expect(routesOf(h, before.sessionId).length).toBeGreaterThanOrEqual(4);
    expect(routesOf(h, before.sessionId).every(route => route.region === "us" && route.baseUrl === "https://telnyx.test/v2")).toBe(true);

    const after = await startOutboundCall(deps(), { ...o1, profileId: PROFILES.o2, displayName: "Peter" }, { to: NUMBERS.customer, requestId: requestId() });
    expect(regionOf(h, after.sessionId)).toBe("eu");
    expect(routesOf(h, after.sessionId).map(route => route.region)).toEqual(["eu"]);
  });

  it("keeps an inbound session on `us` whatever the flag says", async () => {
    const { h, deps } = harness({ api_region: "eu" });
    const call = await h.inbound({ to: NUMBERS.allianz });
    const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    await h.legEvent(winner, "call.answered");
    await completeAnnouncedAction(h, holdCall(deps(), o1, call.sessionId));
    await hangupCall(deps(), o1, call.sessionId);
    expect(regionOf(h, call.sessionId)).toBe("us");
    const routes = routesOf(h, call.sessionId);
    expect(routes.map(route => route.method)).toEqual(expect.arrayContaining(["answer", "dial", "createConference", "hangup"]));
    expect(routes.every(route => route.region === "us")).toBe(true);
  });
});

describe("recording provider host", () => {
  function context(metadata: Record<string, unknown> | null, sessionId: string | null = "00000000-0000-4000-8000-00000000b001") {
    const { db, admin } = createFakeSupabase();
    if (metadata) db.seed("motorist_call_sessions", [{ id: "00000000-0000-4000-8000-00000000b001", organization_id: ORG, metadata }]);
    const recording = { id: "recording-row", organization_id: ORG, session_id: sessionId, provider_recording_id: "recording", provider_session_id: null };
    const ctx = { admin, organizationId: ORG, recording, signal: AbortSignal.timeout(5_000), job: { lease_token: "lease", checkpoint: {} } } as unknown as RecordingJobContext;
    return { db, ctx };
  }

  it("follows the recording's session region; no session or no frozen region is the default host", async () => {
    vi.stubEnv("TELNYX_API_KEY", "synthetic");
    expect(await recordingApiBaseUrl(context({ start_mode: { apiRegion: "eu" } }).ctx)).toBe("https://api.telnyx.eu/v2");
    expect(await recordingApiBaseUrl(context({ start_mode: { apiRegion: "us" } }).ctx)).toBe("https://api.telnyx.com/v2");
    expect(await recordingApiBaseUrl(context({}).ctx)).toBe("https://api.telnyx.com/v2");
    const unbound = context(null, null);
    expect(await recordingApiBaseUrl(unbound.ctx)).toBe("https://api.telnyx.com/v2");
    expect(unbound.db.log).toEqual([]);
  });

  it("fails a step for a retry rather than guess when the session cannot be read", async () => {
    const { db, ctx } = context({ start_mode: { apiRegion: "eu" } });
    db.failNext("motorist_call_sessions", "select", "connection reset");
    const error = await recordingApiBaseUrl(ctx).catch(failure => failure);
    expect(error).toBeInstanceOf(RecordingProcessingError);
    expect(error).toMatchObject({ code: "recording_region_unavailable", retryable: true });
  });

  function production() {
    vi.stubEnv("TELNYX_API_KEY", "synthetic");
    vi.stubEnv("MOTORIST_APP_ENV", "production"); vi.stubEnv("VERCEL_GIT_COMMIT_REF", "main");
    vi.stubEnv("APP_BASE_URL", "https://dispecing.linkapomoci.sk");
    for (const key of ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]) vi.stubEnv(key, "https://ifpaeegaesdmljfkdvcn.supabase.co");
  }

  it("reports a Cloudflare 1010 on a recording request as its own configuration error, logged", async () => {
    production();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => json(403, { error_code: 1010, error_name: "browser_signature_banned" })));
    const failure = await refreshRecordingSource(context({ start_mode: { apiRegion: "eu" } }).ctx).catch(error => error);
    expect(failure).toBeInstanceOf(RecordingProcessingError);
    expect(failure).toMatchObject({ code: CLOUDFLARE_SIGNATURE_BANNED_CODE, retryable: false });
    vi.stubGlobal("fetch", vi.fn(async () => json(403, "error code: 1010", { "content-type": "text/plain" })));
    await expect(fetchTelnyxRecording(context({ start_mode: { apiRegion: "eu" } }).ctx, "recording", { method: "DELETE" }))
      .rejects.toMatchObject({ code: CLOUDFLARE_SIGNATURE_BANNED_CODE });
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { scope: "recording", level: "error", code: CLOUDFLARE_SIGNATURE_BANNED_CODE, method: "GET", host: "api.telnyx.eu" },
      { scope: "recording", level: "error", code: CLOUDFLARE_SIGNATURE_BANNED_CODE, method: "DELETE", host: "api.telnyx.eu" },
    ]);
    // A refusal from Telnyx itself keeps today's meaning.
    vi.stubGlobal("fetch", vi.fn(async () => json(403, { errors: [{ code: "10010", title: "Forbidden" }] })));
    await expect(refreshRecordingSource(context({ start_mode: { apiRegion: "eu" } }).ctx)).rejects.toMatchObject({ code: "recording_refresh_failed" });
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it("fetches an EU session's recording metadata from .eu on the production path", async () => {
    production();
    const fetch = vi.fn(async () => json(200, { data: { id: "recording", status: "completed", download_urls: { wav: "https://recordings.telnyx.com/audio" } } }));
    vi.stubGlobal("fetch", fetch);
    await expect(refreshRecordingSource(context({ start_mode: { apiRegion: "eu" } }).ctx)).resolves.toBe("https://recordings.telnyx.com/audio");
    expect((fetch.mock.calls as unknown as Array<[string]>).map(([url]) => url)).toEqual(["https://api.telnyx.eu/v2/recordings/recording"]);
  });
});
