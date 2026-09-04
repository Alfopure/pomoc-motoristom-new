import type {
  ConferenceAction,
  ConferenceResult,
  DialParams,
  DialResult,
  TelnyxClient,
  TelnyxLiveGate,
} from "@/server/telephony/telnyx/client";
import { TelnyxCommandError, TelnyxLiveCallsDisabledError, TelnyxSmsDisabledError } from "@/server/telephony/telnyx/client";
import { getTelnyxConfig, type TelnyxConfig } from "@/server/telephony/telnyx/env";

/**
 * Recording stand-in for `TelnyxClient`. Every command is appended to
 * `calls` (method + params); dials and conferences return generated ids.
 * Failures can be injected per method with `failNext`/`failAlways`.
 */

export const FAKE_TELNYX_ENV = {
  TELNYX_API_KEY: "KEYtest",
  TELNYX_API_BASE_URL: "https://telnyx.test/v2",
  TELNYX_PUBLIC_KEY: "9fa2oVc++9rRbzXlbwedJdcwEiA3acPC2HxXzX1fzu0=",
  TELNYX_CALL_CONTROL_APP_ID: "app-test",
  TELNYX_CREDENTIAL_CONNECTION_ID: "cred-conn-test",
  TELNYX_OUTBOUND_VOICE_PROFILE_ID: "ovp-test",
  TELNYX_MESSAGING_PROFILE_ID: "mp-test",
  TELNYX_DEFAULT_FROM_NUMBER: "+421232408718",
  TELNYX_MEDIA_BASE_URL: "https://media.test/telephony",
  TELNYX_LIVE_CALLS_ENABLED: "true",
  TELNYX_SMS_LIVE_SENDS: "true",
};

export type FakeTelnyxCall = { method: string; params: Record<string, unknown> };

export type FakeTelnyx = {
  client: TelnyxClient;
  calls: FakeTelnyxCall[];
  /** Commands of one kind (e.g. `dial`), most recent last. */
  of(method: string): FakeTelnyxCall[];
  failNext(method: string, error?: TelnyxCommandError | string): void;
  /** What `retrieveCall` reports for a leg (default: alive and known). */
  setCallStatus(callControlId: string, verdict: { alive: boolean; known?: boolean }): void;
  failAlways(method: string, error?: TelnyxCommandError | string): void;
  clearFailures(): void;
  reset(): void;
  nextId(prefix: string): string;
};

export function createFakeTelnyx(options: { config?: TelnyxConfig; liveGate?: Partial<TelnyxLiveGate> } = {}): FakeTelnyx {
  const config = options.config ?? getTelnyxConfig(FAKE_TELNYX_ENV);
  if (!config.configured) throw new Error("fake telnyx needs a configured env");
  const liveGate: TelnyxLiveGate = { callsEnabled: true, smsEnabled: true, ...(options.liveGate ?? {}) };
  const calls: FakeTelnyxCall[] = [];
  const oneShot = new Map<string, TelnyxCommandError[]>();
  const callStatuses = new Map<string, { alive: boolean; known?: boolean }>();
  const always = new Map<string, TelnyxCommandError>();
  let counter = 0;

  function toError(error: TelnyxCommandError | string | undefined, method: string): TelnyxCommandError {
    if (error instanceof TelnyxCommandError) return error;
    return new TelnyxCommandError({ code: "fake_failure", status: 422, detail: error ?? `${method} failed (injected)` });
  }

  function record(method: string, params: Record<string, unknown>): void {
    calls.push({ method, params: JSON.parse(JSON.stringify(params ?? {})) as Record<string, unknown> });
    const queued = oneShot.get(method);
    if (queued && queued.length > 0) throw queued.shift();
    const permanent = always.get(method);
    if (permanent) throw permanent;
  }

  const nextId = (prefix: string) => `${prefix}-${++counter}`;

  const client: TelnyxClient = {
    config,
    liveGate,
    async request(method, path, requestOptions) {
      record("request", { method, path, ...(requestOptions ?? {}) });
      return {} as never;
    },
    async dial(params: DialParams): Promise<DialResult> {
      if (!liveGate.callsEnabled) throw new TelnyxLiveCallsDisabledError();
      record("dial", params as unknown as Record<string, unknown>);
      const id = nextId("cc");
      return { callControlId: id, callLegId: `leg-${id}`, callSessionId: params.linkTo ? `sess-of-${params.linkTo}` : `tsess-${id}`, isAlive: true };
    },
    async answer(params) {
      record("answer", params);
    },
    async hangup(params) {
      record("hangup", params);
    },
    async bridge(params) {
      record("bridge", params);
    },
    async transfer(params) {
      if (!liveGate.callsEnabled) throw new TelnyxLiveCallsDisabledError();
      record("transfer", params);
    },
    async gather(params) {
      record("gather", params);
    },
    async gatherUsingAudio(params) {
      record("gatherUsingAudio", params);
    },
    async gatherUsingSpeak(params) {
      record("gatherUsingSpeak", params);
    },
    async gatherStop(params) {
      record("gatherStop", params);
    },
    async speak(params) {
      record("speak", params);
    },
    async playbackStart(params) {
      record("playbackStart", params);
    },
    async playbackStop(params) {
      record("playbackStop", params);
    },
    async sendDtmf(params) {
      record("sendDtmf", params);
    },
    async createConference(params): Promise<ConferenceResult> {
      record("createConference", params);
      return { id: nextId("conf"), name: params.name, expiresAt: null };
    },
    async conferenceAction(conferenceId: string, action: ConferenceAction, body) {
      record(`conference:${action}`, { conferenceId, ...body });
    },
    async retrieveCall(callControlId: string) {
      record("retrieveCall", { callControlId });
      const verdict = callStatuses.get(callControlId);
      return { callControlId, known: verdict?.known ?? true, alive: verdict?.alive ?? true, callSessionId: null, raw: verdict ? {} : null };
    },
    async switchSupervisorRole(params) {
      record("switchSupervisorRole", { ...params });
    },
    async listPhoneNumbers(params = {}) {
      record("listPhoneNumbers", params);
      return [];
    },
    async createTelephonyCredential(params) {
      record("createTelephonyCredential", params);
      const id = nextId("cred");
      return { id, sipUsername: `gencred${id.replace(/\D/g, "")}`, sipPassword: "secret", expiresAt: params.expiresAt ?? null, raw: {} };
    },
    async deleteTelephonyCredential(credentialId) {
      record("deleteTelephonyCredential", { credentialId });
    },
    async mintCredentialToken(credentialId) {
      record("mintCredentialToken", { credentialId });
      // Unsigned JWT with a 24 h expiry relative to now.
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ sub: credentialId, exp: Math.floor(Date.now() / 1000) + 86_400 })).toString("base64url");
      return `${header}.${payload}.`;
    },
    async sendMessage(params) {
      if (!liveGate.smsEnabled) throw new TelnyxSmsDisabledError();
      record("sendMessage", params);
      return { id: nextId("msg"), status: "queued", raw: {} };
    },
  };

  return {
    client,
    calls,
    nextId,
    of(method) {
      return calls.filter((call) => call.method === method);
    },
    setCallStatus(callControlId, verdict) {
      callStatuses.set(callControlId, verdict);
    },
    failNext(method, error) {
      const list = oneShot.get(method) ?? [];
      list.push(toError(error, method));
      oneShot.set(method, list);
    },
    failAlways(method, error) {
      always.set(method, toError(error, method));
    },
    clearFailures() {
      oneShot.clear();
      always.clear();
    },
    reset() {
      calls.length = 0;
      callStatuses.clear();
      oneShot.clear();
      always.clear();
    },
  };
}
