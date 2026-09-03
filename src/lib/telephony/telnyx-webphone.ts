"use client";

/**
 * Browser phone (Telnyx WebRTC) controller.
 *
 * Responsibilities kept here — everything that needs a browser:
 * mint/refresh the JWT from `POST /api/telephony/webphone/token`, own the
 * `@telnyx/webrtc` client and the single active call, ring audibly and
 * visibly, keep `motorist_operator_devices.device_seen_at` warm with a 30 s
 * heartbeat (plus a `sendBeacon` when the tab is hidden or closed), and shut
 * this tab's phone down when the heartbeat comes back 409 because a newer tab
 * took the credential.
 *
 * Every decision it makes is delegated to `webphone-model.ts`, which is pure
 * and unit-tested; this file is the shell that performs the effects.
 *
 * The SDK is imported lazily (`await import("@telnyx/webrtc")`) so the console
 * bundle does not carry a WebRTC stack for users who never open the phone.
 */

import { BrowserIncomingRingtone } from "@/lib/telephony/browser-ringtone";
import { telephonyJson, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import {
  heartbeatRegistrationState,
  matchExpectedLeg,
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
  answer: (params?: never) => void;
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
  status: WebphoneStatus;
  registration: WebphoneRegistrationView;
  sipUsername: string | null;
  deviceSessionId: string | null;
  call: WebphoneCallView | null;
  /** Last operator-facing error from an SDK/HTTP failure. */
  message: string | null;
};

export type TelnyxWebphoneOptions = {
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
  /** Our session id for the call currently on this tab's media leg, when known. */
  private callSessionId: string | null = null;
  private listeners = new Set<(snapshot: WebphoneSnapshot) => void>();
  private retryTimer: number | null = null;
  private refreshTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private ringtone: BrowserIncomingRingtone | null = null;
  private ringing = false;
  private notification: Notification | null = null;
  private started = false;
  private connecting = false;
  private snapshot: WebphoneSnapshot;
  private readonly options: TelnyxWebphoneOptions;
  private readonly boundVisibility = () => this.onVisibilityChange();
  private readonly boundPageHide = () => this.beaconHeartbeat();

  constructor(options: TelnyxWebphoneOptions = {}) {
    this.options = options;
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
    }
    this.dispatch({ type: "start" });
    this.startHeartbeat();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.boundVisibility);
      window.removeEventListener("pagehide", this.boundPageHide);
    }
    this.stopHeartbeat();
    this.dispatch({ type: "stop" });
  }

  /**
   * Records the operator leg of a dial this tab just started, so its invite is
   * answered without the operator touching anything (design §2.2). Correlation
   * is on `telnyxIDs.telnyxCallControlId`, never on arrival order.
   */
  expectOperatorLeg(input: { callControlId: string; sessionId: string }): void {
    this.expected = rememberExpectedLeg(this.expected, { ...input, at: this.now() }, this.now());
  }

  /** Unlocks the ringtone's AudioContext and asks for notification permission (needs a user gesture). */
  async unlockAudio(): Promise<void> {
    if (this.options.silent) return;
    await this.getRingtone().unlock();
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      await Notification.requestPermission().catch(() => undefined);
    }
  }

  answer(): void {
    const call = this.call;
    if (!call) return;
    this.stopRinging();
    call.answer();
    this.publish();
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

  private clearTimer(key: "retryTimer" | "refreshTimer" | "heartbeatTimer"): void {
    const handle = this[key];
    if (handle === null) return;
    this[key] = null;
    const clear = this.options.clearTimeout ?? ((id: number) => window.clearTimeout(id));
    clear(handle);
  }

  // --- HTTP ------------------------------------------------------------------

  private get requestJson(): typeof telephonyJson {
    return this.options.requestJson ?? telephonyJson;
  }

  private async mintToken(): Promise<void> {
    try {
      const result = await this.requestJson<WebphoneCredentials & { error?: string }>(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        label: "prihlásenie telefónu",
        timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      });
      if (!result.ok || !result.body?.token) {
        this.dispatch({ type: "token_rejected", status: result.status, message: result.body?.error ?? null });
        return;
      }
      const { token, expiresAt, deviceSessionId, sipUsername } = result.body;
      this.dispatch({ type: "token_issued", credentials: { token, expiresAt, deviceSessionId, sipUsername } });
    } catch {
      this.dispatch({ type: "token_rejected", status: 0, message: "Telefón sa nepodarilo prihlásiť (sieť)." });
    }
  }

  private startHeartbeat(): void {
    this.clearTimer("heartbeatTimer");
    const tick = () => {
      void this.sendHeartbeat();
      this.heartbeatTimer = this.schedule(tick, WEBPHONE_HEARTBEAT_MS);
    };
    this.heartbeatTimer = this.schedule(tick, WEBPHONE_HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    this.clearTimer("heartbeatTimer");
  }

  private heartbeatBody(): string | null {
    const deviceSessionId = this.state.credentials?.deviceSessionId;
    if (!deviceSessionId) return null;
    return JSON.stringify({ deviceSessionId, registrationState: heartbeatRegistrationState(this.state.status) });
  }

  private async sendHeartbeat(): Promise<void> {
    const body = this.heartbeatBody();
    if (!body) return;
    try {
      const result = await this.requestJson<{ error?: string; reason?: string }>(HEARTBEAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        label: "heartbeat telefónu",
        timeoutMs: TELEPHONY_TIMEOUT_MS.read,
      });
      // 409 is the server saying this tab's device session was superseded (or
      // revoked). Retrying cannot help: the newest tab owns the credential.
      if (result.status === 409) {
        this.dispatch({ type: "superseded", message: result.body?.error ?? null });
      }
    } catch {
      // A missed heartbeat is not fatal: the server window is 120 s.
    }
  }

  /** Fire-and-forget heartbeat that survives the tab being hidden or closed. */
  private beaconHeartbeat(): void {
    const body = this.heartbeatBody();
    if (!body) return;
    if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
      void this.sendHeartbeat();
      return;
    }
    navigator.sendBeacon(HEARTBEAT_URL, new Blob([body], { type: "application/json" }));
  }

  private onVisibilityChange(): void {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "hidden") {
      this.beaconHeartbeat();
      return;
    }
    void this.sendHeartbeat();
  }

  // --- SDK -------------------------------------------------------------------

  private async connect(credentials: WebphoneCredentials): Promise<void> {
    // A token refresh while the socket is up must not drop a live call: the
    // fresh credentials are kept for the next (re)connect instead.
    if (this.client || this.connecting) return;
    this.connecting = true;
    try {
      const client = await (this.options.createClient
        ? this.options.createClient(credentials)
        : this.createTelnyxClient(credentials));
      this.client = client;
      client.on("telnyx.ready", (() => this.dispatch({ type: "client_ready" })) as (payload: never) => void);
      client.on("telnyx.error", ((payload: { error?: { message?: string }; message?: string }) => {
        const message = payload?.error?.message ?? payload?.message ?? null;
        this.dispatch({ type: "client_error", message, authFailure: isAuthFailure(message) });
      }) as (payload: never) => void);
      client.on("telnyx.socket.close", (() => this.dispatch({ type: "socket_closed" })) as (payload: never) => void);
      client.on("telnyx.notification", ((notification: WebphoneSdkNotification) =>
        this.onNotification(notification)) as (payload: never) => void);
      const element = this.getRemoteAudio();
      if (element) client.remoteElement = element;
      await client.connect();
    } catch (error) {
      this.client = null;
      this.dispatch({
        type: "client_error",
        message: error instanceof Error ? error.message : "Telefón sa nepodarilo pripojiť.",
      });
    } finally {
      this.connecting = false;
    }
  }

  private async createTelnyxClient(credentials: WebphoneCredentials): Promise<WebphoneSdkClient> {
    const { TelnyxRTC } = await import("@telnyx/webrtc");
    return new TelnyxRTC({ login_token: credentials.token }) as unknown as WebphoneSdkClient;
  }

  private async disconnectClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.stopRinging();
    this.call = null;
    if (!client) return;
    await Promise.resolve(client.disconnect()).catch(() => undefined);
  }

  private onNotification(notification: WebphoneSdkNotification): void {
    if (notification?.type !== "callUpdate" || !notification.call) return;
    const call = notification.call;
    const state = String(call.state ?? "").toLowerCase();

    if (DEAD_STATES.has(state)) {
      this.stopRinging();
      if (this.call?.id === call.id) {
        this.call = null;
        this.callSessionId = null;
      }
      this.publish();
      return;
    }

    this.call = call;

    if (RINGING_STATES.has(state) && String(call.direction ?? "").toLowerCase() === "inbound") {
      const expected = matchExpectedLeg(this.expected, { telnyxCallControlId: call.telnyxIDs?.telnyxCallControlId }, this.now());
      if (expected) {
        // Our own click-to-call leg: answer it silently, the operator already
        // asked for this call.
        this.expected = this.expected.filter((entry) => entry.callControlId !== expected.callControlId);
        this.callSessionId = expected.sessionId;
        call.answer();
        this.publish();
        return;
      }
      this.startRinging(call);
      this.publish();
      return;
    }

    if (ACTIVE_STATES.has(state)) this.stopRinging();
    this.publish();
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
    element.id = "pm-telnyx-remote-audio";
    element.autoplay = true;
    element.setAttribute("playsinline", "true");
    element.style.display = "none";
    document.body.appendChild(element);
    this.remoteAudio = element;
    return element;
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
            ringing: RINGING_STATES.has(state),
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

/** SIP/JWT rejections must re-mint rather than replay the same token. */
export function isAuthFailure(message: string | null | undefined): boolean {
  if (!message) return false;
  return /unauthor|forbidden|invalid.*(token|credential)|expired|-3260[0-9]|authentication/i.test(message);
}
