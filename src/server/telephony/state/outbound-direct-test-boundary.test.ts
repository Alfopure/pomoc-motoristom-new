import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { FAKE_TELNYX_ENV } from "@/test/fake-telnyx";
import { CONNECTION_ID, createTelephonyHarness, LINES, NUMBERS, ORG, PROFILES } from "@/test/telephony-harness";
import { createRateLimiter, startOutboundCall } from "../call-actions";
import { createTelnyxClient } from "../telnyx/client";
import { getTelnyxConfig } from "../telnyx/env";

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

const FROM = "+421232408774";
const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };

function dedicatedTestOutbound() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness({ writerContract: 2 });
  vi.mocked(createSupabaseAdminClient).mockReturnValue(h.admin);
  h.db.update("motorist_profiles", { kind: "human" }, () => true);
  h.db.update("motorist_telephony_lines", { phone_number: FROM, environment: "development" }, row => row.id === LINES.allianz);
  const config = getTelnyxConfig({
    ...FAKE_TELNYX_ENV,
    MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
    VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk",
    SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
    MOTORIST_TEST_LIVE_INTEGRATIONS: "true", MOTORIST_TEST_ALLOW_ANY_PHONE_NUMBER: "true",
    MOTORIST_TEST_FROM_NUMBERS: FROM, TELNYX_DEFAULT_FROM_NUMBER: FROM,
  });
  const wire: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  let dials = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(input)).pathname.replace(/^\/v2/, "");
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    wire.push({ method, path, body });
    let data: Record<string, unknown>;
    if (method === "GET" && path === "/telephony_credentials/cred-1") {
      data = { resource_id: `connection:${FAKE_TELNYX_ENV.TELNYX_CREDENTIAL_CONNECTION_ID}`, sip_username: "gencred001", expired: false };
    } else if (method === "POST" && path === "/calls") {
      const id = ++dials === 1 ? "test-operator-leg" : "test-customer-leg";
      data = { call_control_id: id, call_leg_id: `leg-${id}`, call_session_id: "test-provider-session" };
    } else if (method === "POST" && /^\/calls\/[^/]+\/actions\/hangup$/.test(path)) {
      data = { result: "ok" };
    } else throw new Error(`Unexpected provider request: ${method} ${path}`);
    return Response.json({ data });
  });
  const newClient = () => createTelnyxClient({ config, liveGate: { callsEnabled: true, smsEnabled: false }, fetch });
  h.deps.config = config;
  h.deps.telnyx = newClient();
  return { h, wire, fetch, newClient };
}

describe("direct outbound through the dedicated TEST provider boundary", () => {
  it("dials the customer after the browser answers using the real wire adapter and journal", async () => {
    const { h, wire, newClient } = dedicatedTestOutbound();
    const call = await startOutboundCall({ ...h.deps, rateLimiter: createRateLimiter() }, actor, {
      to: NUMBERS.customer, requestId: "30000000-0000-4000-8000-000000000001",
    });
    expect(call.from).toBe(FROM);
    expect(wire.filter(request => request.path === "/calls")).toHaveLength(1);
    // A webhook runs in a fresh client: the accepted operator journal, not an
    // in-memory created-call set, must authorize the customer's link_to.
    h.deps.telnyx = newClient();
    const answer = await h.legEvent(call.operatorLegCallControlId, "call.answered");
    expect(answer.commands.filter(command => !command.ok)).toEqual([]);
    const dials = wire.filter(request => request.method === "POST" && request.path === "/calls");
    expect(dials).toHaveLength(2);
    expect(dials[1].body).toMatchObject({
      to: NUMBERS.customer, from: FROM, connection_id: CONNECTION_ID,
      link_to: call.operatorLegCallControlId, bridge_on_answer: true,
      prevent_double_bridge: true, park_after_unbridge: "self",
    });
    expect(h.legs(call.sessionId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "customer", to_number: NUMBERS.customer, telnyx_call_control_id: "test-customer-leg" }),
    ]));
    expect(h.rows("motorist_provider_commands")).toEqual(expect.arrayContaining([
      expect.objectContaining({ session_id: call.sessionId, path: "/calls", outcome: "accepted",
        request_payload: expect.objectContaining({ to: NUMBERS.customer, park_after_unbridge: "self" }) }),
    ]));
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(wire.some(request => request.path.endsWith("/hangup"))).toBe(false);
    expect(h.telnyx.calls).toEqual([]);
  });

  it("still refuses a parked dial linked to a copied production leg", async () => {
    const { h, fetch, newClient } = dedicatedTestOutbound();
    const copiedSession = "30000000-0000-4000-8000-000000000002";
    h.db.insert("motorist_call_legs", { organization_id: ORG, session_id: copiedSession, telnyx_call_control_id: "copied-production-leg" });
    h.db.insert("motorist_provider_commands", { session_id: copiedSession, command_id: "copied-dial", method: "POST", path: "/calls",
      outcome: "accepted", request_payload: { connection_id: "production-app" }, result: { data: { call_control_id: "copied-production-leg" } } });
    h.db.insert("motorist_telnyx_webhook_events", { organization_id: ORG, event_id: "copied-event", event_type: "call.initiated",
      call_control_id: "copied-production-leg", connection_id: "production-app" });
    await expect(newClient().dial({ to: NUMBERS.customer, from: FROM, commandId: "linked-dial",
      linkTo: "copied-production-leg", bridgeOnAnswer: true, preventDoubleBridge: true,
      extra: { park_after_unbridge: "self" },
    })).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { linkTo: undefined, park: "self" },
    { linkTo: "test-operator-leg", park: "peer" },
    { linkTo: "test-operator-leg", park: true },
  ])("does not widen parked dialing beyond the adapter's linked-self form: %j", async ({ linkTo, park }) => {
    const { h, fetch, newClient } = dedicatedTestOutbound();
    h.db.insert("motorist_telnyx_webhook_events", { organization_id: ORG, event_id: "own-event", event_type: "call.initiated",
      call_control_id: "test-operator-leg", connection_id: CONNECTION_ID });
    await expect(newClient().dial({ to: NUMBERS.customer, from: FROM, commandId: "invalid-park",
      linkTo, extra: { park_after_unbridge: park },
    })).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
