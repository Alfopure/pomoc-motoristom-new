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
import { dispatchJournaled, dispatchJournaledBatch, journalRequest } from "@/server/telephony/provider-journal";
import { sessionOwnership } from "@/server/telephony/ownership";

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
  failNext(method: string, error?: Error | string): void;
  /** What `retrieveCall` reports for a leg (default: alive and known). */
  setCallStatus(callControlId: string, verdict: { alive: boolean; known?: boolean }): void;
  /** Exact single-page provider response, independent of webhook delivery. */
  setConferenceParticipants(conferenceId: string, rows: unknown[]): void;
  failAlways(method: string, error?: Error | string): void;
  clearFailures(): void;
  reset(): void;
  nextId(prefix: string): string;
};

/**
 * Where each command would have gone on the wire.
 *
 * The fake implements `TelnyxClient` method by method rather than over HTTP,
 * so nothing here ever built a path — and `journalRequest` keys the provider
 * journal on the method and path. Without them `prepare_v2` and `result_v2`
 * never ran in a test, and every branch that depends on them was unreachable:
 * a command already accepted, a command the fence refused, a command whose
 * outcome was never recorded. Those branches decide whether a redelivered
 * webhook re-dials an operator.
 *
 * The paths mirror the real client's. They do not have to match Telnyx byte
 * for byte, but they do have to be stable and distinct, because the journal
 * fingerprints them.
 */
const CALL_ACTIONS: Record<string, string> = {
  answer: "answer", hangup: "hangup", bridge: "bridge", transfer: "transfer",
  gather: "gather", gatherUsingAudio: "gather_using_audio", gatherUsingSpeak: "gather_using_speak",
  gatherStop: "gather_stop", speak: "speak", playbackStart: "playback_start", playbackStop: "playback_stop",
  sendDtmf: "send_dtmf", switchSupervisorRole: "switch_supervisor_role",
  recordingStart: "record_start", recordingStop: "record_stop",
};

function wireRequest(method: string, params: Record<string, unknown>): { path: string; body: Record<string, unknown> } | null {
  // `commandId` is the identity, not part of the payload: the real client
  // sends it as `command_id` alongside the body. Leaving it in here would give
  // the same command two fingerprints — one when it is sent alone and another
  // when it is sent as part of a group — and a replay would see a payload
  // identity conflict where there is none.
  const rest = Object.fromEntries(Object.entries(params).filter(([key]) => key !== "commandId"));
  if (method === "dial") return { path: "/calls", body: rest };
  if (method === "createConference") return { path: "/conferences", body: rest };
  const conference = /^conference:(.+)$/.exec(method);
  if (conference) {
    const { conferenceId, ...body } = rest;
    return { path: `/conferences/${encodeURIComponent(String(conferenceId))}/actions/${conference[1]}`, body };
  }
  const action = CALL_ACTIONS[method];
  if (!action) return null;
  const { callControlId, ...body } = rest;
  return { path: `/calls/${encodeURIComponent(String(callControlId))}/actions/${action}`, body };
}

export function createFakeTelnyx(options: { config?: TelnyxConfig; liveGate?: Partial<TelnyxLiveGate> } = {}): FakeTelnyx {
  const config = options.config ?? getTelnyxConfig(FAKE_TELNYX_ENV);
  if (!config.configured) throw new Error("fake telnyx needs a configured env");
  const liveGate: TelnyxLiveGate = { callsEnabled: true, smsEnabled: true, ...(options.liveGate ?? {}) };
  const calls: FakeTelnyxCall[] = [];
  const oneShot = new Map<string, Error[]>();
  const callStatuses = new Map<string, { alive: boolean; known?: boolean }>();
  const conferenceParticipants = new Map<string, Set<string>>();
  const conferenceParticipantSnapshots = new Map<string, unknown[]>();
  const conferenceParticipantFlags = new Map<string, { muted: boolean; on_hold: boolean; whisper_call_control_ids: string[] }>();
  const always = new Map<string, Error>();
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
  /**
   * One voice command, through the same fenced-dispatch protocol the real
   * client uses.
   *
   * The journal is only active for a contract-2 session (`journalRequest`
   * returns null otherwise), so contract-1 tests are unaffected — but where it
   * is active, `prepare_v2` decides whether this command reaches the double at
   * all, and `result_v2` records what it answered.
   */
  async function execute<T>(method: string, params: Record<string, unknown>, action: () => T, options?: { journalled?: boolean; raw?: boolean }): Promise<T> {
    const commandId = params.commandId ?? params.command_id;
    const wire = options?.journalled ? null : wireRequest(method, params);
    const journal = wire
      ? journalRequest("POST", wire.path, typeof commandId === "string" ? commandId : null,
          JSON.stringify(compactUndefined({ ...wire.body, command_id: commandId })))
      : null;

    const outcome = await dispatchJournaled(
      journal,
      async () => {
        recordOnly(method, params);
        const injected = takeFailure(method);
        // A provider that answers 4xx has answered: the journal records the
        // refusal, and a replay of the same command gets it back rather than
        // dialling again. A transport failure has not, and must not be
        // recorded — that is the difference between a rejection and an
        // unknown outcome.
        if (injected) {
          if (injected instanceof TelnyxCommandError && injected.status >= 400) {
            return { status: injected.status, result: { errors: [{ code: injected.code, detail: injected.message }] }, thrown: injected };
          }
          throw injected;
        }

        const key = typeof commandId === "string" ? `${method}:${commandId}` : null;
        if (key && accepted.has(key)) return { status: 200, result: accepted.get(key) as T };
        const result = action();
        if (key) accepted.set(key, result);
        const lost = lostResponses.get(method) ?? 0;
        if (lost > 0) {
          lostResponses.set(method, lost - 1);
          // Executed, acknowledgement never arrived: nothing is recorded, so
          // the next attempt has to ask rather than assume.
          throw new TelnyxCommandError({ code: "timeout", status: 504, retryable: true, detail: "Provider executed command; response lost", commandId: typeof commandId === "string" ? commandId : null });
        }
        return { status: 200, result };
      },
      {
        error: (status, body, replayedCommandId) => new TelnyxCommandError({
          code: "journal_replay", status,
          detail: `replayed provider outcome: ${JSON.stringify(body)}`,
          commandId: replayedCommandId,
        }),
      },
    );

    if (outcome.cached) return outcome.result as T;
    if (outcome.sent.thrown && !options?.raw) throw outcome.sent.thrown;
    return options?.raw ? (outcome.sent as unknown as T) : (outcome.sent.result as T);
  }

  /** Drops `undefined` values the way the real client's `compact` does. */
  function compactUndefined(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
  }

  // Any `Error` passes through untouched: the provider layer raises more than
  // provider errors. `prepareProviderRequest` fences a command against the
  // database before it reaches the wire, so a refusal can arrive as a plain
  // `Error` carrying a SQLSTATE, and a double that rewrote it could not
  // reproduce what the command loop actually sees.
  function toError(error: Error | string | undefined, method: string): Error {
    if (error instanceof Error) return error;
    return new TelnyxCommandError({ code: "fake_failure", status: 422, detail: error ?? `${method} failed (injected)` });
  }

  function recordOnly(method: string, params: Record<string, unknown>): void {
    calls.push({ method, params: JSON.parse(JSON.stringify(params ?? {})) as Record<string, unknown> });
  }

  /** The injected failure for this command, if one is queued. */
  function takeFailure(method: string): Error | null {
    const queued = oneShot.get(method);
    if (queued && queued.length > 0) return queued.shift()!;
    return always.get(method) ?? null;
  }

  function record(method: string, params: Record<string, unknown>): void {
    recordOnly(method, params);
    const failure = takeFailure(method);
    if (failure) throw failure;
  }

  const nextId = (prefix: string) => `${prefix}-${++counter}`;

  /** Which recorded method each wire action belongs to, so a batch records what a single call would. */
  const FAKE_ACTION_METHODS: Record<string, string> = Object.fromEntries(
    Object.entries(CALL_ACTIONS).map(([method, action]) => [action, method]),
  );

  /** One call action against the modelled provider. */
  async function actionOnce<T = void>(method: string, item: { callControlId: string; commandId: string; body: Record<string, unknown> }, options?: { journalled?: boolean; raw?: boolean }): Promise<T> {
    const params = { callControlId: item.callControlId, commandId: item.commandId, ...item.body };
    return execute(method, params, () => {
      if (method === "hangup") physical.ended(item.callControlId);
      if (method === "answer") physical.answered(item.callControlId);
      return undefined;
    }, options) as Promise<T>;
  }

  /** One dial against the modelled provider; the batch has already journalled it. */
  function dialOnce<T = DialResult>(params: DialParams, options?: { journalled?: boolean; raw?: boolean }): Promise<T> {
    return execute("dial", params as unknown as Record<string, unknown>, () => {
      const id = nextId("cc"); ensureLeg(id, Array.isArray(params.to) ? params.to[0] : params.to);
      if (params.bridgeOnAnswer && params.linkTo) armBridge(params.linkTo, id);
      return { callControlId: id, callLegId: `leg-${id}`, callSessionId: params.linkTo ? `sess-of-${params.linkTo}` : `tsess-${id}`, isAlive: true };
    }, options) as Promise<T>;
  }

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
    /**
     * A ring step under one journal, mirroring the real client: the members
     * are fenced together, dialled together and recorded together.
     *
     * Without a contract-2 scope there is nothing to batch, so it falls back
     * to the ordinary dials — which is also what keeps contract-1 tests
     * unchanged.
     */
    /** A run of call actions under one journal, mirroring the real client. */
    async callActionMany(list: readonly { callControlId: string; action: string; commandId: string; body: Record<string, unknown> }[]): Promise<Array<PromiseSettledResult<void>>> {
      if (!list.length) return [];
      const owner = sessionOwnership.getStore();
      const methods = list.map((item) => FAKE_ACTION_METHODS[item.action] ?? item.action);
      const journals = list.map((item) =>
        journalRequest("POST", `/calls/${encodeURIComponent(item.callControlId)}/actions/${item.action}`,
          typeof item.commandId === "string" ? item.commandId : null,
          JSON.stringify(compactUndefined({ ...item.body, command_id: item.commandId }))));
      const one = (index: number) => actionOnce<{ status: number; result: unknown; thrown?: unknown }>(methods[index], list[index], { journalled: true, raw: true });
      if (!owner || owner.contract !== 2 || journals.some((journal) => !journal)) {
        return Promise.allSettled(list.map((_, index) => actionOnce(methods[index], list[index])));
      }
      const settled = await dispatchJournaledBatch(
        list.map((_, index) => ({ journal: journals[index]!, send: () => one(index) })),
        { error: (status, body, commandId) => new TelnyxCommandError({ code: "journal_replay", status, detail: `replayed provider outcome: ${JSON.stringify(body)}`, commandId }) },
      );
      return settled.map((outcome) => {
        if (outcome.status === "rejected") return outcome as PromiseRejectedResult;
        const thrown = outcome.value.cached ? null : (outcome.value.sent as { thrown?: unknown }).thrown;
        return thrown ? { status: "rejected" as const, reason: thrown } : { status: "fulfilled" as const, value: undefined };
      });
    },

    async dialMany(list: readonly DialParams[]): Promise<Array<PromiseSettledResult<DialResult>>> {
      if (!list.length) return [];
      if (!liveGate.callsEnabled) throw new TelnyxLiveCallsDisabledError();
      const owner = sessionOwnership.getStore();
      const journals = list.map((params) => {
        const wire = wireRequest("dial", params as unknown as Record<string, unknown>)!;
        return journalRequest("POST", wire.path, typeof params.commandId === "string" ? params.commandId : null,
          JSON.stringify(compactUndefined({ ...wire.body, command_id: params.commandId })));
      });
      if (!owner || owner.contract !== 2 || journals.some((journal) => !journal)) {
        return Promise.allSettled(list.map((params) => client.dial(params)));
      }

      const settled = await dispatchJournaledBatch(
        list.map((params, index) => ({
          journal: journals[index]!,
          send: () => dialOnce<{ status: number; result: unknown; thrown?: unknown }>(params, { journalled: true, raw: true }),
        })),
        { error: (status, body, commandId) => new TelnyxCommandError({ code: "journal_replay", status, detail: `replayed provider outcome: ${JSON.stringify(body)}`, commandId }) },
      );
      return settled.map((outcome) => {
        if (outcome.status === "rejected") return outcome as PromiseRejectedResult;
        // A refusal the provider answered is recorded first and raised second,
        // and it is this member's alone.
        const thrown = outcome.value.cached ? null : (outcome.value.sent as { thrown?: unknown }).thrown;
        if (thrown) return { status: "rejected" as const, reason: thrown };
        return { status: "fulfilled" as const, value: (outcome.value.cached ? outcome.value.result : (outcome.value.sent as { result: unknown }).result) as DialResult };
      });
    },

    async dial(params: DialParams): Promise<DialResult> {
      if (!liveGate.callsEnabled) throw new TelnyxLiveCallsDisabledError();
      return dialOnce(params);
    },
    async answer(params) {
      await execute("answer", params, () => physical.answered(params.callControlId));
    },
    async hangup(params) {
      await execute("hangup", params, () => physical.ended(params.callControlId));
    },
    async bridge(params) {
      await execute("bridge", params, () => armBridge(params.callControlId, params.targetCallControlId));
    },
    async recordingStart(params) { return execute("recordingStart", params, () => ({ recordingId: nextId("recording") })); },
    async recordingStop(params) { await execute("recordingStop", params, () => undefined); },
    async transfer(params) {
      if (!liveGate.callsEnabled) throw new TelnyxLiveCallsDisabledError();
      await execute("transfer", params, () => {
        const target = nextId("transfer"); ensureLeg(target, params.to); armBridge(params.callControlId, target);
      });
    },
    async gather(params) {
      await execute("gather", params, () => undefined);
    },
    async gatherUsingAudio(params) {
      await execute("gatherUsingAudio", params, () => undefined);
    },
    async gatherUsingSpeak(params) {
      await execute("gatherUsingSpeak", params, () => undefined);
    },
    async gatherStop(params) {
      await execute("gatherStop", params, () => undefined);
    },
    async speak(params) {
      await execute("speak", params, () => undefined);
    },
    async playbackStart(params) {
      await execute("playbackStart", params, () => undefined);
    },
    async playbackStop(params) {
      await execute("playbackStop", params, () => undefined);
    },
    async sendDtmf(params) {
      await execute("sendDtmf", params, () => undefined);
    },
    async createConference(params): Promise<ConferenceResult> {
      return execute("createConference", params, () => {
        const id = nextId("conf"); ensureLeg(params.callControlId);
        conferenceParticipants.set(id, new Set([params.callControlId]));
        return { id, name: params.name, expiresAt: null };
      });
    },
    async conferenceAction(conferenceId: string, action: ConferenceAction, body) {
      await execute(`conference:${action}`, { conferenceId, ...body }, () => {
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
      await execute("switchSupervisorRole", { ...params }, () => undefined);
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
