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

export type PhysicalLeg = { id: string; to: string | null; answered: boolean; ended: boolean };
export type PhysicalProvider = {
  legs: Map<string, PhysicalLeg>;
  /** Delivery of a provider answer happens before the application webhook. */
  answered(id: string): void;
  ended(id: string): void;
  connected(left: string, right: string): boolean;
  connections(): Array<[string, string]>;
};

export type FakeTelnyx = {
  client: TelnyxClient;
  calls: FakeTelnyxCall[];
  physical: PhysicalProvider;
  /** Provider executes the operation but its HTTP acknowledgement is lost. */
  loseNextResponse(method: string): void;
  /** Commands of one kind (e.g. `dial`), most recent last. */
  of(method: string): FakeTelnyxCall[];
  failNext(method: string, error?: TelnyxCommandError | string): void;
  /** What `retrieveCall` reports for a leg (default: alive and known). */
  setCallStatus(callControlId: string, verdict: { alive: boolean; known?: boolean }): void;
  /** Exact single-page provider response, independent of webhook delivery. */
  setConferenceParticipants(conferenceId: string, rows: unknown[]): void;
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
  const conferenceParticipants = new Map<string, Set<string>>();
  const conferenceParticipantSnapshots = new Map<string, unknown[]>();
  const conferenceParticipantFlags = new Map<string, { muted: boolean; on_hold: boolean; whisper_call_control_ids: string[] }>();
  const always = new Map<string, TelnyxCommandError>();
  let counter = 0;
  const physicalLegs = new Map<string, PhysicalLeg>();
  const bridgePairs = new Map<string, [string, string]>();
  const accepted = new Map<string, unknown>();
  const lostResponses = new Map<string, number>();
  const ensureLeg = (id: string, to: string | null = null) => {
    if (!physicalLegs.has(id)) physicalLegs.set(id, { id, to, answered: false, ended: false });
    return physicalLegs.get(id)!;
  };
  const armBridge = (left: string, right: string) => {
    ensureLeg(left); ensureLeg(right);
    bridgePairs.set([left, right].sort().join(":"), [left, right]);
  };
  const physical: PhysicalProvider = {
    legs: physicalLegs,
    answered(id) { ensureLeg(id).answered = true; },
    ended(id) { ensureLeg(id).ended = true; },
    connections() {
      const pairs = new Map(bridgePairs);
      for (const members of conferenceParticipants.values()) {
        const ids = [...members];
        for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) pairs.set([ids[a], ids[b]].sort().join(":"), [ids[a], ids[b]]);
      }
      return [...pairs.values()].filter(([left, right]) => [left, right].every((id) => physicalLegs.get(id)?.answered && !physicalLegs.get(id)?.ended));
    },
    connected(left, right) { return this.connections().some(([a, b]) => a === left && b === right || a === right && b === left); },
  };
  function execute<T>(method: string, params: Record<string, unknown>, action: () => T): T {
    record(method, params);
    const commandId = params.commandId ?? params.command_id;
    const key = typeof commandId === "string" ? `${method}:${commandId}` : null;
    if (key && accepted.has(key)) return accepted.get(key) as T;
    const result = action();
    if (key) accepted.set(key, result);
    const lost = lostResponses.get(method) ?? 0;
    if (lost > 0) {
      lostResponses.set(method, lost - 1);
      throw new TelnyxCommandError({ code: "timeout", status: 504, retryable: true, detail: "Provider executed command; response lost", commandId: typeof commandId === "string" ? commandId : null });
    }
    return result;
  }

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
      const participants = /^\/conferences\/([^/]+)\/participants$/.exec(path);
      if (method === "GET" && participants) {
        const conferenceId = decodeURIComponent(participants[1]);
        const data = conferenceParticipantSnapshots.get(conferenceId) ?? [...(conferenceParticipants.get(conferenceId) ?? [])]
          .filter(id => !physicalLegs.get(id)?.ended).map(call_control_id => ({ record_type: "participant", id: `participant-${call_control_id}`,
            call_control_id, call_leg_id: `leg-${call_control_id}`, conference: { id: conferenceId },
            status: physicalLegs.get(call_control_id)?.answered ? "joined" : "joining",
            ...(conferenceParticipantFlags.get(`${conferenceId}:${call_control_id}`) ?? { muted: false, on_hold: false, whisper_call_control_ids: [] }) }));
        return { data, meta: { page_number: 1, page_size: 250, total_pages: 1, total_results: data.length } } as never;
      }
      return {} as never;
    },
    async dial(params: DialParams): Promise<DialResult> {
      if (!liveGate.callsEnabled) throw new TelnyxLiveCallsDisabledError();
      return execute("dial", params as unknown as Record<string, unknown>, () => {
        const id = nextId("cc"); ensureLeg(id, Array.isArray(params.to) ? params.to[0] : params.to);
        if (params.bridgeOnAnswer && params.linkTo) armBridge(params.linkTo, id);
        return { callControlId: id, callLegId: `leg-${id}`, callSessionId: params.linkTo ? `sess-of-${params.linkTo}` : `tsess-${id}`, isAlive: true };
      });
    },
    async answer(params) {
      execute("answer", params, () => physical.answered(params.callControlId));
    },
    async hangup(params) {
      execute("hangup", params, () => physical.ended(params.callControlId));
    },
    async bridge(params) {
      execute("bridge", params, () => armBridge(params.callControlId, params.targetCallControlId));
    },
    async recordingStart(params) { return execute("recordingStart", params, () => ({ recordingId: nextId("recording") })); },
    async recordingStop(params) { record("recordingStop", params); },
    async transfer(params) {
      if (!liveGate.callsEnabled) throw new TelnyxLiveCallsDisabledError();
      execute("transfer", params, () => {
        const target = nextId("transfer"); ensureLeg(target, params.to); armBridge(params.callControlId, target);
      });
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
      return execute("createConference", params, () => {
        const id = nextId("conf"); ensureLeg(params.callControlId);
        conferenceParticipants.set(id, new Set([params.callControlId]));
        return { id, name: params.name, expiresAt: null };
      });
    },
    async conferenceAction(conferenceId: string, action: ConferenceAction, body) {
      execute(`conference:${action}`, { conferenceId, ...body }, () => {
      if (action === "join" && typeof body.call_control_id === "string") {
        const participants = conferenceParticipants.get(conferenceId) ?? new Set<string>();
        ensureLeg(body.call_control_id); participants.add(body.call_control_id); conferenceParticipants.set(conferenceId, participants);
        conferenceParticipantFlags.set(`${conferenceId}:${body.call_control_id}`, { muted: body.muted === true, on_hold: body.hold === true,
          whisper_call_control_ids: Array.isArray(body.whisper_call_control_ids) ? body.whisper_call_control_ids as string[] : [] });
      }
      if (action === "leave" && typeof body.call_control_id === "string") conferenceParticipants.get(conferenceId)?.delete(body.call_control_id);
      if (["mute", "unmute", "hold", "unhold"].includes(action)) {
        const ids = Array.isArray(body.call_control_ids) ? body.call_control_ids : [...(conferenceParticipants.get(conferenceId) ?? [])];
        for (const id of ids) if (typeof id === "string") {
          const key = `${conferenceId}:${id}`, flags = conferenceParticipantFlags.get(key) ?? { muted: false, on_hold: false, whisper_call_control_ids: [] };
          conferenceParticipantFlags.set(key, { ...flags, ...(["mute", "unmute"].includes(action) ? { muted: action === "mute" } : { on_hold: action === "hold" }) });
        }
      }
      });
    },
    async retrieveCall(callControlId: string) {
      record("retrieveCall", { callControlId });
      const verdict = callStatuses.get(callControlId);
      return { callControlId, known: verdict?.known ?? true, alive: verdict?.alive ?? true, callSessionId: null, raw: verdict ? { is_alive: verdict.alive } : null };
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
    physical,
    loseNextResponse(method) { lostResponses.set(method, (lostResponses.get(method) ?? 0) + 1); },
    nextId,
    of(method) {
      return calls.filter((call) => call.method === method);
    },
    setCallStatus(callControlId, verdict) {
      callStatuses.set(callControlId, verdict);
    },
    setConferenceParticipants(conferenceId, rows) {
      conferenceParticipantSnapshots.set(conferenceId, structuredClone(rows));
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
      lostResponses.clear();
      always.clear();
    },
    reset() {
      calls.length = 0;
      physicalLegs.clear(); bridgePairs.clear(); conferenceParticipants.clear(); accepted.clear();
      conferenceParticipantSnapshots.clear(); conferenceParticipantFlags.clear();
      callStatuses.clear();
      oneShot.clear();
      lostResponses.clear();
      always.clear();
    },
  };
}
