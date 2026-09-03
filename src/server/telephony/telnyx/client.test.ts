import { describe, expect, it, vi } from "vitest";

import { TelephonyNotConfiguredError } from "@/lib/telephony/not-configured";

import {
  createTelnyxClient,
  LIVE_CALLS_DISABLED_MESSAGE,
  resolveTelnyxLiveGate,
  TelnyxCommandError,
  TelnyxLiveCallsDisabledError,
  TelnyxSmsDisabledError,
  type TelnyxRequestLog,
} from "./client";
import { getTelnyxConfig } from "./env";

const ENV = {
  TELNYX_API_KEY: "KEYtest",
  TELNYX_API_BASE_URL: "https://telnyx.test/v2",
  TELNYX_CALL_CONTROL_APP_ID: "app-1",
  TELNYX_CREDENTIAL_CONNECTION_ID: "cred-conn-1",
  TELNYX_MESSAGING_PROFILE_ID: "mp-1",
  TELNYX_LIVE_CALLS_ENABLED: "true",
  TELNYX_SMS_LIVE_SENDS: "true",
};

type Recorded = { url: string; init: RequestInit; body: Record<string, unknown> | null };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function makeFetch(responses: Array<Response | ((request: Recorded) => Response | Promise<Response>)>) {
  const calls: Recorded[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const record: Recorded = { url, init: init ?? {}, body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null };
    calls.push(record);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch #${calls.length} to ${url}`);
    return typeof next === "function" ? next(record) : next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function makeClient(fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof createTelnyxClient>[0]> = {}) {
  const logs: TelnyxRequestLog[] = [];
  const sleeps: number[] = [];
  const client = createTelnyxClient({
    config: getTelnyxConfig(ENV),
    liveGate: { callsEnabled: true, smsEnabled: true },
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onRequest: (entry) => logs.push(entry),
    ...overrides,
  });
  return { client, logs, sleeps };
}

describe("resolveTelnyxLiveGate", () => {
  it("requires both the env switch and the settings row", () => {
    const config = getTelnyxConfig(ENV);
    expect(resolveTelnyxLiveGate(config, { live_calls_enabled: true, sms_live_sends: false })).toEqual({ callsEnabled: true, smsEnabled: false });
    expect(resolveTelnyxLiveGate(config, { live_calls_enabled: false, sms_live_sends: true })).toEqual({ callsEnabled: false, smsEnabled: true });
    expect(resolveTelnyxLiveGate(config, null)).toEqual({ callsEnabled: false, smsEnabled: false });
    expect(resolveTelnyxLiveGate(getTelnyxConfig({ ...ENV, TELNYX_LIVE_CALLS_ENABLED: "false" }), { live_calls_enabled: true, sms_live_sends: true })).toEqual({
      callsEnabled: false,
      smsEnabled: true,
    });
    expect(resolveTelnyxLiveGate(getTelnyxConfig({}), { live_calls_enabled: true, sms_live_sends: true })).toEqual({ callsEnabled: false, smsEnabled: false });
  });
});

describe("createTelnyxClient", () => {
  it("throws the not-configured error without an API key", () => {
    expect(() => createTelnyxClient({ config: getTelnyxConfig({}), liveGate: { callsEnabled: true, smsEnabled: true } })).toThrow(TelephonyNotConfiguredError);
  });

  it("sends call commands with bearer auth, command_id and snake_case params", async () => {
    const { impl, calls } = makeFetch([jsonResponse(200, { data: { result: "ok" } })]);
    const { client, logs } = makeClient(impl);

    await client.bridge({ callControlId: "v3:abc/def", commandId: "cmd-1", targetCallControlId: "v3:xyz", playRingtone: true, ringtone: "cz" });

    expect(calls[0].url).toBe("https://telnyx.test/v2/calls/v3%3Aabc%2Fdef/actions/bridge");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer KEYtest");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].body).toEqual({ call_control_id: "v3:xyz", play_ringtone: true, ringtone: "cz", command_id: "cmd-1" });
    expect(logs).toEqual([{ method: "POST", path: "/calls/v3%3Aabc%2Fdef/actions/bridge", status: 200, ms: expect.any(Number), commandId: "cmd-1", retried: false, error: null }]);
  });

  it("dials with the configured connection id and parses the leg identifiers", async () => {
    const { impl, calls } = makeFetch([
      jsonResponse(200, { data: { call_control_id: "cc-9", call_leg_id: "leg-9", call_session_id: "sess-9", is_alive: true } }),
    ]);
    const { client } = makeClient(impl);

    const result = await client.dial({
      commandId: "cmd-dial",
      to: "sip:gencred1@sip.telnyx.com",
      from: "+421232408700",
      clientState: "c3RhdGU=",
      sipRegion: "Europe",
      mediaEncryption: "SRTP",
      customHeaders: [{ name: "X-PM-Auto-Answer", value: "1" }],
    });

    expect(result).toEqual({ callControlId: "cc-9", callLegId: "leg-9", callSessionId: "sess-9", isAlive: true });
    expect(calls[0].url).toBe("https://telnyx.test/v2/calls");
    expect(calls[0].body).toEqual({
      to: "sip:gencred1@sip.telnyx.com",
      from: "+421232408700",
      connection_id: "app-1",
      client_state: "c3RhdGU=",
      sip_region: "Europe",
      media_encryption: "SRTP",
      custom_headers: [{ name: "X-PM-Auto-Answer", value: "1" }],
      command_id: "cmd-dial",
    });
  });

  it("refuses call-creating commands when the kill switch is off and never touches the network", async () => {
    const { impl } = makeFetch([]);
    const { client } = makeClient(impl, { liveGate: { callsEnabled: false, smsEnabled: false } });

    const dial = await client.dial({ commandId: "c", to: "+421905123456", from: "+421232408700" }).catch((error: unknown) => error);
    expect(dial).toBeInstanceOf(TelnyxLiveCallsDisabledError);
    expect((dial as TelnyxCommandError).status).toBe(423);
    expect((dial as TelnyxCommandError).code).toBe("live_calls_disabled");
    expect((dial as Error).message).toBe(LIVE_CALLS_DISABLED_MESSAGE);

    await expect(client.transfer({ callControlId: "cc", commandId: "c", to: "+421905123456" })).rejects.toBeInstanceOf(TelnyxLiveCallsDisabledError);
    await expect(client.sendMessage({ to: "+421905123456", text: "Ahoj" })).rejects.toBeInstanceOf(TelnyxSmsDisabledError);
    expect(impl).not.toHaveBeenCalled();
  });

  it("still allows non-creating commands (hangup) when live calls are disabled", async () => {
    const { impl, calls } = makeFetch([jsonResponse(200, { data: { result: "ok" } })]);
    const { client } = makeClient(impl, { liveGate: { callsEnabled: false, smsEnabled: false } });

    await client.hangup({ callControlId: "cc-1", commandId: "cmd-h" });
    expect(calls[0].url).toBe("https://telnyx.test/v2/calls/cc-1/actions/hangup");
    expect(calls[0].body).toEqual({ command_id: "cmd-h" });
  });

  it("retries exactly once on 429 honouring retry-after", async () => {
    const { impl, calls } = makeFetch([jsonResponse(429, { errors: [{ code: "10011", title: "Too many requests" }] }, { "retry-after": "1" }), jsonResponse(200, { data: { result: "ok" } })]);
    const { client, sleeps, logs } = makeClient(impl);

    await client.answer({ callControlId: "cc-1", commandId: "cmd-a", clientState: "x" });

    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
    expect(logs[0]).toMatchObject({ status: 200, retried: true });
  });

  it("caps retry-after, defaults it when missing, and gives up after the second 429", async () => {
    const capped = makeFetch([jsonResponse(429, undefined, { "retry-after": "30" }), jsonResponse(429, { errors: [{ code: "10011", detail: "slow down" }] })]);
    const client = makeClient(capped.impl);

    const failure = await client.client.hangup({ callControlId: "cc-1", commandId: "cmd" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TelnyxCommandError);
    expect(failure).toMatchObject({ code: "10011", status: 429, detail: "slow down", retryable: true, commandId: "cmd" });
    expect(client.sleeps).toEqual([2000]);
    expect(capped.calls).toHaveLength(2);

    const missing = makeFetch([jsonResponse(429, undefined), jsonResponse(200, { data: {} })]);
    const second = makeClient(missing.impl);
    await second.client.hangup({ callControlId: "cc-1", commandId: "cmd" });
    expect(second.sleeps).toEqual([500]);
  });

  it("maps 4xx/5xx bodies to TelnyxCommandError with the Telnyx code", async () => {
    const { impl } = makeFetch([
      jsonResponse(422, { errors: [{ code: "90010", title: "Call has already ended", detail: "The call is not alive" }] }),
      jsonResponse(500, { errors: [{ code: "10007", title: "Unexpected error" }] }),
      new Response("Bad Gateway", { status: 502, headers: { "content-type": "text/plain" } }),
    ]);
    const { client, logs } = makeClient(impl);

    const ended = await client.hangup({ callControlId: "cc-1", commandId: "cmd-1" }).catch((error: unknown) => error);
    expect(ended).toMatchObject({ code: "90010", status: 422, detail: "The call is not alive", title: "Call has already ended", retryable: false, commandId: "cmd-1" });
    expect((ended as Error).message).toContain("90010");

    const server = await client.hangup({ callControlId: "cc-1", commandId: "cmd-2" }).catch((error: unknown) => error);
    expect(server).toMatchObject({ code: "10007", status: 500, retryable: true });

    const gateway = await client.hangup({ callControlId: "cc-1", commandId: "cmd-3" }).catch((error: unknown) => error);
    expect(gateway).toMatchObject({ code: "http_502", status: 502, detail: null });
    expect(logs.map((entry) => entry.status)).toEqual([422, 500, 502]);
    expect(logs[0].error).toContain("TelnyxCommandError");
  });

  it("aborts after the timeout and reports a timeout error", async () => {
    const { impl } = makeFetch([
      (request) =>
        new Promise<Response>((_, reject) => {
          request.init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    ]);
    const { client, logs } = makeClient(impl, { timeoutMs: 20 });

    const failure = await client.playbackStart({ callControlId: "cc-1", commandId: "cmd", audioUrl: "https://media.test/moh.mp3", loop: "infinity" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TelnyxCommandError);
    expect(failure).toMatchObject({ code: "timeout", status: 504, retryable: true });
    expect(logs[0]).toMatchObject({ status: 504, error: expect.stringContaining("timeout") });
  });

  it("maps network failures", async () => {
    const { impl } = makeFetch([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    const { client } = makeClient(impl);
    await expect(client.sendDtmf({ callControlId: "cc-1", commandId: "cmd", digits: "1w2" })).rejects.toMatchObject({ code: "network", status: 502, detail: "fetch failed" });
  });

  it("posts gather_stop with the command id", async () => {
    const { impl, calls } = makeFetch([jsonResponse(200, { data: { result: "ok" } })]);
    const { client } = makeClient(impl);

    await client.gatherStop({ callControlId: "cc-1", commandId: "cmd-9" });

    expect(calls[0].url).toBe("https://telnyx.test/v2/calls/cc-1/actions/gather_stop");
    expect(calls[0].body).toEqual({ command_id: "cmd-9" });
  });

  it("creates conferences and posts conference actions", async () => {
    const { impl, calls } = makeFetch([jsonResponse(200, { data: { id: "conf-1", name: "sess-1", expires_at: "2026-09-03T14:00:00Z" } }), jsonResponse(200, { data: { result: "ok" } })]);
    const { client } = makeClient(impl);

    const conference = await client.createConference({ commandId: "cmd-c", callControlId: "cc-1", name: "sess-1", startConferenceOnCreate: true });
    expect(conference).toEqual({ id: "conf-1", name: "sess-1", expiresAt: "2026-09-03T14:00:00Z" });
    expect(calls[0].body).toEqual({ call_control_id: "cc-1", name: "sess-1", start_conference_on_create: true, command_id: "cmd-c" });

    await client.conferenceAction("conf-1", "hold", { commandId: "cmd-hold", call_control_ids: ["cc-1"], audio_url: "https://media.test/moh.mp3" });
    expect(calls[1].url).toBe("https://telnyx.test/v2/conferences/conf-1/actions/hold");
    expect(calls[1].body).toEqual({ call_control_ids: ["cc-1"], audio_url: "https://media.test/moh.mp3", command_id: "cmd-hold" });
  });

  it("lists phone numbers, creates credentials, mints tokens and sends messages", async () => {
    const { impl, calls } = makeFetch([
      jsonResponse(200, { data: [{ id: "n1", phone_number: "+4210232408700", connection_id: "app-1", status: "active" }] }),
      jsonResponse(201, { data: { id: "cred-1", sip_username: "gencred1", sip_password: "secret", expires_at: null } }),
      new Response("eyJhbGciOi.jwt.token\n", { status: 201, headers: { "content-type": "text/plain" } }),
      jsonResponse(200, { data: { id: "msg-1", to: [{ phone_number: "+421905123456", status: "queued" }] } }),
    ]);
    const { client } = makeClient(impl);

    const numbers = await client.listPhoneNumbers({ pageSize: 50 });
    expect(numbers).toEqual([{ id: "n1", phoneNumber: "+4210232408700", connectionId: "app-1", messagingProfileId: null, status: "active", raw: expect.any(Object) }]);
    expect(calls[0].url).toBe("https://telnyx.test/v2/phone_numbers?page%5Bsize%5D=50");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.body).toBeUndefined();

    const credential = await client.createTelephonyCredential({ name: "op-101", tag: "production" });
    expect(credential).toMatchObject({ id: "cred-1", sipUsername: "gencred1", sipPassword: "secret" });
    expect(calls[1].body).toEqual({ connection_id: "cred-conn-1", name: "op-101", tag: "production" });

    expect(await client.mintCredentialToken("cred-1")).toBe("eyJhbGciOi.jwt.token");
    expect(calls[2].url).toBe("https://telnyx.test/v2/telephony_credentials/cred-1/token");

    const message = await client.sendMessage({ to: "+421905123456", text: "Ahoj" });
    expect(message).toMatchObject({ id: "msg-1", status: "queued" });
    expect(calls[3].body).toEqual({ from: "PomocMotor", to: "+421905123456", text: "Ahoj", messaging_profile_id: "mp-1" });
  });

  it("rejects malformed success responses instead of returning garbage", async () => {
    const { impl } = makeFetch([jsonResponse(200, { data: {} }), jsonResponse(200, { data: {} }), new Response("", { status: 200 })]);
    const { client } = makeClient(impl);
    await expect(client.dial({ commandId: "c", to: "+421905123456", from: "+421232408700" })).rejects.toMatchObject({ code: "invalid_response" });
    await expect(client.createConference({ commandId: "c", callControlId: "cc", name: "x" })).rejects.toMatchObject({ code: "invalid_response" });
    await expect(client.mintCredentialToken("cred-1")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("fails fast on missing identifiers", async () => {
    const { impl } = makeFetch([]);
    const { client } = makeClient(impl, { config: getTelnyxConfig({ ...ENV, TELNYX_CALL_CONTROL_APP_ID: "", TELNYX_CREDENTIAL_CONNECTION_ID: "" }) });
    await expect(client.dial({ commandId: "c", to: "+421905123456", from: "+421232408700" })).rejects.toMatchObject({ code: "missing_connection_id" });
    await expect(client.createTelephonyCredential({ name: "x" })).rejects.toMatchObject({ code: "missing_connection_id" });
    await expect(client.hangup({ callControlId: "", commandId: "c" })).rejects.toMatchObject({ code: "invalid_call_control_id", status: 400 });
    await expect(client.conferenceAction("", "join", { commandId: "c" })).rejects.toMatchObject({ code: "invalid_conference_id" });
    expect(impl).not.toHaveBeenCalled();
  });
});
