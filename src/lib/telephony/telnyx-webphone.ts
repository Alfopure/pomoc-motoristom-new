"use client";

/**
 * Browser phone (Telnyx WebRTC) controller.
 *
 * Responsibilities kept here — everything that needs a browser:
 * mint/refresh the JWT from `POST /api/telephony/webphone/token`, own the
 * `@telnyx/webrtc` client and the single active call, ring audibly and
 * visibly, keep `motorist_operator_devices.device_seen_at` warm with a 30 s
 * heartbeat driven by a browser worker (plus a `sendBeacon` when hidden or
 * closed), and shut
 * this tab's phone down when the heartbeat comes back 409 because a newer tab
 * took the credential.
 *
 * Every decision it makes is delegated to `webphone-model.ts`, which is pure
 * and unit-tested; this file is the shell that performs the effects.
 *
 * The SDK is imported lazily (`await import("@telnyx/webrtc")`) so the console
 * bundle does not carry a WebRTC stack for users who never open the phone.
 */

import { applyStoredAudioOutput, REMOTE_AUDIO_ELEMENT_ID } from "@/lib/telephony/audio-output";
import { BrowserIncomingRingtone } from "@/lib/telephony/browser-ringtone";
import { telephonyJson, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import {
  EXPECTED_LEG_TTL_MS,
  heartbeatRegistrationState,
  matchAutoAnswer,
  matchExpectedLeg,
  pruneExpectedLegs,
  rememberExpectedLeg,
  reduceWebphone,
  WEBPHONE_HEARTBEAT_MS,
  WEBPHONE_INITIAL_STATE,
  webphoneRegistrationView,
  type ExpectedOperatorLeg,
  type WebphoneCredentials,
  type WebphoneEffect,
  type WebphoneEvent,
  type WebphoneRegistrationView,
  type WebphoneState,
  type WebphoneStatus,
} from "@/lib/telephony/webphone-model";

/**
 * The slice of `@telnyx/webrtc` this module uses. Declared structurally so the
 * controller can be driven by a fake in tests; `telnyx-webphone.test.ts`
 * asserts that the real `Call`/`TelnyxRTC` types satisfy these shapes.
 */
export type WebphoneSdkCall = {
  id: string;
  state: string;
  direction: string;
  options: {
    remoteCallerNumber?: string;
    remoteCallerName?: string;
    callerNumber?: string;
    destinationNumber?: string;
    customHeaders?: Array<{ name?: string; value?: string }>;
  };
  telnyxIDs: { telnyxCallControlId: string; telnyxSessionId: string; telnyxLegId: string };
  isAudioMuted: boolean;
  answer: (params?: never) => Promise<void> | void;
  hangup: () => Promise<void> | void;
  muteAudio: () => void;
  unmuteAudio: () => void;
  dtmf: (digit: string) => void;
};

export type WebphoneSdkClient = {
  on: (event: string, callback: (payload: never) => void) => unknown;
  off: (event: string, callback?: (payload: never) => void) => unknown;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** `HTMLMediaElement | string | Function` in the SDK; kept opaque so both stay assignable. */
  remoteElement: unknown;
};

export type WebphoneSdkNotification = {
  type: string;
  call?: WebphoneSdkCall;
  error?: Error;
};

export type WebphoneCallView = {
  id: string;
  /** SDK call state (`ringing`, `active`, `held`, `hangup`, …). */
  state: string;
  direction: "inbound" | "outbound";
  number: string;
  callerName: string | null;
  telnyxCallControlId: string | null;
  /** Our own session id when this leg came from a dial this tab started. */
  sessionId: string | null;
  muted: boolean;
  ringing: boolean;
  active: boolean;
};

export type WebphoneSnapshot = {
  onDemand?: boolean;
  sharedTab?: boolean;
  status: WebphoneStatus;
  registration: WebphoneRegistrationView;
  sipUsername: string | null;
  deviceSessionId: string | null;
  call: WebphoneCallView | null;
  /** Dial/pickup legs accepted by the API but not yet correlated to an invite. */
  pendingOperatorLegs?: number;
  /** Answer is negotiating media; repeated taps must not create another peer. */
  answering?: boolean;
  /** Remote audio was refused or paused and needs a user gesture to resume. */
  audioBlocked?: boolean;
  /** A call/media failure does not mean that the SIP registration was lost. */
  callError?: string | null;
  /** Last operator-facing error from an SDK/HTTP failure. */
  message: string | null;
};

export type IncomingOfferPolicy = { presenceRevision?: number; automaticAllowed: boolean; requestPending?: boolean; explicitLegs?: Array<{ callControlId: string; sessionId: string }> };

export type TelnyxWebphoneOptions = {
  deviceKind?: "web" | "mobile";
  resumeSessionId?: string | null;
  handoff?: boolean;
  onSession?: (id: string) => void;
  now?: () => number;
  random?: () => number;
  /** Test seam: replaces `@telnyx/webrtc`'s `new TelnyxRTC({ login_token })`. */
  createClient?: (credentials: WebphoneCredentials) => Promise<WebphoneSdkClient> | WebphoneSdkClient;
  /** Test seam for the two HTTP calls this module makes. */
  requestJson?: typeof telephonyJson;
  setTimeout?: (handler: () => void, timeoutMs: number) => number;
  clearTimeout?: (handle: number) => void;
  logger?: (entry: Record<string, unknown>) => void;
  /** Disable the audible ringtone / desktop notification (tests, kiosk mode). */
  silent?: boolean;
};

const TOKEN_URL = "/api/telephony/webphone/token";
const HEARTBEAT_URL = "/api/telephony/devices/heartbeat";
const RINGING_STATES = new Set(["ringing", "recovering"]);
const ACTIVE_STATES = new Set(["active", "held", "early", "answering"]);
const DEAD_STATES = new Set(["hangup", "destroy", "purge"]);

export class TelnyxWebphone {
  private state: WebphoneState = WEBPHONE_INITIAL_STATE;
  private client: WebphoneSdkClient | null = null;
  private call: WebphoneSdkCall | null = null;
  private expected: ExpectedOperatorLeg[] = [];
  private incomingPolicy: IncomingOfferPolicy = { automaticAllowed: true };
  private withdrawnInvites = new Set<string>();
  /** Our session id for the call currently on this tab's media leg, when known. */
  private callSessionId: string | null = null;
  private listeners = new Set<(snapshot: WebphoneSnapshot) => void>();
  private retryTimer: number | null = null;
  private refreshTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private heartbeatWorker: Worker | null = null;
  private expectedLegTimer: number | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private ringtone: BrowserIncomingRingtone | null = null;
  private ringing = false;
  private notification: Notification | null = null;
  private started = false;
  private connecting = false;
  private clientGeneration = 0;
  private answeringCallId: string | null = null;
  private answeredCallId: string | null = null;
  private callError: string | null = null;
  private audioBlocked = false;
  private audioAttempt = 0;
  /** Set by `takeover()`: the next mint may revoke another tab's live device. */
  private takeoverRequested = false;
  private snapshot: WebphoneSnapshot;
  private resumeSessionId: string | null = null;
  private handoffPending = false;
  private mintGeneration = 0;
  private readonly options: TelnyxWebphoneOptions;
  private readonly boundVisibility = () => this.onVisibilityChange();
  private readonly boundPageHide = () => {
    this.stopHeartbeat();
    this.beaconHeartbeat({ leaving: true });
  };
  private readonly boundResume = () => this.onResume();
  private readonly boundAudioReady = () => void this.playRemoteAudio();
  private readonly boundAudioPlaying = () => this.setAudioBlocked(false);
  private readonly boundAudioPause = () => {
    if (this.hasRemoteMedia()) this.setAudioBlocked(true);
  };

  constructor(options: TelnyxWebphoneOptions = {}) {
    this.options = options;
    this.resumeSessionId = options.resumeSessionId ?? null;
    this.handoffPending = options.handoff === true;
    this.snapshot = this.buildSnapshot();
  }

  // --- public API ------------------------------------------------------------

  getSnapshot(): WebphoneSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: WebphoneSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.boundVisibility);
      window.addEventListener("pagehide", this.boundPageHide);
      window.addEventListener("pageshow", this.boundResume);
      window.addEventListener("online", this.boundResume);
    }
    this.dispatch({ type: "start" });
    this.startHeartbeat();
  }

  stop(): void {
    if (!this.started) { this.disposeAudio(); return; }
    this.beaconHeartbeat({ leaving: true });
    this.mintGeneration++;
    this.started = false;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.boundVisibility);
      window.removeEventListener("pagehide", this.boundPageHide);
      window.removeEventListener("pageshow", this.boundResume);
      window.removeEventListener("online", this.boundResume);
    }
    this.stopHeartbeat();
    this.clearTimer("expectedLegTimer");
    this.expected = [];
    this.callError = null;
    this.dispatch({ type: "stop" });
    this.disposeAudio();
  }

  /**
   * Records the operator leg of a dial this tab just started, so its invite is
   * answered without the operator touching anything (design §2.2). Correlation
   * is on `telnyxIDs.telnyxCallControlId`, never on arrival order.
   */
  expectOperatorLeg(input: { callControlId: string; sessionId: string }): void {
    this.expected = rememberExpectedLeg(this.expected, { ...input, at: this.now() }, this.now());
    // The invite usually arrives before `POST /api/telephony/calls` answers (the
    // route still writes leg/session rows), so the ringing call is re-evaluated
    // here instead of only at invite time.
    if (!this.autoAnswerCurrentCall()) {
      this.scheduleExpectedLegExpiry();
      this.publish();
    }
  }

  /** Server presence controls automatic offers; explicit legs use exact IDs. */
  setIncomingOfferPolicy(policy: IncomingOfferPolicy): void {
    if ((policy.presenceRevision ?? 0) < (this.incomingPolicy.presenceRevision ?? 0)) return;
    this.incomingPolicy = policy;
    for (const leg of policy.explicitLegs ?? []) {
      this.expected = rememberExpectedLeg(this.expected, { ...leg, at: this.now() }, this.now());
    }
    if (this.call && RINGING_STATES.has(String(this.call.state).toLowerCase())) {
      if (!this.suppressAutomaticInvite(this.call)) this.autoAnswerCurrentCall();
    }
    this.publish();
  }

  private suppressAutomaticInvite(call: WebphoneSdkCall): boolean {
    if (!RINGING_STATES.has(String(call.state).toLowerCase()) || call.direction !== "inbound") return false;
    const id = call.telnyxIDs?.telnyxCallControlId || call.id;
    const exact = matchExpectedLeg(this.expected, { telnyxCallControlId: call.telnyxIDs?.telnyxCallControlId }, this.now());
    if (!this.withdrawnInvites.has(id) && (this.incomingPolicy.automaticAllowed || exact || this.callSessionId)) return false;
    this.stopRinging();
    // A pickup response may arrive after its invite. Keep it silent until its
    // exact identity is known; an auto-answer header is never permission.
    if (!this.withdrawnInvites.has(id) && this.incomingPolicy.requestPending) return true;
    if (!this.withdrawnInvites.has(id)) {
      this.withdrawnInvites.add(id);
      void Promise.resolve().then(() => call.hangup()).catch(() => {
        this.callError = "Pauza je uložená. Zvonenie je stíšené; zrušenie ponuky sa ešte dokončuje.";
        this.publish();
      });
    }
    return true;
  }

  /**
   * Takes the phone over from another tab that is ringing or on a call. The
   * server refuses a plain mint in that situation (409); this is the operator's
   * explicit confirmation.
   */
  takeover(): void {
    this.takeoverRequested = true;
    this.dispatch({ type: "start" });
  }

  /** Unlocks sound only; notification permission belongs to the explicit settings flow. */
  async unlockAudio(): Promise<void> {
    if (this.options.silent) return;
    await this.getRingtone().unlock();
    if (this.started && this.ringing) await this.getRingtone().start();
  }

  /** Call from a tap: both audio APIs start before awaiting, preserving the gesture. */
  async resumeAudio(): Promise<void> {
    await Promise.allSettled([this.unlockAudio(), this.playRemoteAudio()]);
  }

  dismissCallError(): void {
    this.callError = null;
    this.publish();
  }

  answer(): void {
    if (this.call) void this.answerCall(this.call);
  }

  async hangup(): Promise<void> {
    const call = this.call;
    if (!call) return;
    this.stopRinging();
    await Promise.resolve(call.hangup()).catch(() => undefined);
    this.publish();
  }

  setMuted(muted: boolean): void {
    const call = this.call;
    if (!call) return;
    if (muted) call.muteAudio();
    else call.unmuteAudio();
    this.publish();
  }

  toggleMute(): void {
    this.setMuted(!(this.call?.isAudioMuted ?? false));
  }

  sendDtmf(digit: string): void {
    this.call?.dtmf(digit);
  }

  // --- reducer plumbing ------------------------------------------------------

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private dispatch(event: WebphoneEvent): void {
    const result = reduceWebphone(this.state, event, { now: this.now(), random: this.options.random });
    const changed = result.state !== this.state;
    this.state = result.state;
    this.options.logger?.({ scope: "webphone", event: event.type, status: this.state.status });
    for (const effect of result.effects) this.runEffect(effect);
    // Publish registration and renewed session ids immediately. Waiting for
    // the next timer tick can leave a resumed tab unavailable to routing.
    if (this.state.status === "registered" && (event.type === "client_ready" || event.type === "token_issued")) void this.sendHeartbeat();
    if (changed) this.publish();
  }

  private runEffect(effect: WebphoneEffect): void {
    switch (effect.kind) {
      case "clear_timers":
        this.clearTimer("retryTimer");
        this.clearTimer("refreshTimer");
        return;
      case "mint_token":
        void this.mintToken();
        return;
      case "connect":
        void this.connect(effect.credentials);
        return;
      case "disconnect":
        void this.disconnectClient();
        return;
      case "retry_after":
        this.clearTimer("retryTimer");
        this.retryTimer = this.schedule(() => {
          this.retryTimer = null;
          void this.mintToken();
        }, effect.delayMs);
        return;
      case "refresh_after":
        this.clearTimer("refreshTimer");
        this.refreshTimer = this.schedule(() => {
          this.refreshTimer = null;
          this.dispatch({ type: "token_expiring" });
        }, effect.delayMs);
        return;
      default:
        return;
    }
  }

  private schedule(handler: () => void, delayMs: number): number {
    const timer = this.options.setTimeout ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms) as unknown as number);
    return timer(handler, delayMs);
  }

  private clearTimer(key: "retryTimer" | "refreshTimer" | "heartbeatTimer" | "expectedLegTimer"): void {
    const handle = this[key];
    if (handle === null) return;
    this[key] = null;
    const clear = this.options.clearTimeout ?? ((id: number) => window.clearTimeout(id));
    clear(handle);
  }

  private scheduleExpectedLegExpiry(): void {
    this.clearTimer("expectedLegTimer");
    const now = this.now();
    this.expected = pruneExpectedLegs(this.expected, now);
    if (!this.expected.length) return;

    const expiresAt = Math.min(...this.expected.map((leg) => leg.at + EXPECTED_LEG_TTL_MS));
    this.expectedLegTimer = this.schedule(() => {
      this.expectedLegTimer = null;
      this.scheduleExpectedLegExpiry();
      this.publish();
    }, Math.max(0, expiresAt - now));
  }

  // --- HTTP ------------------------------------------------------------------

  private get requestJson(): typeof telephonyJson {
    return this.options.requestJson ?? telephonyJson;
  }

  private async mintToken(): Promise<void> {
    const generation = ++this.mintGeneration;
    const takeover = this.takeoverRequested;
    this.takeoverRequested = false;
    try {
      const result = await this.requestJson<WebphoneCredentials & { error?: string }>(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The current session id makes the server treat this as a renewal of
        // our own credential rather than a takeover of another tab.
        body: JSON.stringify({ takeover, ...(this.options.deviceKind ? { deviceKind: this.options.deviceKind } : {}), ...(this.handoffPending ? { handoff: true } : {}), deviceSessionId: this.state.credentials?.deviceSessionId ?? this.resumeSessionId }),
        label: "prihlásenie telefónu",
        timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      });
      if (!this.started || generation !== this.mintGeneration) return;
      if (!result.ok || !result.body?.token) {
        this.dispatch({ type: "token_rejected", status: result.status, message: result.body?.error ?? null });
        return;
      }
      const { token, expiresAt, deviceSessionId, sipUsername } = result.body;
      this.resumeSessionId = deviceSessionId;
      this.handoffPending = false;
      this.options.onSession?.(deviceSessionId);
      this.dispatch({ type: "token_issued", credentials: { token, expiresAt, deviceSessionId, sipUsername } });
    } catch {
      if (!this.started || generation !== this.mintGeneration) return;
      this.dispatch({ type: "token_rejected", status: 0, message: "Telefón sa nepodarilo prihlásiť (sieť)." });
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Safari throttles window timers in background tabs. Keep the cadence in
    // the existing browser worker; it only sends pulses, never credentials or
    // requests, so every heartbeat still reflects the current SDK state.
    // Full browser/OS suspension can also suspend workers: the server's stale
    // device cutoff remains in force and resume events refresh it immediately.
    if (typeof Worker !== "undefined") {
      try {
        const worker = new Worker("/workplace-heartbeat-worker.js");
        this.heartbeatWorker = worker;
        worker.onmessage = (event: MessageEvent) => {
          if (this.started && this.heartbeatWorker === worker && event.data?.kind === "pulse") void this.sendHeartbeat();
        };
        worker.onerror = () => {
          if (this.heartbeatWorker !== worker) return;
          this.stopHeartbeat();
          if (this.started) this.startHeartbeatTimer();
        };
        worker.postMessage({ kind: "start", intervalMs: WEBPHONE_HEARTBEAT_MS });
        return;
      } catch {
        // Worker creation/loading can be blocked by browser policy or CSP.
        this.stopHeartbeat();
      }
    }
    this.startHeartbeatTimer();
  }

  private startHeartbeatTimer(): void {
    const tick = () => {
      if (!this.started) return;
      void this.sendHeartbeat();
      this.heartbeatTimer = this.schedule(tick, WEBPHONE_HEARTBEAT_MS);
    };
    this.heartbeatTimer = this.schedule(tick, WEBPHONE_HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    this.clearTimer("heartbeatTimer");
    if (this.heartbeatWorker) {
      this.heartbeatWorker.onmessage = null;
      this.heartbeatWorker.onerror = null;
      this.heartbeatWorker.terminate();
      this.heartbeatWorker = null;
    }
  }

  private heartbeatBody(options: { leaving?: boolean } = {}): string | null {
    const deviceSessionId = this.state.credentials?.deviceSessionId;
    if (!deviceSessionId) return null;
    // The tab is going away: report the phone as gone instead of refreshing
    // `device_seen_at`, which would keep the operator ringable for two minutes.
    const registrationState = options.leaving ? "unregistered" : heartbeatRegistrationState(this.state.status);
    return JSON.stringify({ deviceSessionId, registrationState, ...(this.options.deviceKind ? { deviceKind: this.options.deviceKind } : {}) });
  }

  private async sendHeartbeat(options: { leaving?: boolean } = {}): Promise<void> {
    const body = this.heartbeatBody(options);
    if (!this.started || !body) return;
    const deviceSessionId = this.state.credentials?.deviceSessionId;
    try {
      const result = await this.requestJson<{ error?: string; reason?: string }>(HEARTBEAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: options.leaving,
        label: "heartbeat telefónu",
        timeoutMs: TELEPHONY_TIMEOUT_MS.read,
      });
      // 409 is the server saying this tab's device session was superseded (or
      // revoked). Retrying cannot help: the newest tab owns the credential.
      // A background request can finish after a token renewal changed our
      // session id. Its 409 belongs to the old session, not the current phone.
      if (this.started && this.state.credentials?.deviceSessionId === deviceSessionId && result.status === 409) {
        this.dispatch({ type: "superseded", message: result.body?.error ?? null });
      }
    } catch {
      // A missed heartbeat is not fatal: the server window is 120 s.
    }
  }

  /** Await server liveness before an explicit on-demand call request. */
  async confirmRegistration(): Promise<void> {
    if (this.state.status !== "registered") throw new Error("Telefón ešte nie je pripojený.");
    const result = await this.requestJson<{ error?: string }>(HEARTBEAT_URL, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: this.heartbeatBody(),
      label: "pripravenie telefónu", timeoutMs: TELEPHONY_TIMEOUT_MS.read,
    });
    if (!result.ok) throw new Error(result.body?.error ?? "Pripojenie telefónu sa nepodarilo potvrdiť.");
  }

  /** Fire-and-forget heartbeat that survives the tab being hidden or closed. */
  private beaconHeartbeat(options: { leaving?: boolean } = {}): void {
    const body = this.heartbeatBody(options);
    if (!body) return;
    try {
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
        && navigator.sendBeacon(HEARTBEAT_URL, new Blob([body], { type: "application/json" }))) return;
    } catch {
      // A browser may refuse a beacon; preserve the leaving state in fallback.
    }
    void this.sendHeartbeat(options);
  }

  private onVisibilityChange(): void {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "hidden") {
      this.beaconHeartbeat();
      return;
    }
    this.onResume();
  }

  private onResume(): void {
    if (!this.started) return;
    if (!this.heartbeatWorker && this.heartbeatTimer === null) this.startHeartbeat();
    void this.sendHeartbeat();
    // Safari may postpone the reconnect timer until long after foregrounding.
    // Resume only an existing retry; never take a revoked phone back over or
    // reconnect a healthy socket carrying an active call.
    if (this.state.status === "reconnecting" && this.retryTimer !== null) {
      this.clearTimer("retryTimer");
      void this.mintToken();
    }
    void this.resumeAudio();
  }

  // --- SDK -------------------------------------------------------------------

  private async connect(credentials: WebphoneCredentials): Promise<void> {
    // A token refresh while the socket is up must not drop a live call: the
    // fresh credentials are kept for the next (re)connect instead.
    if (this.client || this.connecting) return;
    this.connecting = true;
    const generation = ++this.clientGeneration;
    try {
      const client = await (this.options.createClient
        ? this.options.createClient(credentials)
        : this.createTelnyxClient(credentials));
      if (!this.started || generation !== this.clientGeneration) {
        await Promise.resolve(client.disconnect()).catch(() => undefined);
        return;
      }
      this.client = client;
      const current = () => this.started && this.client === client && generation === this.clientGeneration;
      client.on("telnyx.ready", (() => {
        if (current()) this.dispatch({ type: "client_ready" });
      }) as (payload: never) => void);
      client.on("telnyx.error", ((payload: WebphoneSdkError) => {
        if (current()) this.onSdkError(payload);
      }) as (payload: never) => void);
      client.on("telnyx.socket.close", (() => {
        if (current()) this.dispatch({ type: "socket_closed" });
      }) as (payload: never) => void);
      client.on("telnyx.notification", ((notification: WebphoneSdkNotification) => {
        if (current()) this.onNotification(notification);
      }) as (payload: never) => void);
      const element = this.getRemoteAudio();
      if (element) client.remoteElement = element;
      await client.connect();
    } catch (error) {
      if (!this.started || generation !== this.clientGeneration) return;
      this.dispatch({
        type: "client_error",
        message: error instanceof Error ? error.message : "Telefón sa nepodarilo pripojiť.",
      });
    } finally {
      if (generation === this.clientGeneration) this.connecting = false;
    }
  }

  private async createTelnyxClient(credentials: WebphoneCredentials): Promise<WebphoneSdkClient> {
    const { TelnyxRTC } = await import("@telnyx/webrtc");
    return new TelnyxRTC({ login_token: credentials.token }) as unknown as WebphoneSdkClient;
  }

  private async disconnectClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientGeneration += 1;
    this.connecting = false;
    this.stopRinging();
    this.call = null;
    this.callSessionId = null;
    this.answeringCallId = null;
    this.answeredCallId = null;
    this.audioAttempt += 1;
    this.audioBlocked = false;
    if (!client) return;
    for (const event of ["telnyx.ready", "telnyx.error", "telnyx.socket.close", "telnyx.notification"]) client.off(event);
    await Promise.resolve(client.disconnect()).catch(() => undefined);
  }

  private onSdkError(payload: WebphoneSdkError): void {
    const code = payload?.error?.code;
    // These codes describe a single call. Resetting its healthy registration
    // would also prevent the operator receiving the next incoming call.
    if (typeof code === "number" && CALL_ERROR_CODES.has(code)) {
      if (payload.callId && payload.callId !== this.call?.id) return;
      this.callError = callFailureMessage(payload.error);
      this.publish();
      return;
    }
    const message = payload?.error?.message ?? payload?.message ?? null;
    this.dispatch({ type: "client_error", message, authFailure: isAuthFailure(message) });
  }

  private onNotification(notification: WebphoneSdkNotification): void {
    if (notification?.type !== "callUpdate" || !notification.call) return;
    const call = notification.call;
    const state = String(call.state ?? "").toLowerCase();

    if (DEAD_STATES.has(state)) {
      if (this.call?.id === call.id) {
        this.stopRinging();
        this.call = null;
        this.callSessionId = null;
        this.answeringCallId = null;
        this.answeredCallId = null;
        this.audioAttempt += 1;
        this.audioBlocked = false;
      }
      this.publish();
      return;
    }

    if (this.call?.id !== call.id) {
      this.callSessionId = null;
      this.callError = null;
      this.answeringCallId = null;
      this.answeredCallId = null;
      this.audioAttempt += 1;
      this.audioBlocked = false;
    }
    this.call = call;

    if (RINGING_STATES.has(state) && String(call.direction ?? "").toLowerCase() === "inbound") {
      if (this.suppressAutomaticInvite(call)) { this.publish(); return; }
      // Our own click-to-call / pickup leg: answer it silently, the operator
      // already asked for this call.
      if (this.autoAnswerCurrentCall()) return;
      if (this.answeringCallId !== call.id && this.answeredCallId !== call.id) this.startRinging(call);
      this.publish();
      return;
    }

    if (ACTIVE_STATES.has(state)) {
      this.stopRinging();
      this.answeredCallId = null;
      void this.playRemoteAudio();
    }
    this.publish();
  }

  /**
   * Answers the call currently held by this tab when it is the operator leg of a
   * dial we started: by `telnyxIDs.telnyxCallControlId` (design §2.2), with the
   * `X-PM-Auto-Answer` invite header as a tiebreaker while exactly one leg this
   * tab asked for is still outstanding. Returns true when the call was answered.
   */
  private autoAnswerCurrentCall(): boolean {
    const call = this.call;
    if (!call) return false;
    const state = String(call.state ?? "").toLowerCase();
    if (!RINGING_STATES.has(state) || String(call.direction ?? "").toLowerCase() !== "inbound") return false;

    if (this.suppressAutomaticInvite(call)) return false;
    const expected = (this.incomingPolicy.automaticAllowed ? matchAutoAnswer : matchExpectedLeg)(
      this.expected,
      { telnyxCallControlId: call.telnyxIDs?.telnyxCallControlId, customHeaders: call.options?.customHeaders },
      this.now(),
    );
    if (!expected) return false;
    this.expected = this.expected.filter((entry) => entry.callControlId !== expected.callControlId);
    this.scheduleExpectedLegExpiry();
    this.callSessionId = expected.sessionId;

    void this.answerCall(call);
    return true;
  }

  private async answerCall(call: WebphoneSdkCall): Promise<void> {
    if (!this.started || this.call !== call || !RINGING_STATES.has(String(call.state).toLowerCase()) ||
      this.answeringCallId === call.id || this.answeredCallId === call.id) return;
    if (this.suppressAutomaticInvite(call)) return;
    const generation = this.clientGeneration;
    this.answeringCallId = call.id;
    this.callError = null;
    this.stopRinging();
    this.publish();
    // The answer button is also a sound-unlock gesture on mobile browsers.
    void this.resumeAudio();
    try {
      const result = call.answer();
      if (this.isCurrentCall(call, generation)) this.publish();
      await result;
      if (!this.isCurrentCall(call, generation)) return;
      this.answeredCallId = RINGING_STATES.has(String(call.state).toLowerCase()) ? call.id : null;
      void this.playRemoteAudio();
    } catch (error) {
      if (!this.isCurrentCall(call, generation)) return;
      this.callError = callFailureMessage(error);
      if (RINGING_STATES.has(String(call.state).toLowerCase())) this.startRinging(call);
    } finally {
      if (this.isCurrentCall(call, generation)) {
        this.answeringCallId = null;
        this.publish();
      }
    }
  }

  private isCurrentCall(call: WebphoneSdkCall, generation: number): boolean {
    return this.started && this.call === call && generation === this.clientGeneration && !DEAD_STATES.has(String(call.state).toLowerCase());
  }

  // --- ringing ---------------------------------------------------------------

  private getRingtone(): BrowserIncomingRingtone {
    if (!this.ringtone) this.ringtone = new BrowserIncomingRingtone();
    return this.ringtone;
  }

  private startRinging(call: WebphoneSdkCall): void {
    if (this.ringing || this.options.silent) return;
    this.ringing = true;
    void this.getRingtone().start();
    this.showNotification(call);
  }

  private stopRinging(): void {
    if (!this.ringing) return;
    this.ringing = false;
    this.ringtone?.stop();
    this.notification?.close();
    this.notification = null;
  }

  private showNotification(call: WebphoneSdkCall): void {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      this.notification = new Notification("Prichádzajúci hovor", {
        body: call.options?.remoteCallerNumber ?? call.options?.callerNumber ?? "Neznáme číslo",
        tag: `pm-call-${call.id}`,
        silent: true,
      });
      this.notification.onclick = () => {
        window.focus();
        this.notification?.close();
      };
    } catch {
      this.notification = null;
    }
  }

  private getRemoteAudio(): HTMLAudioElement | null {
    if (typeof document === "undefined") return null;
    if (this.remoteAudio) return this.remoteAudio;
    const element = document.createElement("audio");
    element.id = REMOTE_AUDIO_ELEMENT_ID;
    element.autoplay = true;
    element.setAttribute("playsinline", "true");
    element.style.display = "none";
    element.addEventListener("loadedmetadata", this.boundAudioReady);
    element.addEventListener("canplay", this.boundAudioReady);
    element.addEventListener("playing", this.boundAudioPlaying);
    element.addEventListener("pause", this.boundAudioPause);
    document.body.appendChild(element);
    // The operator's speaker choice belongs to this computer (localStorage), so
    // a freshly created element has to be pointed at it again.
    applyStoredAudioOutput(element);
    this.remoteAudio = element;
    return element;
  }

  private hasRemoteMedia(): boolean {
    return Boolean(this.started && this.call && ACTIVE_STATES.has(String(this.call.state).toLowerCase()) && this.remoteAudio?.srcObject);
  }

  private async playRemoteAudio(): Promise<void> {
    const element = this.remoteAudio;
    if (!element || !this.hasRemoteMedia()) return;
    const call = this.call;
    const attempt = ++this.audioAttempt;
    try {
      await element.play();
      if (this.started && this.call === call && element === this.remoteAudio && attempt === this.audioAttempt) this.setAudioBlocked(false);
    } catch (error) {
      if (!this.started || this.call !== call || element !== this.remoteAudio || attempt !== this.audioAttempt) return;
      // Aborts happen normally when a call ends or the SDK swaps its stream.
      if (error instanceof Error && error.name === "NotAllowedError") this.setAudioBlocked(true);
    }
  }

  private setAudioBlocked(blocked: boolean): void {
    if (this.audioBlocked === blocked) return;
    this.audioBlocked = blocked;
    this.publish();
  }

  private disposeAudio(): void {
    this.audioAttempt += 1;
    this.audioBlocked = false;
    this.ringtone?.dispose();
    this.ringtone = null;
    const element = this.remoteAudio;
    this.remoteAudio = null;
    if (!element) return;
    element.removeEventListener("loadedmetadata", this.boundAudioReady);
    element.removeEventListener("canplay", this.boundAudioReady);
    element.removeEventListener("playing", this.boundAudioPlaying);
    element.removeEventListener("pause", this.boundAudioPause);
    element.pause();
    element.srcObject = null;
    element.remove();
  }

  // --- snapshot --------------------------------------------------------------

  private buildSnapshot(): WebphoneSnapshot {
    const call = this.call;
    const state = String(call?.state ?? "").toLowerCase();
    const sessionId =
      this.callSessionId ??
      (call?.telnyxIDs?.telnyxCallControlId
        ? this.expected.find((entry) => entry.callControlId === call.telnyxIDs.telnyxCallControlId)?.sessionId ?? null
        : null);
    return {
      status: this.state.status,
      registration: webphoneRegistrationView(this.state),
      sipUsername: this.state.credentials?.sipUsername ?? null,
      deviceSessionId: this.state.credentials?.deviceSessionId ?? null,
      message: this.state.message,
      answering: this.answeringCallId !== null,
      audioBlocked: this.audioBlocked,
      callError: this.callError,
      pendingOperatorLegs: pruneExpectedLegs(this.expected, this.now()).length,
      call: call
        ? {
            id: call.id,
            state,
            direction: String(call.direction ?? "").toLowerCase() === "outbound" ? "outbound" : "inbound",
            number: call.options?.remoteCallerNumber ?? call.options?.destinationNumber ?? "",
            callerName: call.options?.remoteCallerName ?? null,
            telnyxCallControlId: call.telnyxIDs?.telnyxCallControlId ?? null,
            sessionId,
            muted: Boolean(call.isAudioMuted),
            ringing: RINGING_STATES.has(state) && !this.withdrawnInvites.has(call.telnyxIDs?.telnyxCallControlId || call.id) && (this.incomingPolicy.automaticAllowed || Boolean(this.callSessionId)),
            active: ACTIVE_STATES.has(state),
          }
        : null,
    };
  }

  private publish(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

type WebphoneSdkError = {
  error?: { code?: number; name?: string; message?: string };
  message?: string;
  callId?: string;
};

// Verified against @telnyx/webrtc 2.27.10 SDK_ERRORS. Socket, auth and network
// codes deliberately keep the existing registration recovery path.
const CALL_ERROR_CODES = new Set([40001, 40002, 40003, 40004, 40005, 42001, 42002, 42003, 44001, 44002, 44003, 44004, 44005, 47001]);

function callFailureMessage(error: unknown): string {
  const detail = error && typeof error === "object" ? error as { code?: number; name?: string } : null;
  if (detail?.code === 42001 || detail?.name === "NotAllowedError" || detail?.name === "SecurityError") {
    return "Mikrofón je zablokovaný. Povoľte ho v nastaveniach prehliadača a skúste hovor znova.";
  }
  if (detail?.code === 42002 || detail?.name === "NotFoundError") return "Mikrofón sa nenašiel. Pripojte ho a skúste hovor znova.";
  if (detail?.code === 42003 || detail?.name === "NotReadableError") return "Mikrofón sa nedá použiť. Skontrolujte, či ho nepoužíva iná aplikácia.";
  if (detail?.code === 44001) return "Hovor sa nepodarilo podržať. Skúste akciu znova.";
  if (detail?.code === 44003) return "Ukončenie hovoru sa nepodarilo potvrdiť. Skontrolujte stav hovoru.";
  if (detail?.code === 47001) return "Zvukové spojenie hovoru sa prerušilo. Skontrolujte internetové pripojenie.";
  return "Hovor sa nepodarilo spojiť. Skúste to znova; ak problém trvá, skontrolujte mikrofón a pripojenie.";
}

/** SIP/JWT rejections must re-mint rather than replay the same token. */
export function isAuthFailure(message: string | null | undefined): boolean {
  if (!message) return false;
  return /unauthor|forbidden|invalid.*(token|credential)|expired|-3260[0-9]|authentication/i.test(message);
}
