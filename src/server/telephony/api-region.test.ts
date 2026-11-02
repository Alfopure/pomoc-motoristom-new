import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultAnnouncementConfig } from "@/lib/telephony/announcements";
import { completeAnnouncedAction, completeCallAnnouncements } from "@/test/complete-call-announcements";
import { createFakeSupabase } from "@/test/fake-supabase";
import { registerContractTwoRpcs } from "@/test/fake-stability";
import { FAKE_TELNYX_ENV } from "@/test/fake-telnyx";
import { CONNECTION_ID, createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import { addCallParty, blindTransfer, callColleague, createRateLimiter, hangupCall, holdCall, startConsult, startOutboundCall, stopCallRecording, superviseCall, unholdCall, type CallActor } from "./call-actions";
import { reconcileBrowserCall } from "./call-reconciliation";
import { reconcileWithTelnyx } from "./cron-jobs";
import { clearLatencyFlagsCache, defaultLatencyFlags, readLatencyFlags, type LatencyFlags } from "./latency-flags";
import { sessionOwnership, type Ownership } from "./ownership";
import { fetchTelnyxRecording, RecordingProcessingError, type RecordingJobContext } from "./recording-jobs";
import { deleteRecordingJob } from "./recording-processing";
import { refreshRecordingSource } from "./recording-storage";
import { effectsDeps, ownedSessionWork } from "./session-runner";
import { cancelRevokedOffers } from "./state/cancelled-offers";
import { reconcileTermination } from "./termination";
import { readMeta, type SessionRow } from "./state/types";
import { SessionLeaseLostError } from "./service-errors";
import { CLOUDFLARE_SIGNATURE_BANNED_CODE, confirmEuLegEnded, createTelnyxClient, EU_LEG_CONFIRM_TIMEOUT_MS, isSessionCallGoneError, TelnyxCommandError, type TelnyxRequestLog } from "./telnyx/client";
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

  it("recognises Cloudflare's HTML 1010 page", async () => {
    const page = "<!DOCTYPE html><html><head><title>Access denied | api.telnyx.eu used Cloudflare to restrict access</title></head>" +
      "<body><h1><span>Error</span><span>1010</span></h1><p>The owner of this website (api.telnyx.eu) has banned your access based on your browser's signature.</p></body></html>";
    const { client } = realClient(() => json(403, page, { "content-type": "text/html" }));
    await expect(sessionOwnership.run(owner("eu"), () => client.hangup({ callControlId: "a", commandId: "hangup" }))).rejects.toMatchObject({ code: CLOUDFLARE_SIGNATURE_BANNED_CODE });
  });

  it("leaves the default .com path exactly as before: a 403 there is an ordinary refusal", async () => {
    const { db, admin } = createFakeSupabase();
    registerContractTwoRpcs(db);
    db.seed("motorist_call_sessions", [{ id: "session", organization_id: ORG, writer_contract: 2, state: "received",
      lease_token: "token", lease_generation: 1, lease_until: new Date(Date.now() + 15_000).toISOString() }]);
    const { client, fetch } = realClient(() => json(403, banned));
    await expect(sessionOwnership.run({ ...owner("us"), admin, contract: 2 }, () => client.hangup({ callControlId: "a", commandId: "hangup" })))
      .rejects.toMatchObject({ code: "http_403", status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(db.rows("motorist_provider_commands").map(row => row.outcome)).toEqual(["rejected"]);
  });

  /** A contract-2 EU session, its ownership, and its later termination pass. */
  function terminating() {
    const { db, admin } = createFakeSupabase();
    registerContractTwoRpcs(db);
    db.seed("motorist_call_sessions", [{ id: "session", organization_id: ORG, writer_contract: 2, state: "talking",
      metadata: { start_mode: { apiRegion: "eu" } },
      lease_token: "token", lease_generation: 1, lease_until: new Date(Date.now() + 15_000).toISOString() }]);
    const scope = { ...owner("eu"), admin, contract: 2 } as Ownership;
    /** The operator ends the call: does termination still wait for a dial? */
    const terminate = () => {
      db.update("motorist_call_sessions", { termination_requested_at: new Date().toISOString() }, row => row.id === "session");
      return sessionOwnership.run(scope, () => reconcileTermination({ admin, organizationId: ORG, telnyx: null }, "session"));
    };
    // `20260929200000` lines 316-334: termination waits for every unknown dial and every accepted, uncleaned one.
    db.registerRpc("motorist_provider_termination_legs_v2", (args) => db.storage("motorist_provider_commands")
      .filter(row => row.session_id === args.p_session_id && row.path === "/calls" && row.outcome === "accepted" && !row.termination_cleanup_at)
      .map(row => ({ commandId: row.command_id, callControlId: (row.result as { data: { call_control_id: string } }).data.call_control_id })));
    db.registerRpc("motorist_provider_termination_checkpoint_v2", (args) => {
      const rows = db.storage("motorist_provider_commands").filter(row => row.session_id === args.p_session_id && row.path === "/calls");
      for (const row of rows) if ((args.p_completed_commands as string[]).includes(String(row.command_id)) && row.outcome === "accepted") row.termination_cleanup_at = new Date().toISOString();
      return { pending: rows.some(row => row.outcome === "unknown" || row.outcome === "accepted" && !row.termination_cleanup_at) };
    });
    return { db, scope, terminate };
  }

  it("journals a refused dial as refused (403), so it is not a provider outcome Telnyx gave and termination does not wait for it", async () => {
    const { db, scope, terminate } = terminating();
    const outcomes = async (respond: () => Response, commandId: string) => {
      const { client } = realClient(respond);
      const single = await sessionOwnership.run(scope, () => client.dial({ commandId, to: NUMBERS.customer, from: NUMBERS.allianz })).catch(error => error);
      const batch = await sessionOwnership.run(scope, () => client.dialMany([{ commandId: `${commandId}-batch`, to: NUMBERS.customer, from: NUMBERS.allianz }]));
      return { single, batch: batch[0].status === "rejected" ? batch[0].reason : null,
        rows: db.rows("motorist_provider_commands").filter(row => String(row.command_id).startsWith(commandId)).map(row => [row.outcome, row.http_status]) };
    };
    const edge = await outcomes(() => json(403, banned), "edge");
    for (const error of [edge.single, edge.batch]) expect(error).toMatchObject({ code: CLOUDFLARE_SIGNATURE_BANNED_CODE, status: 403, retryable: false });
    expect(edge.rows).toEqual([["rejected", 403], ["rejected", 403]]);
    // A replay of the same command gets the same configuration error back, without a second send.
    const { client, fetch } = realClient(() => { throw new Error("must not send again"); });
    await expect(sessionOwnership.run(scope, () => client.dial({ commandId: "edge", to: NUMBERS.customer, from: NUMBERS.allianz })))
      .rejects.toMatchObject({ code: CLOUDFLARE_SIGNATURE_BANNED_CODE });
    expect(fetch).not.toHaveBeenCalled();
    // ...so a non-initial dial refused at the edge leaves nothing for termination to wait for.
    expect(await terminate()).toBe(false);
  });

  it("leaves any other command refused at the edge open, as after a transport failure; a lost dial still holds termination", async () => {
    const { db, scope, terminate } = terminating();
    const { client } = realClient(() => json(403, banned));
    await expect(sessionOwnership.run(scope, () => client.hangup({ callControlId: "a", commandId: "hangup" }))).rejects.toMatchObject({ code: CLOUDFLARE_SIGNATURE_BANNED_CODE });
    expect(db.rows("motorist_provider_commands").map(row => row.outcome)).toEqual(["unknown"]);
    const lost = realClient(() => { throw new Error("socket hang up"); });
    await expect(sessionOwnership.run(scope, () => lost.client.dial({ commandId: "lost", to: NUMBERS.customer, from: NUMBERS.allianz }))).rejects.toMatchObject({ code: "network" });
    expect(await terminate()).toBe(true);
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

/** A contract-2 world on a TEST deployment, the only kind that may freeze `eu` until spike S5.0 passes. */
function harness(flags: Partial<LatencyFlags> = {}) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  vi.stubEnv("MOTORIST_APP_ENV", "test");
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

  it.each([
    ["eu", "a bare 404 (another region's answer for a live call) is a failure, not a gone leg", { code: "http_404", status: 404 }, false],
    ["eu", "Telnyx's own call-gone code still closes the leg", { code: "90018", status: 422 }, true],
    ["us", "a bare 404 keeps today's meaning: the leg is gone", { code: "http_404", status: 404 }, true],
  ] as const)("hangup in a %s session: %s", async (region, _case, failure, gone) => {
    const { h, deps } = harness({ api_region: region });
    const call = await outboundTalking(h, deps());
    expect(regionOf(h, call.sessionId)).toBe(region);
    h.telnyx.failAlways("hangup", new TelnyxCommandError({ ...failure, detail: "Resource not found" }));
    const result = await hangupCall(deps(), o1, call.sessionId).catch((error: unknown) => error);
    const hangups = h.callEvents(call.sessionId).flatMap(row => {
      const commands = (row.normalized_payload as { commands?: Array<{ kind: string; ok: boolean; skipped: boolean }> } | null)?.commands ?? [];
      return commands.filter(command => command.kind === "hangup");
    });
    expect(hangups.length).toBeGreaterThan(0);
    // Gone: the hangup is skipped as already done. Not gone: it failed and stays an obligation.
    expect(hangups.map(command => command.ok && command.skipped)).toEqual(hangups.map(() => gone));
    if (!gone) expect(result).toBeInstanceOf(Error);
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
  const SESSION = "00000000-0000-4000-8000-00000000b001";
  function context(metadata: Record<string, unknown> | null, sessionId: string | null = SESSION) {
    const { db, admin } = createFakeSupabase();
    if (metadata) db.seed("motorist_call_sessions", [{ id: SESSION, organization_id: ORG, metadata }]);
    const recording = { id: "00000000-0000-4000-8000-00000000b002", organization_id: ORG, session_id: sessionId, provider_recording_id: "recording",
      provider_session_id: null, source_revision: 1, storage_path: null };
    const ctx = { admin, organizationId: ORG, recording, recordings: [recording], signal: AbortSignal.timeout(5_000),
      job: { id: "job", kind: "delete", call_id: "00000000-0000-4000-8000-00000000b003", lease_token: "lease", checkpoint: { scope: "recording" } } } as unknown as RecordingJobContext;
    return { db, ctx };
  }
  const urls = (fetch: ReturnType<typeof vi.fn>) => (fetch.mock.calls as unknown as Array<[string, RequestInit?]>).map(([url, init]) => `${init?.method ?? "GET"} ${url}`);
  function stubFetch(respond: (url: string, init?: RequestInit) => Response = () => json(200, { data: {} })) {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => respond(String(input), init));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }
  function production() {
    vi.stubEnv("TELNYX_API_KEY", "synthetic");
    vi.stubEnv("MOTORIST_APP_ENV", "production"); vi.stubEnv("VERCEL_GIT_COMMIT_REF", "main");
    vi.stubEnv("APP_BASE_URL", "https://dispecing.linkapomoci.sk");
    for (const key of ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]) vi.stubEnv(key, "https://ifpaeegaesdmljfkdvcn.supabase.co");
  }
  /** The dedicated TEST deployment, with storage, as the recording provider safety suite sets it up. */
  function testDeployment() {
    const env = {
      MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
      VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
      SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co", NEXT_PUBLIC_SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co",
      SUPABASE_ANON_KEY: "synthetic-anon", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service",
      MOTORIST_TEST_LIVE_INTEGRATIONS: "true", MOTORIST_TEST_ALLOWED_NUMBERS: "+421900111222", MOTORIST_TEST_FROM_NUMBERS: "+421900333444",
      TELNYX_API_KEY: "synthetic", TELNYX_CALL_CONTROL_APP_ID: "test-app", TELNYX_CREDENTIAL_CONNECTION_ID: "test-sip",
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  }

  it("follows the recording's session region on TEST; no session, `us` or no frozen region is api.telnyx.com", async () => {
    vi.stubEnv("TELNYX_API_KEY", "synthetic");
    vi.stubEnv("MOTORIST_APP_ENV", "test");
    const fetch = stubFetch();
    for (const metadata of [{ start_mode: { apiRegion: "eu" } }, { start_mode: { apiRegion: "us" } }, {}]) await fetchTelnyxRecording(context(metadata).ctx, "recording", {});
    const unbound = context(null, null);
    await fetchTelnyxRecording(unbound.ctx, "recording", { method: "DELETE" });
    expect(urls(fetch)).toEqual(["GET https://api.telnyx.eu/v2/recordings/recording", "GET https://api.telnyx.com/v2/recordings/recording",
      "GET https://api.telnyx.com/v2/recordings/recording", "DELETE https://api.telnyx.com/v2/recordings/recording"]);
    expect(unbound.db.log).toEqual([]);
  });

  it.each([["production", production], ["an unreadable environment", () => { vi.stubEnv("TELNYX_API_KEY", "synthetic"); vi.stubEnv("MOTORIST_APP_ENV", "bogus"); }]])("adds no read and no failure mode in %s, where no session can be frozen to eu", async (_case, environment) => {
    environment();
    const fetch = stubFetch();
    const { db, ctx } = context({ start_mode: { apiRegion: "eu" } });
    db.failNext("motorist_call_sessions", "select", "must not be read");
    await fetchTelnyxRecording(ctx, "recording", { method: "DELETE" });
    expect(urls(fetch)).toEqual(["DELETE https://api.telnyx.com/v2/recordings/recording"]);
    expect(db.log).toEqual([]);
  });

  it("follows an EU session's recording to .eu on a local run too (it may use the TEST database), though it cannot freeze eu itself", async () => {
    vi.stubEnv("TELNYX_API_KEY", "synthetic");
    const fetch = stubFetch();
    await fetchTelnyxRecording(context({ start_mode: { apiRegion: "eu" } }).ctx, "recording", { method: "DELETE" });
    expect(urls(fetch)).toEqual(["DELETE https://api.telnyx.eu/v2/recordings/recording"]);
  });

  it("fails a step for a retry rather than guess when the session cannot be read", async () => {
    vi.stubEnv("MOTORIST_APP_ENV", "test");
    const fetch = stubFetch();
    const { db, ctx } = context({ start_mode: { apiRegion: "eu" } });
    db.failNext("motorist_call_sessions", "select", "connection reset");
    const error = await fetchTelnyxRecording(ctx, "recording", {}).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(RecordingProcessingError);
    expect(error).toMatchObject({ code: "recording_region_unavailable", retryable: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("proves and deletes an EU session's recording at api.telnyx.eu", async () => {
    testDeployment();
    const fetch = stubFetch((url, init) => url.includes("/recordings/") && (init?.method ?? "GET") === "GET"
      ? json(200, { data: { id: "recording", connection_id: "test-app" } }) : json(200, {}));
    const { ctx } = context({ start_mode: { apiRegion: "eu" } });
    await expect(deleteRecordingJob(ctx)).resolves.toMatchObject({ state: "complete" });
    expect(urls(fetch).filter(line => line.includes("telnyx"))).toEqual(["GET https://api.telnyx.eu/v2/recordings/recording", "DELETE https://api.telnyx.eu/v2/recordings/recording"]);
  });

  it("reports a Cloudflare 1010 on an EU recording request as its own configuration error, logged", async () => {
    testDeployment();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubFetch(() => json(403, { error_code: 1010, error_name: "browser_signature_banned" }));
    const failure = await refreshRecordingSource(context({ start_mode: { apiRegion: "eu" } }).ctx).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RecordingProcessingError);
    expect(failure).toMatchObject({ code: CLOUDFLARE_SIGNATURE_BANNED_CODE, retryable: false });
    stubFetch(() => json(403, "error code: 1010", { "content-type": "text/plain" }));
    await expect(fetchTelnyxRecording(context({ start_mode: { apiRegion: "eu" } }).ctx, "recording", { method: "DELETE" }))
      .rejects.toMatchObject({ code: CLOUDFLARE_SIGNATURE_BANNED_CODE });
    expect(errors.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { scope: "recording", level: "error", code: CLOUDFLARE_SIGNATURE_BANNED_CODE, method: "GET", host: "api.telnyx.eu" },
      { scope: "recording", level: "error", code: CLOUDFLARE_SIGNATURE_BANNED_CODE, method: "DELETE", host: "api.telnyx.eu" },
    ]);
  });

  it("keeps every 403 on the production .com path as before", async () => {
    production();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const body of [{ error_code: 1010, error_name: "browser_signature_banned" }, { errors: [{ code: "10010", title: "Forbidden" }] }]) {
      stubFetch(() => json(403, body));
      await expect(refreshRecordingSource(context({ start_mode: { apiRegion: "eu" } }).ctx)).rejects.toMatchObject({ code: "recording_refresh_failed" });
    }
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("an EU session's supervision, recording, termination clean-up and cancelled offers (fake provider)", () => {
  const manager: CallActor = { profileId: PROFILES.o4, role: "manager", displayName: "Manažér" };
  const regions = (h: TelephonyHarness, sessionId: string) => [...new Set(routesOf(h, sessionId).map(route => `${route.region} ${route.baseUrl}`))];

  it("dials a supervisor into an EU call through .eu", async () => {
    const { h, deps } = harness({ api_region: "eu" });
    const call = await outboundTalking(h, deps());
    const seenAt = h.now().toISOString();
    h.db.seed("motorist_operator_devices", [{ organization_id: ORG, profile_id: PROFILES.o4, environment: "development", telnyx_credential_id: "cred-900",
      sip_username: "gencred900", credential_expires_at: null, last_token_issued_at: seenAt, token_expires_at: null, device_seen_at: seenAt,
      device_session_id: "dev-900", registration_state: "registered", user_agent: "vitest", metadata: {} }]);
    await completeAnnouncedAction(h, superviseCall(deps(), manager, call.sessionId, "monitor"));
    expect(h.telnyx.of("dial").at(-1)!.params).toMatchObject({ superviseCallControlId: expect.any(String), supervisorRole: "monitor" });
    expect(regions(h, call.sessionId)).toEqual(["eu https://api.telnyx.eu/v2"]);
  });

  it("starts and stops an EU call's recording through .eu", async () => {
    const { h, deps } = harness({ api_region: "eu" });
    for (const key of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED", "TELNYX_RECORDING_CONFERENCE_VERIFIED",
      "TELNYX_RECORDING_TRANSFER_VERIFIED", "TELNYX_RECORDING_CHANNELS_VERIFIED"]) vi.stubEnv(key, "true");
    h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(),
      inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
    h.db.update("motorist_telephony_lines", { metadata: { announcements: { ...defaultAnnouncementConfig(), outboundStartAnnouncements: true } } }, () => true);
    const call = await startOutboundCall(deps(), o1, { to: NUMBERS.customer, requestId: requestId() });
    h.telnyx.physical.answered(call.operatorLegCallControlId);
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    const customer = String(h.legs(call.sessionId).find(leg => leg.role === "customer")!.telnyx_call_control_id);
    h.telnyx.physical.answered(customer);
    await h.legEvent(customer, "call.answered", { direction: "outgoing" });
    await completeCallAnnouncements(h, call.sessionId);
    expect(routesOf(h, call.sessionId).map(route => route.method)).toContain("recordingStart");
    // The stop is sent; the action itself still reports the connection's audio effects as pending here.
    await stopCallRecording(deps(), o1, call.sessionId).catch((error: unknown) => expect(error).toMatchObject({ message: expect.stringMatching(/pending/) }));
    expect(routesOf(h, call.sessionId).map(route => route.method)).toContain("recordingStop");
    expect(regions(h, call.sessionId)).toEqual(["eu https://api.telnyx.eu/v2"]);
  });

  /** An EU contract-2 session with one owned, accepted dial, as the termination pass finds it. */
  async function euSessionWithDial(h: TelephonyHarness, sessionId: string, apiRegion: "us" | "eu" = "eu") {
    h.db.seed("motorist_call_sessions", [{ id: sessionId, organization_id: ORG, direction: "outbound", state: "talking", writer_contract: 2, lease_generation: 0,
      metadata: { start_mode: { concurrent: false, autoBridge: false, ownLegTimeoutSecs: 30, apiRegion, origin: "web" } } }]);
    const dialed = await ownedSessionWork(h.deps, sessionId, () => h.telnyx.client.dial({ commandId: `${sessionId}-dial`, to: NUMBERS.customer, from: NUMBERS.allianz }));
    return dialed.callControlId;
  }

  it("hangs up an EU session's accepted legs through .eu when its termination is reconciled", async () => {
    const { h } = harness();
    const sessionId = "00000000-0000-4000-8000-00000000d001";
    const leg = await euSessionWithDial(h, sessionId);
    h.db.registerRpc("motorist_provider_termination_legs_v2", () => [{ commandId: `${sessionId}-dial`, callControlId: leg }]);
    await ownedSessionWork(h.deps, sessionId, () => reconcileTermination({ ...h.deps, telnyx: h.telnyx.client }, sessionId));
    expect(routesOf(h, sessionId).map(route => `${route.method} ${route.region}`)).toEqual(["dial eu", "hangup eu"]);
  });

  it("hangs up an EU session's revoked offer through .eu", async () => {
    const { h } = harness();
    const sessionId = "00000000-0000-4000-8000-00000000d002";
    const leg = await euSessionWithDial(h, sessionId);
    h.db.update("motorist_call_sessions", { presence_cancellations: { token: { profileId: PROFILES.o2, requestedAt: h.now().toISOString(), reason: "revoked" } } }, row => row.id === sessionId);
    h.db.seed("motorist_call_legs", [{ organization_id: ORG, session_id: sessionId, telnyx_call_control_id: leg, role: "operator", profile_id: PROFILES.o2,
      state: "ringing", client_state: { sid: sessionId, role: "operator", operatorId: PROFILES.o2, offerToken: "token" }, ended_at: null }]);
    const result = await ownedSessionWork(h.deps, sessionId, () => cancelRevokedOffers(effectsDeps(h.deps), h.session(sessionId) as SessionRow));
    expect(result).toMatchObject({ cancelled: 1, pending: 0 });
    expect(routesOf(h, sessionId).map(route => `${route.method} ${route.region}`)).toEqual(["dial eu", "hangup eu"]);
  });

  /** A refusal that names no call-gone code; only its prose reads like one. */
  const proseOnly = () => new TelnyxCommandError({ code: "http_404", status: 404, detail: "Call does not exist" });

  it("counts only Telnyx's call-gone codes as gone in an EU session; a `us` session and unowned work keep the prose match", () => {
    const ended = () => new TelnyxCommandError({ code: "90018", status: 422, detail: "Call has already ended" });
    const classify = () => [isSessionCallGoneError(proseOnly()), isSessionCallGoneError(ended()), isSessionCallGoneError(new Error("Call does not exist"))];
    expect(sessionOwnership.run(owner("eu"), classify)).toEqual([false, true, false]);
    expect(sessionOwnership.run(owner("us"), classify)).toEqual([true, true, false]);
    expect(classify()).toEqual([true, true, false]);
  });

  it.each([["eu", []], ["us", ["dial"]]] as const)("termination in a %s session completes a hangup refused only in prose: %j", async (region, completed) => {
    const { h } = harness();
    const sessionId = "00000000-0000-4000-8000-00000000d003";
    const leg = await euSessionWithDial(h, sessionId, region);
    h.db.registerRpc("motorist_provider_termination_legs_v2", () => [{ commandId: `${sessionId}-dial`, callControlId: leg }]);
    h.telnyx.failNext("hangup", proseOnly());
    await ownedSessionWork(h.deps, sessionId, () => reconcileTermination({ ...h.deps, telnyx: h.telnyx.client }, sessionId));
    const checkpoint = h.db.log.find(entry => entry.kind === "rpc" && entry.table === "motorist_provider_termination_checkpoint_v2");
    expect((checkpoint?.payload as { p_completed_commands: string[] }).p_completed_commands).toEqual(completed.map(() => `${sessionId}-dial`));
  });

  it.each([["eu", { cancelled: 0, pending: 1 }], ["us", { cancelled: 1, pending: 0 }]] as const)("a revoked offer in a %s session refused only in prose is %j", async (region, outcome) => {
    const { h } = harness();
    const sessionId = "00000000-0000-4000-8000-00000000d004";
    const leg = await euSessionWithDial(h, sessionId, region);
    h.db.update("motorist_call_sessions", { presence_cancellations: { token: { profileId: PROFILES.o2, requestedAt: h.now().toISOString(), reason: "revoked" } } }, row => row.id === sessionId);
    h.db.seed("motorist_call_legs", [{ organization_id: ORG, session_id: sessionId, telnyx_call_control_id: leg, role: "operator", profile_id: PROFILES.o2,
      state: "ringing", client_state: { sid: sessionId, role: "operator", operatorId: PROFILES.o2, offerToken: "token" }, ended_at: null }]);
    h.telnyx.failNext("hangup", proseOnly());
    const result = await ownedSessionWork(h.deps, sessionId, () => cancelRevokedOffers(effectsDeps(h.deps), h.session(sessionId) as SessionRow));
    expect(result).toMatchObject(outcome);
  });

  it.each([["eu", "command_failed"], ["us", "call_gone"]] as const)("a hold refused only in prose in a %s session reports %s", async (region, code) => {
    const { h, deps } = harness({ api_region: region });
    const call = await outboundTalking(h, deps());
    expect(regionOf(h, call.sessionId)).toBe(region);
    h.telnyx.failNext("createConference", proseOnly());
    await expect(holdCall(deps(), o1, call.sessionId)).rejects.toMatchObject({ code });
  });

  /**
   * F4: an EU hangup or recording stop refused without a call-gone code is
   * confirmed with the leg's status in its region: ended retires the
   * obligation; alive, unknown or an unreadable status keeps it.
   */
  const refused = () => new TelnyxCommandError({ code: "http_404", status: 404, detail: "Resource not found" });
  const confirmations: Array<{ leg: string; status: (h: TelephonyHarness, leg: string) => void; retired: boolean }> = [
    { leg: "ended (is_alive: false)", status: (h, leg) => h.telnyx.setCallStatus(leg, { alive: false }), retired: true },
    { leg: "still alive", status: (h, leg) => h.telnyx.setCallStatus(leg, { alive: true }), retired: false },
    { leg: "unknown there (404)", status: (h, leg) => h.telnyx.setCallStatus(leg, { alive: false, known: false }), retired: false },
    { leg: "unreadable (the GET fails)", status: (h) => h.telnyx.failNext("retrieveCall", new TelnyxCommandError({ code: "timeout", status: 504, retryable: true })), retired: false },
  ];
  const statusReads = (h: TelephonyHarness, leg: string) => h.telnyx.routes.filter(route => route.method === "GET" && route.path === `/calls/${leg}`);

  it.each(confirmations)("termination clean-up in an EU session, leg $leg: retired=$retired", async ({ status, retired }) => {
    const { h } = harness();
    const sessionId = "00000000-0000-4000-8000-00000000d005";
    const leg = await euSessionWithDial(h, sessionId);
    h.db.registerRpc("motorist_provider_termination_legs_v2", () => [{ commandId: `${sessionId}-dial`, callControlId: leg }]);
    h.telnyx.failNext("hangup", refused());
    status(h, leg);
    await ownedSessionWork(h.deps, sessionId, () => reconcileTermination({ ...h.deps, telnyx: h.telnyx.client }, sessionId));
    const checkpoint = h.db.log.find(entry => entry.kind === "rpc" && entry.table === "motorist_provider_termination_checkpoint_v2");
    expect((checkpoint?.payload as { p_completed_commands: string[] }).p_completed_commands).toEqual(retired ? [`${sessionId}-dial`] : []);
    expect(statusReads(h, leg).map(route => route.region)).toEqual(["eu"]);
  });

  it.each(confirmations)("a revoked offer in an EU session, leg $leg: retired=$retired", async ({ status, retired }) => {
    const { h } = harness();
    const sessionId = "00000000-0000-4000-8000-00000000d006";
    const leg = await euSessionWithDial(h, sessionId);
    h.db.update("motorist_call_sessions", { presence_cancellations: { token: { profileId: PROFILES.o2, requestedAt: h.now().toISOString(), reason: "revoked" } } }, row => row.id === sessionId);
    h.db.seed("motorist_call_legs", [{ organization_id: ORG, session_id: sessionId, telnyx_call_control_id: leg, role: "operator", profile_id: PROFILES.o2,
      state: "ringing", client_state: { sid: sessionId, role: "operator", operatorId: PROFILES.o2, offerToken: "token" }, ended_at: null }]);
    h.telnyx.failNext("hangup", refused());
    status(h, leg);
    const result = await ownedSessionWork(h.deps, sessionId, () => cancelRevokedOffers(effectsDeps(h.deps), h.session(sessionId) as SessionRow));
    expect(result).toMatchObject(retired ? { cancelled: 1, pending: 0 } : { cancelled: 0, pending: 1 });
    expect(statusReads(h, leg).map(route => route.region)).toEqual(["eu"]);
  });

  it.each(confirmations)("an operator's hangup in an EU session, customer leg $leg: retired=$retired", async ({ status, retired }) => {
    const { h, deps } = harness({ api_region: "eu" });
    const call = await outboundTalking(h, deps());
    h.telnyx.failAlways("hangup", refused());
    status(h, call.customer);
    status(h, call.operatorLegCallControlId);
    await hangupCall(deps(), o1, call.sessionId).catch(() => undefined);
    const hangups = h.callEvents(call.sessionId).flatMap(row =>
      ((row.normalized_payload as { commands?: Array<{ kind: string; ok: boolean; skipped: boolean }> } | null)?.commands ?? []).filter(command => command.kind === "hangup"));
    expect(hangups.length).toBeGreaterThan(0);
    expect(hangups.map(command => command.ok && command.skipped)).toEqual(hangups.map(() => retired));
    expect(statusReads(h, call.customer).length).toBeGreaterThan(0);
    expect(statusReads(h, call.customer).every(route => route.region === "eu")).toBe(true);
  });

  it.each([
    ["Cloudflare's 1010", new TelnyxCommandError({ code: CLOUDFLARE_SIGNATURE_BANNED_CODE, status: 403, retryable: false })],
    ["the TEST boundary's 423", new TelnyxCommandError({ code: "test_provider_boundary", status: 423 })],
    ["a validation refusal (400)", new TelnyxCommandError({ code: "10015", status: 400 })],
  ])("keeps the obligation after %s without asking, even for a leg that has ended", async (_case, refusal) => {
    const { h } = harness();
    const sessionId = "00000000-0000-4000-8000-00000000d008";
    const leg = await euSessionWithDial(h, sessionId);
    h.db.registerRpc("motorist_provider_termination_legs_v2", () => [{ commandId: `${sessionId}-dial`, callControlId: leg }]);
    h.telnyx.failNext("hangup", refusal);
    h.telnyx.setCallStatus(leg, { alive: false });
    await ownedSessionWork(h.deps, sessionId, () => reconcileTermination({ ...h.deps, telnyx: h.telnyx.client }, sessionId));
    const checkpoint = h.db.log.find(entry => entry.kind === "rpc" && entry.table === "motorist_provider_termination_checkpoint_v2");
    expect((checkpoint?.payload as { p_completed_commands: string[] }).p_completed_commands).toEqual([]);
    expect(statusReads(h, leg)).toEqual([]);
  });

  it("retires only the confirmed-dead leg of a batched EU teardown and keeps the live one", async () => {
    // The losing operators' hangups after an answer go out as one batched run
    // (`callActionMany`). An inbound session stays `us`; this one is frozen to
    // `eu` by hand, which is all the region of its commands depends on.
    const { h } = harness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    h.db.update("motorist_call_sessions", { metadata: { ...readMeta(h.session(call.sessionId) as SessionRow),
      start_mode: { concurrent: false, autoBridge: false, ownLegTimeoutSecs: 30, apiRegion: "eu", origin: null } } }, row => row.id === call.sessionId);
    const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    const losers = h.legs(call.sessionId).filter(leg => leg.role === "operator" && !leg.ended_at && leg.telnyx_call_control_id !== winner)
      .map(leg => String(leg.telnyx_call_control_id));
    expect(losers.length).toBeGreaterThanOrEqual(2);
    const [dead, alive] = losers;
    const batch = vi.spyOn(h.telnyx.client, "callActionMany");
    h.telnyx.failAlways("hangup", refused());
    h.telnyx.setCallStatus(dead, { alive: false });
    for (const leg of losers.slice(1)) h.telnyx.setCallStatus(leg, { alive: true });
    const answered = await h.legEvent(winner, "call.answered");
    expect(batch.mock.calls.some(([actions]) => actions.filter(action => action.action === "hangup").length > 1)).toBe(true);
    const legOf = new Map(h.telnyx.of("hangup").map(entry => [String(entry.params.commandId), String(entry.params.callControlId)]));
    const retired = new Map(answered.commands.filter(command => command.kind === "hangup")
      .map(command => [legOf.get(String(command.commandId)), command.ok && command.skipped] as const));
    expect(retired.get(dead)).toBe(true);
    expect(retired.get(alive)).toBe(false);
    // The live leg's hangup stays a pending obligation of the answer.
    expect(answered).toMatchObject({ outcome: "failed", error: "mandatory effects pending" });
    for (const leg of [dead, alive]) {
      expect(statusReads(h, leg).length).toBeGreaterThan(0);
      expect(statusReads(h, leg).every(route => route.region === "eu")).toBe(true);
    }
  });

  it("confirms refused termination legs together, not one after another", async () => {
    const { h } = harness();
    const sessionId = "00000000-0000-4000-8000-00000000d009";
    h.db.seed("motorist_call_sessions", [{ id: sessionId, organization_id: ORG, direction: "outbound", state: "talking", writer_contract: 2, lease_generation: 0,
      metadata: { start_mode: { concurrent: false, autoBridge: false, ownLegTimeoutSecs: 30, apiRegion: "eu", origin: "web" } } }]);
    h.db.registerRpc("motorist_provider_termination_legs_v2", () => [{ commandId: "first", callControlId: "leg-1" }, { commandId: "second", callControlId: "leg-2" }]);
    const reads: Array<{ leg: string; answer: (alive: boolean) => void }> = [];
    const telnyx = {
      hangup: async () => { throw refused(); },
      retrieveCall: (leg: string) => new Promise<{ callControlId: string; known: boolean; alive: boolean; callSessionId: null; raw: Record<string, unknown> }>(resolve =>
        reads.push({ leg, answer: alive => resolve({ callControlId: leg, known: true, alive, callSessionId: null, raw: { is_alive: alive } }) })),
    } as unknown as NonNullable<typeof h.deps.telnyx>;
    const pending = ownedSessionWork(h.deps, sessionId, () => reconcileTermination({ ...h.deps, telnyx }, sessionId));
    // Both status reads are in flight before either answers.
    await vi.waitFor(() => expect(reads.map(read => read.leg)).toEqual(["leg-1", "leg-2"]));
    reads[1].answer(false);
    reads[0].answer(true);
    await pending;
    const checkpoint = h.db.log.find(entry => entry.kind === "rpc" && entry.table === "motorist_provider_termination_checkpoint_v2");
    expect((checkpoint?.payload as { p_completed_commands: string[] }).p_completed_commands).toEqual(["second"]);
  });

  it("asks nothing in a `us` session: its refusals keep today's meaning", async () => {
    const { h } = harness();
    const sessionId = "00000000-0000-4000-8000-00000000d007";
    const leg = await euSessionWithDial(h, sessionId, "us");
    h.db.registerRpc("motorist_provider_termination_legs_v2", () => [{ commandId: `${sessionId}-dial`, callControlId: leg }]);
    h.telnyx.failNext("hangup", refused());
    h.telnyx.setCallStatus(leg, { alive: false });
    await ownedSessionWork(h.deps, sessionId, () => reconcileTermination({ ...h.deps, telnyx: h.telnyx.client }, sessionId));
    const checkpoint = h.db.log.find(entry => entry.kind === "rpc" && entry.table === "motorist_provider_termination_checkpoint_v2");
    expect((checkpoint?.payload as { p_completed_commands: string[] }).p_completed_commands).toEqual([]);
    expect(statusReads(h, leg)).toEqual([]);
  });

  // F1: a stop refused only in prose ("does not exist") is no longer taken for a gone leg in an EU session.
  it.each(confirmations.flatMap(confirmation => [{ ...confirmation, refusal: "a bare 404" }, { ...confirmation, refusal: "a prose-only 404" }]))(
    "a recording stop in an EU session refused with $refusal, customer leg $leg: stopped=$retired", async ({ status, retired, refusal }) => {
    const { h, deps } = harness({ api_region: "eu" });
    for (const key of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED", "TELNYX_RECORDING_CONFERENCE_VERIFIED",
      "TELNYX_RECORDING_TRANSFER_VERIFIED", "TELNYX_RECORDING_CHANNELS_VERIFIED"]) vi.stubEnv(key, "true");
    h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(),
      inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
    h.db.update("motorist_telephony_lines", { metadata: { announcements: { ...defaultAnnouncementConfig(), outboundStartAnnouncements: true } } }, () => true);
    const call = await startOutboundCall(deps(), o1, { to: NUMBERS.customer, requestId: requestId() });
    h.telnyx.physical.answered(call.operatorLegCallControlId);
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    const customer = String(h.legs(call.sessionId).find(leg => leg.role === "customer")!.telnyx_call_control_id);
    h.telnyx.physical.answered(customer);
    await h.legEvent(customer, "call.answered", { direction: "outgoing" });
    await completeCallAnnouncements(h, call.sessionId);
    const recorded = String(h.telnyx.of("recordingStart").at(-1)!.params.callControlId);
    h.telnyx.failNext("recordingStop", refusal === "a bare 404" ? refused() : proseOnly());
    status(h, recorded);
    await stopCallRecording(deps(), o1, call.sessionId).catch(() => undefined);
    const stops = h.callEvents(call.sessionId).flatMap(row =>
      ((row.normalized_payload as { commands?: Array<{ kind: string; ok: boolean }> } | null)?.commands ?? []).filter(command => command.kind === "recording_stop"));
    expect(stops.length).toBeGreaterThan(0);
    expect(stops[0].ok).toBe(retired);
    expect(statusReads(h, recorded).length).toBeGreaterThan(0);
    expect(statusReads(h, recorded).every(route => route.region === "eu")).toBe(true);
  });
});

describe("the EU switch end to end from the database flags (production guard)", () => {
  async function startWith(environment: string) {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    vi.stubEnv("MOTORIST_APP_ENV", environment);
    clearLatencyFlagsCache();
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
    h.db.update("motorist_telephony_settings", { latency_flags: { api_region: "eu" } }, () => true);
    const latencyFlags = await readLatencyFlags(h.admin, ORG, { logger: () => undefined, env: {} });
    expect(latencyFlags.api_region).toBe("eu");
    const deps = { ...h.deps, latencyFlags, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) };
    const call = await startOutboundCall(deps, o1, { to: NUMBERS.customer, requestId: requestId() });
    clearLatencyFlagsCache();
    return { h, call };
  }

  it.each([["test", "eu"], ["production", "us"], ["development", "us"]] as const)("an outbound call started on a %s deployment freezes %s", async (environment, region) => {
    const { h, call } = await startWith(environment);
    expect(regionOf(h, call.sessionId)).toBe(region);
    expect(routesOf(h, call.sessionId).map(route => route.region)).toEqual([region]);
  });
});

describe("confirming an EU leg's end (status read)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("gives the status read 1.5 s, not the command timeout, and keeps the obligation when it runs out", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const client = createTelnyxClient({ config: getTelnyxConfig(FAKE_TELNYX_ENV), liveGate: { callsEnabled: true, smsEnabled: true }, fetch });
    let settled: boolean | undefined;
    const confirmation = sessionOwnership.run(owner("eu"), () => confirmEuLegEnded(client, "leg", new TelnyxCommandError({ code: "http_404", status: 404 })))
      .then(value => { settled = value; });
    await vi.advanceTimersByTimeAsync(EU_LEG_CONFIRM_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    await confirmation;
    expect(settled).toBe(false);
    expect(EU_LEG_CONFIRM_TIMEOUT_MS).toBe(1_500);
    expect(fetch.mock.calls.map(([input, init]) => `${init?.method} ${String(input)}`)).toEqual(["GET https://api.telnyx.eu/v2/calls/leg"]);
  });

  it("throws a lost lease instead of reading it as an unreadable status", async () => {
    const lost = { retrieveCall: async () => { throw new SessionLeaseLostError(); } };
    await expect(sessionOwnership.run(owner("eu"), () => confirmEuLegEnded(lost, "leg", new TelnyxCommandError({ code: "http_404", status: 404 }))))
      .rejects.toBeInstanceOf(SessionLeaseLostError);
    const broken = { retrieveCall: async () => { throw new TelnyxCommandError({ code: "network", status: 502 }); } };
    await expect(sessionOwnership.run(owner("eu"), () => confirmEuLegEnded(broken, "leg", new TelnyxCommandError({ code: "http_404", status: 404 })))).resolves.toBe(false);
  });
});

describe("one fixed host per region (env)", () => {
  it("lets tests and local runs override a region's base, and pins both in production, logging the ignored override once", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const local = getTelnyxConfig({ TELNYX_API_KEY: "k", TELNYX_API_BASE_URL: "https://telnyx.test/v2/", TELNYX_EU_API_BASE_URL: "https://eu.telnyx.test/v2" });
    expect(local).toMatchObject({ apiBaseUrl: "https://telnyx.test/v2", euApiBaseUrl: "https://eu.telnyx.test/v2" });
    expect(errors).not.toHaveBeenCalled();
    const env = { TELNYX_API_KEY: "k", MOTORIST_APP_ENV: "production", TELNYX_API_BASE_URL: "https://proxy.example/v2", TELNYX_EU_API_BASE_URL: "https://proxy-eu.example/v2" };
    for (let round = 0; round < 2; round += 1) {
      expect(getTelnyxConfig(env)).toMatchObject({ apiBaseUrl: "https://api.telnyx.com/v2", euApiBaseUrl: "https://api.telnyx.eu/v2" });
    }
    // The canonical value itself is not an override; an unreadable environment counts as production.
    expect(getTelnyxConfig({ ...env, TELNYX_API_BASE_URL: "https://api.telnyx.com/v2/", MOTORIST_APP_ENV: "bogus" })).toMatchObject({ apiBaseUrl: "https://api.telnyx.com/v2", euApiBaseUrl: "https://api.telnyx.eu/v2" });
    const logged = errors.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(logged.filter(entry => entry.code === "api_base_url_override_ignored").map(entry => [entry.variable, entry.host])).toEqual(expect.arrayContaining([
      ["TELNYX_API_BASE_URL", "proxy.example"], ["TELNYX_EU_API_BASE_URL", "proxy-eu.example"]]));
    expect(new Set(logged.map(entry => entry.variable)).size).toBe(logged.length);
  });
});
