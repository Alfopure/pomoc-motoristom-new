import { describe, expect, it, vi } from "vitest";
import { createTelnyxClient } from "./client";
import { getTelnyxConfig } from "./env";
import { acceptsTestInboundSms, acceptsTestProviderEvent, checkTestProviderRequest, getTestProviderSafety, resolveTestSipCredential } from "./test-safety";

vi.mock("./test-safety", async (original) => ({ ...await original<typeof import("./test-safety")>(),
  resolveTestSipCredential: vi.fn(async () => "test-credential"),
  hasTestCallProvenance: vi.fn(async (_boundary, id: string) => ["existing", "existing-leg", "existing-other"].includes(id)),
}));
const TO = "+421900000001", FROM = "+421200000001";
const ENV = {
  MOTORIST_APP_ENV: "test", MOTORIST_TEST_LIVE_INTEGRATIONS: "true", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
  VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk",
  SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
  MOTORIST_TEST_ALLOWED_NUMBERS: TO, MOTORIST_TEST_FROM_NUMBERS: FROM,
  TELNYX_API_KEY: "fake-test-key", TELNYX_CALL_CONTROL_APP_ID: "test-app", TELNYX_CREDENTIAL_CONNECTION_ID: "test-connection", TELNYX_MESSAGING_PROFILE_ID: "test-messaging", TELNYX_OUTBOUND_VOICE_PROFILE_ID: "call-control-profile",
};
function client(env: Record<string, string | undefined> = ENV, credential = { resource_id: "connection:test-connection", sip_username: "test_user" }, sipConnection: Record<string, unknown> = { active: true, sip_uri_calling_preference: "internal", outbound: { outbound_voice_profile_id: "disabled-sip-profile" } }, sipProfile: Record<string, unknown> = { enabled: false }) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const data = init?.method !== "GET" ? { call_control_id: "test-leg", id: "test-id", token: "test-token" }
      : url.includes("/conferences/") ? { connection_id: url.includes("/foreign") ? "production" : "test-app" }
        : url.includes("/credential_connections/") ? sipConnection : url.includes("/outbound_voice_profiles/") ? sipProfile : credential;
    return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
  });
  return { fetch, api: createTelnyxClient({ config: getTelnyxConfig(env), liveGate: { callsEnabled: true, smsEnabled: true }, fetch }) };
}
function boundary(env: Record<string, string | undefined> = ENV) {
  return { safety: getTestProviderSafety(env), callControlAppId: "test-app", credentialConnectionId: "test-connection", messagingProfileId: "test-messaging" };
}

describe("TEST provider boundary", () => {
  it.each([
    { MOTORIST_TEST_LIVE_INTEGRATIONS: "false" }, { MOTORIST_TEST_LIVE_INTEGRATIONS: "TRUE" },
    { MOTORIST_TEST_ALLOWED_NUMBERS: "*" }, { MOTORIST_TEST_ALLOWED_NUMBERS: `${TO},garbage` },
    { MOTORIST_TEST_ALLOWED_NUMBERS: "+421" }, { MOTORIST_TEST_FROM_NUMBERS: "" },
    { VERCEL_ENV: "preview" }, { VERCEL_GIT_COMMIT_REF: "feature" }, { VERCEL_ENV: "development" },
    { VERCEL_PROJECT_ID: "" }, { VERCEL_PROJECT_ID: "production-project" },
    { SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co" }, { APP_BASE_URL: "https://dispecing.linkapomoci.sk" },
  ])("fails closed before any provider fetch: %j", async (patch) => {
    const { api, fetch } = client({ ...ENV, ...patch });
    await expect(api.dial({ to: TO, from: FROM, commandId: "dial" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("cannot bypass the Preview boundary by declaring production", async () => {
    const { api, fetch } = client({ ...ENV, MOTORIST_APP_ENV: "production", VERCEL_ENV: "preview" });
    await expect(api.sendMessage({ to: TO, from: FROM, text: "synthetic" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("cannot bypass TEST boundaries by omitting application/hosting env on a local TEST database", () => {
    const local: Record<string, string | undefined> = { ...ENV };
    delete local.MOTORIST_APP_ENV; delete local.VERCEL_ENV; delete local.VERCEL_GIT_COMMIT_REF;
    expect(getTestProviderSafety(local)).toMatchObject({ restricted: true, enabled: false });
  });
  it("accepts only approved TEST initiation, while retaining terminal correlation for cleanup", () => {
    const event = { type: "call.initiated", connectionId: "test-app", direction: "incoming", from: TO, to: FROM };
    expect(acceptsTestProviderEvent(boundary(), event)).toBe(true);
    for (const patch of [{ connectionId: "production" }, { connectionId: null }, { from: TO + "0" }, { to: FROM + "0" }]) {
      expect(acceptsTestProviderEvent(boundary(), { ...event, ...patch })).toBe(false);
    }
    const disabled = boundary({ ...ENV, MOTORIST_TEST_LIVE_INTEGRATIONS: "false" });
    expect(acceptsTestProviderEvent(disabled, event)).toBe(false);
    expect(acceptsTestProviderEvent(disabled, { ...event, type: "call.hangup", connectionId: null })).toBe(true);
    expect(acceptsTestProviderEvent(disabled, { ...event, type: "call.hangup", connectionId: "production" })).toBe(false);
  });
  it("allows only exact E164 destinations and TEST caller identities on the final merged body", async () => {
    const { api, fetch } = client();
    for (const to of [TO + "0", "+421900000002", TO + " ", "sip:foreign@other.example", `sip:${TO}@sip.telnyx.com`]) {
      await expect(api.dial({ to, from: FROM, commandId: "blocked" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    }
    await expect(api.dial({ to: TO, from: FROM, commandId: "extra", extra: { from: "+421200000002" } })).rejects.toMatchObject({ code: "test_provider_boundary" });
    await expect(api.dial({ to: TO, from: FROM, commandId: "extra", extra: { to: "+421900000002" } })).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(fetch).not.toHaveBeenCalled();
    await api.dial({ to: TO, from: FROM, commandId: "allowed" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("checks arrays, connection override, raw requests and transfer without explicit caller ID", async () => {
    const { api, fetch } = client();
    await expect(api.dial({ to: [TO, "+421900000002"], from: FROM, commandId: "array" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    await expect(api.dial({ to: TO, from: FROM, connectionId: "production", commandId: "connection" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    await expect(api.request("POST", "/calls", { body: { to: "+421900000002", from: FROM, connection_id: "test-app" } })).rejects.toMatchObject({ code: "test_provider_boundary" });
    await expect(api.transfer({ callControlId: "existing", commandId: "transfer", to: TO })).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(fetch).not.toHaveBeenCalled();
    await api.transfer({ callControlId: "existing", commandId: "transfer", to: TO, from: FROM });
  });
  it("blocks unsafe members in batch dial and call-action APIs", async () => {
    const { api, fetch } = client();
    expect(await api.dialMany([{ to: "+421900000002", from: FROM, commandId: "batch-dial" }])).toMatchObject([{ status: "rejected", reason: { code: "test_provider_boundary" } }]);
    expect(await api.callActionMany([{ callControlId: "existing", action: "transfer", commandId: "batch-transfer", body: { to: TO, from: "+421200000002" } }])).toMatchObject([{ status: "rejected", reason: { code: "test_provider_boundary" } }]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not permit alternate SMS sender or messaging profile", async () => {
    const { api, fetch } = client();
    for (const patch of [{ from: "PomocMotor" }, { messagingProfileId: "production" }, { to: TO + "9" }]) {
      await expect(api.sendMessage({ to: TO, from: FROM, text: "synthetic", ...patch })).rejects.toMatchObject({ code: "test_provider_boundary" });
    }
    expect(fetch).not.toHaveBeenCalled();
    await api.sendMessage({ to: TO, from: FROM, text: "synthetic" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("admits the exact TEST alpha sender only for an approved SMS recipient/profile", async () => {
    const env = { ...ENV, MOTORIST_TEST_SMS_ALPHA_SENDER: "DispecTEST", TELNYX_SMS_ALPHA_SENDER: "DispecTEST" };
    const { api, fetch } = client(env);
    for (const patch of [{ from: "PomocMotor" }, { from: "dispectest" }, { from: "DispecTEST " }, { to: TO + "9" }, { messagingProfileId: "production" }]) {
      await expect(api.sendMessage({ to: TO, text: "synthetic", ...patch })).rejects.toMatchObject({ code: "test_provider_boundary" });
    }
    await expect(api.dial({ to: TO, from: "DispecTEST", commandId: "voice" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    await expect(api.transfer({ callControlId: "existing", to: TO, from: "DispecTEST", commandId: "transfer" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    await expect(api.request("POST", "/conferences/test/actions/add_participants", { body: { to: TO, from: "DispecTEST" } })).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(acceptsTestInboundSms(getTestProviderSafety(env), TO, ["DispecTEST"])).toBe(false);
    expect(acceptsTestInboundSms(getTestProviderSafety(env), "DispecTEST", [FROM])).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    await api.sendMessage({ to: TO, text: "synthetic" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ from: "DispecTEST", to: TO, messaging_profile_id: "test-messaging" });
  });
  it.each([undefined, "", "AB", "ABCDEFGHIJKL", "12345", "Dispec TEST", "Dispec-TEST", "DíspecTEST", "DispecTEST\n"])("rejects invalid or absent alpha allowance %j before fetching", async (alpha) => {
    const { api, fetch } = client({ ...ENV, MOTORIST_TEST_SMS_ALPHA_SENDER: alpha });
    await expect(api.sendMessage({ to: TO, from: alpha || "DispecTEST", text: "synthetic" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ MOTORIST_TEST_LIVE_INTEGRATIONS: "false" }, { VERCEL_ENV: "preview" }, { MOTORIST_TEST_FROM_NUMBERS: "" }])("alpha SMS retains deployment, live and number boundaries %j", async (patch) => {
    const { api, fetch } = client({ ...ENV, MOTORIST_TEST_SMS_ALPHA_SENDER: "DispecTEST", ...patch });
    await expect(api.sendMessage({ to: TO, from: "DispecTEST", text: "synthetic" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("protects outbound conference additions without breaking joins of existing legs", async () => {
    const { api, fetch } = client();
    await expect(api.request("POST", "/conferences/test/actions/add_participants", { body: { to: "+421900000002", from: FROM } })).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(fetch).not.toHaveBeenCalled();
    await api.conferenceAction("existing", "join", { call_control_id: "existing-leg", commandId: "join" });
    await api.request("POST", "/conferences/test/actions/add_participants", { body: { to: TO, from: FROM } });
  });
  it("requires TEST connection for credential creation and token minting", async () => {
    const { api, fetch } = client(ENV, { resource_id: "connection:production", sip_username: "test_user" });
    await expect(api.createTelephonyCredential({ name: "synthetic", connectionId: "production" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(api.mintCredentialToken("copied-production-credential")).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
    const allowed = client();
    await allowed.api.mintCredentialToken("test-credential");
    expect(allowed.fetch.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "GET", "GET", "POST"]);
  });
  it.each([
    [{ active: true, sip_uri_calling_preference: "internal", outbound: {} }, { enabled: false }],
    [{ active: true, sip_uri_calling_preference: "unrestricted", outbound: { outbound_voice_profile_id: "sip-profile" } }, { enabled: false }],
    [{ active: false, sip_uri_calling_preference: "internal", outbound: { outbound_voice_profile_id: "sip-profile" } }, { enabled: false }],
    [{ active: true, sip_uri_calling_preference: "internal", outbound: { outbound_voice_profile_id: "sip-profile" } }, { enabled: true }],
    [{ active: true, sip_uri_calling_preference: "internal", outbound: { outbound_voice_profile_id: "sip-profile" } }, {}],
  ])("never mints a JWT without a proven PSTN-disabled SIP connection", async (connection, profile) => {
    const { api, fetch } = client(ENV, undefined, connection, profile);
    await expect(api.mintCredentialToken("test-credential")).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(fetch.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });
  it("binds SIP targets to an enrolled TEST device and provider resource", async () => {
    const { api, fetch } = client();
    await api.dial({ to: "sip:test_user@sip.telnyx.com", from: FROM, commandId: "sip" });
    expect(resolveTestSipCredential).toHaveBeenCalledWith("test_user");
    expect(fetch.mock.calls.map(([, options]) => options?.method)).toEqual(["GET", "POST"]);
    const foreign = client(ENV, { resource_id: "connection:production", sip_username: "test_user" });
    await expect(foreign.api.dial({ to: "sip:test_user@sip.telnyx.com", from: FROM, commandId: "sip" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(foreign.fetch.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });
  it("leaves lifecycle and revocation available when TEST creation is switched off", async () => {
    const { api, fetch } = client({ ...ENV, MOTORIST_TEST_LIVE_INTEGRATIONS: "false" });
    await api.hangup({ callControlId: "existing", commandId: "end" });
    await api.bridge({ callControlId: "existing", targetCallControlId: "existing-other", commandId: "bridge" });
    await api.conferenceAction("existing", "leave", { call_control_id: "existing-leg", commandId: "leave" });
    await api.deleteTelephonyCredential("test-credential");
    await expect(api.mintCredentialToken("test-credential")).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(fetch).toHaveBeenCalledTimes(6); // conference and credential GETs precede mutations
  });
  it("blocks unknown writes and foreign callback overrides even on lifecycle commands", () => {
    expect(() => checkTestProviderRequest(boundary(), "POST", "/unknown", {})).toThrow();
    expect(() => checkTestProviderRequest(boundary(), "POST", "/calls/a/actions/answer", { webhook_url: "https://dispecing.linkapomoci.sk/api/telephony/telnyx/webhook" })).toThrow();
    expect(() => checkTestProviderRequest(boundary(), "POST", "/calls/a/actions/answer", { webhook_url: `${ENV.APP_BASE_URL}/api/telephony/telnyx/webhook` })).not.toThrow();
  });
  it("blocks copied foreign call IDs in lifecycle paths and every referenced leg", async () => {
    const { api, fetch } = client();
    await expect(api.hangup({ callControlId: "copied-prod", commandId: "end" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    await expect(api.bridge({ callControlId: "existing", targetCallControlId: "copied-prod", commandId: "bridge" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    await expect(api.dial({ to: TO, from: FROM, commandId: "link", linkTo: "copied-prod" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    await expect(api.dial({ to: TO, from: FROM, commandId: "supervise", superviseCallControlId: "copied-prod" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    await expect(api.dial({ to: TO, from: FROM, commandId: "conference-extra", extra: { conference_config: { id: "foreign", end_conference_on_exit: true } } })).rejects.toMatchObject({ code: "test_provider_boundary" });
    await expect(api.conferenceAction("existing", "mute", { call_control_ids: ["existing-leg", "copied-prod"] })).rejects.toMatchObject({ code: "test_provider_boundary" });
    await expect(api.conferenceAction("existing", "join", { call_control_id: "existing-leg", whisper_call_control_ids: ["copied-prod"] })).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(api.conferenceAction("foreign", "end", { commandId: "end" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(fetch.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });
  it("allows an immediate cleanup only for a call this guarded client just created", async () => {
    const { api, fetch } = client();
    await api.dial({ to: TO, from: FROM, commandId: "start" });
    await api.hangup({ callControlId: "test-leg", commandId: "compensate" });
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(client().api.hangup({ callControlId: "test-leg", commandId: "unknown-elsewhere" })).rejects.toMatchObject({ code: "test_provider_boundary" });
  });
  it("does not exempt lifecycle/revocation from the Preview deployment boundary", async () => {
    const { api, fetch } = client({ ...ENV, VERCEL_ENV: "preview" });
    await expect(api.hangup({ callControlId: "existing", commandId: "hangup" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    await expect(api.deleteTelephonyCredential("test-credential")).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not change production destination/sender policy", async () => {
    const { api, fetch } = client({ ...ENV, MOTORIST_APP_ENV: "production", VERCEL_GIT_COMMIT_REF: "main", SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co", APP_BASE_URL: "https://dispecing.linkapomoci.sk" });
    await api.dial({ to: "+420777000999", from: "+421299999999", commandId: "production" });
    await api.sendMessage({ to: "+420777000999", from: "PomocMotor", text: "synthetic" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("permits only the explicitly enabled exact TEST OpenAI project SIP target", async () => {
    const env = { ...ENV, AI_DEMO_ENABLED: "true", OPENAI_LIVE_PROJECT_ID: "proj_test", OPENAI_LIVE_SIP_HOST: "sip-eu.api.openai.com" };
    const { api, fetch } = client(env);
    for (const to of ["sip:proj_prod@sip-eu.api.openai.com;transport=tls", "sip:proj_test@sip.api.openai.com;transport=tls", "sip:proj_test@sip-eu.api.openai.com", "sip:proj_test@sip-eu.api.openai.com;transport=tls;other=1"]) {
      await expect(api.dial({ to, from: FROM, commandId: "ai" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    }
    expect(fetch).not.toHaveBeenCalled();
    await api.dial({ to: "sip:proj_test@sip-eu.api.openai.com;transport=tls", from: FROM, commandId: "ai" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const disabled = client({ ...env, AI_DEMO_ENABLED: "false" });
    await expect(disabled.api.dial({ to: "sip:proj_test@sip-eu.api.openai.com;transport=tls", from: FROM, commandId: "ai" })).rejects.toMatchObject({ code: "test_provider_boundary" });
    expect(disabled.fetch).not.toHaveBeenCalled();
  });
  it("shares one deadline across token safety reads and the final token write", async () => {
    let clock = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      clock += 4_000;
      const path = String(input);
      const data = path.includes("/credential_connections/") ? { active: true, sip_uri_calling_preference: "internal", outbound: { outbound_voice_profile_id: "disabled" } }
        : path.includes("/outbound_voice_profiles/") ? { enabled: false } : { resource_id: "connection:test-connection" };
      return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
    });
    const api = createTelnyxClient({ config: getTelnyxConfig(ENV), liveGate: { callsEnabled: true, smsEnabled: true }, fetch, now: () => clock });
    await expect(api.mintCredentialToken("test-credential")).rejects.toMatchObject({ code: "deadline" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
