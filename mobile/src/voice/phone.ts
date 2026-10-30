import { MobileApiError } from "../lib/api";
import type { VoiceApi, VoiceCallTarget, VoiceHoldCommand, VoiceHoldResult, VoiceMedia, VoiceMediaState, VoiceOutgoing, VoiceRecording, VoiceStatus, VoiceToken } from "./api";
import type { DiagnosticFields, VoiceDiagnosticEvent } from "./diagnostics";

export type VoiceEvent = { type: string; callId?: string; callControlId?: string; providerLegId?: string; sessionId?: string; number?: string; state?: string; active?: boolean; muted?: boolean; outgoing?: boolean;
  actionId?: string; held?: boolean; expectedVersion?: number; phase?: "unclaimed" | "dispatched" | "uncertain"; actionLive?: boolean; systemHeld?: boolean; privacyHold?: boolean; media?: Pick<VoiceMedia, "state" | "version" | "canHold">;
  /** A refused VoIP push: its own ID, a reason code and key names only, never a value. */
  id?: string; reason?: string; keys?: string[]; payloadKeys?: string[]; alertKnown?: boolean };
export type NativeHold = { callId: string; sessionId: string; callControlId: string; actionId: string; held: boolean; expectedVersion: number; phase: "unclaimed" | "dispatched" | "uncertain"; actionLive: boolean };
export type NativeMediaSync = Pick<NativeHold, "callId" | "sessionId" | "callControlId" | "actionId" | "held" | "expectedVersion">;
export type MicrophonePermission = "granted" | "denied" | "undetermined" | "unknown";
export type PhoneSnapshot = { ready: boolean; audioActive: boolean; microphonePermission?: MicrophonePermission; pushRegistered?: boolean; preparedPushCallId?: string | null; pushRejection?: VoiceEvent | null; wasEnabled?: boolean; calls?: VoiceEvent[]; pending: VoiceEvent[]; pendingHolds?: NativeHold[]; pendingSyncs?: NativeMediaSync[] };
export type NativePhone = {
  snapshot(): Promise<PhoneSnapshot>; clearPushRejection(id: string): Promise<void>; requestMicrophone(): Promise<boolean>; connect(token: string): Promise<void>;
  /** `reason` only names the caller in the device log. */
  disconnect(reason?: string): Promise<void>;
  authorize(callId: string, sessionId: string, controlId: string): Promise<void>; reject(callId: string): Promise<void>;
  expectOutgoing(controlId: string, sessionId: string, number: string, genericHandle?: boolean): Promise<void>;
  answer(callId: string): Promise<void>; confirmConnected(callId: string): Promise<void>; end(): Promise<void>; mute(muted: boolean): Promise<void>; speaker(enabled: boolean): Promise<void>; dtmf(digits: string): Promise<void>;
  requestHold(callId: string, held: boolean): Promise<void>; claimHold(callId: string, actionId: string): Promise<boolean>;
  syncMedia(callId: string, sessionId: string, controlId: string, state: VoiceMediaState, version: number, canHold: boolean): Promise<void>;
  resolveHold(callId: string, sessionId: string, controlId: string, actionId: string, outcome: "confirmed" | "rejected" | "uncertain", state: VoiceMediaState, version: number, canHold: boolean): Promise<void>;
  subscribe(callback: (event: VoiceEvent) => void): () => void;
  /** One iPhone device-log line (USB syslog); the bridge keeps only codes, flags, counts and short IDs. */
  debug?(event: string, fields?: DiagnosticFields): void;
  /** The persisted device-log ring, oldest first; absent from builds without it. */
  diagnosticEvents?(): Promise<VoiceDiagnosticEvent[]>;
  clearDiagnosticEvents?(upToId: number): Promise<void>;
};
export type PhoneLeaseStore = { load(): Promise<string | null>; save(id: string): Promise<void>; clear(): Promise<void> };
export type PhoneDialTarget = VoiceCallTarget;
export type PhoneState = {
  supported: boolean; registration: "unregistered" | "connecting" | "registered" | "error"; takeoverRequired: boolean;
  call: { id: string; sessionId: string; number: string | null; displayName?: string | null; state: string; outgoing: boolean; connected: boolean; callControlId?: string; media?: VoiceMedia;
    /** Whether the connected call is recorded; null until the server says. */
    recording?: VoiceRecording | null;
    /** A call between colleagues: there is no customer to transfer. */
    internal?: boolean } | null;
  termination: string | null; dialing: boolean; cancelingAttempt: boolean; audioActive: boolean; muted: boolean; speaker: boolean; error: string | null;
  microphonePermission: MicrophonePermission; pushRegistered: boolean | null; lastHeartbeatAt: string | null;
  heartbeatError: string | null; diagnosticsError: string | null; checkingDiagnostics: boolean;
  retryTarget: PhoneDialTarget | null;
  holdPhase: "idle" | "requesting" | "pending" | "uncertain";
  nativeSyncPending: boolean;
  /** The own call whose transfer is under way; cleared when the call stays with this phone. */
  transferPending: string | null;
};

const holdRefused = "Podržanie sa nepodarilo.";
/** Device-log values: an 8-character ID, and an error's status and code, never its message.
 * Both never throw: they are evaluated before the guarded log call. */
const short = (id: unknown) => typeof id === "string" && id ? id.slice(0, 8) : "none";
function failure(error: unknown): { status: number; code: string } {
  try {
    if (error instanceof MobileApiError) return { status: error.status, code: error.code ?? "none" };
    const code = (error as { code?: unknown } | null)?.code;
    return { status: 0, code: typeof code === "string" ? code : error instanceof Error ? error.name : "unknown" };
  } catch { return { status: 0, code: "unknown" }; }
}

/** A retry must repeat the exact original command, including its confirmed target. */
export function sameDialTarget(left: PhoneDialTarget, right: PhoneDialTarget): boolean {
  if (left.kind === "internal") return right.kind === "internal" && left.profileId === right.profileId;
  if (left.kind === "callback") return right.kind === "callback" && left.callbackRequestId === right.callbackRequestId && left.verificationId === right.verificationId;
  return right.kind === "external" && left.number === right.number && left.verificationId === right.verificationId && left.caseId === right.caseId;
}

/** CallKit owns audio/signaling. JS owns the authenticated mobile lease and
 * exact outbound intent; it never issues a direct SDK dial. Provider tokens
 * stay in memory. Only the revocable device lease survives a cold launch. */
export class DispatchPhone {
  state: PhoneState;
  private token: VoiceToken | null = null;
  private leaseId: string | null = null;
  private foreground = true;
  private stopped = false;
  private generation = 0;
  private off: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private monitor: ReturnType<typeof setInterval> | null = null;
  private heartbeatBusy = false;
  private monitorBusy = false;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  /** The operator requested connection, including a native phone restored at launch.
   * Kept across temporary failures before the first provider token exists. */
  private connectionRequested = false;
  private pendingDial: { requestId: string; target: PhoneDialTarget; uncertain: boolean } | null = null;
  /** The message of a failed call status read; the next good read clears it. */
  private monitorError: string | null = null;
  /** Changes when a recording stop starts and ends; an older status read cannot undo its answer. */
  private recordingEpoch = 0;
  /** Sessions this phone is transferring. The server closes their leg, so its native end is not a
   * hang-up. The value is the transfer epoch from which a status read showing the call still here
   * releases the guard; Infinity while the request is in flight. */
  private handedAway = new Map<string, number>();
  private transferEpoch = 0;
  private outgoingIntent: (VoiceOutgoing & { kind: PhoneDialTarget["kind"] }) | null = null;
  private pendingHold: (NativeHold & { leaseId: string }) | null = null;
  private holdWork: NativeHold | null = null;
  private nativeMediaSync: NativeMediaSync | null = null;
  private nativeSyncRevision = 0;
  private refreshPushRegistration = false;
  private pendingInvites = new Map<string, VoiceEvent>();
  /** An SDK INVITE that arrived while its own push was being prepared. */
  private pushInvites = new Map<string, VoiceEvent>();
  private authorizing = new Set<string>();
  private finished = new Set<string>();
  private ending = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  private reportedPushRejection: string | null = null;
  constructor(private api: VoiceApi, private native: NativePhone | null, private uuid: () => string, private leases?: PhoneLeaseStore,
    /** The app's error report; it receives a refused VoIP push's reason and key names. */
    private reportDiagnostic?: (error: Error) => void) {
    this.state = { supported: Boolean(native), registration: "unregistered", takeoverRequired: false, call: null, termination: null,
      dialing: false, cancelingAttempt: false, audioActive: false, muted: false, speaker: false, error: null,
      microphonePermission: "unknown", pushRegistered: null, lastHeartbeatAt: null, heartbeatError: null, diagnosticsError: null, checkingDiagnostics: false, retryTarget: null, holdPhase: "idle", nativeSyncPending: false, transferPending: null };
  }
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  snapshot = () => this.state;
  private current(generation: number) { return !this.stopped && generation === this.generation; }
  private diag(event: string, fields?: DiagnosticFields) { try { this.native?.debug?.(event, fields); } catch { /* A device log never affects calling. */ } }
  private update(value: Partial<PhoneState>) {
    if (this.stopped) return;
    this.state = { ...this.state, ...value }; for (const notify of this.listeners) notify();
  }
  async initialise() {
    if (!this.native || this.stopped) return;
    this.off = this.native.subscribe(event => { void this.event(event); });
    const generation = this.generation;
    const snapshot = await this.native.snapshot();
    if (!this.current(generation)) return;
    this.diag("phone.init", { ready: snapshot.ready, was_enabled: snapshot.wasEnabled === true, pending: snapshot.pending.length, calls: snapshot.calls?.length ?? 0,
      push_rejection: Boolean(snapshot.pushRejection), prepared: Boolean(snapshot.preparedPushCallId), foreground: this.foreground });
    this.applyDiagnostics(snapshot);
    // A push refused during a cold launch arrived before this listener.
    this.pushRejected(snapshot.pushRejection);
    for (const call of snapshot.calls ?? []) {
      if (call.callId && call.sessionId) this.update({ call: { id: call.callId, sessionId: call.sessionId, number: call.number ?? null,
        callControlId: call.callControlId, state: call.state ?? "CONNECTING", outgoing: call.outgoing === true, connected: false }, muted: call.muted === true, audioActive: snapshot.audioActive });
    }
    for (const sync of snapshot.pendingSyncs ?? []) this.mediaSyncEvent({ type: "holdSyncPending", ...sync });
    if (snapshot.pending.length || snapshot.wasEnabled) await this.connect();
  }
  /** Reports a refused VoIP push once: its reason and key names, which hold no number or token. */
  private pushRejected(event: VoiceEvent | null | undefined) {
    if (!event?.id || event.id === this.reportedPushRejection) return;
    this.reportedPushRejection = event.id;
    const names = (list: unknown) => Array.isArray(list) && list.length ? list.filter(key => typeof key === "string").slice(0, 30).join(",") : "none";
    const alert = typeof event.alertKnown === "boolean" ? event.alertKnown ? "known" : "unknown" : "none";
    const error = new Error(`${event.reason ?? "unknown"}; metadata keys: ${names(event.keys)}; payload keys: ${names(event.payloadKeys)}; alert: ${alert}`);
    error.name = "VoIPPushRejected";
    // Reported once: native forgets it, so a remount or another login does not repeat it.
    let reported = false;
    try { this.reportDiagnostic?.(error); reported = Boolean(this.reportDiagnostic); void this.native?.clearPushRejection(event.id).catch(() => {}); } catch { /* A report never affects calling. */ }
    this.diag("push.rejected", { reason: event.reason ?? "unknown", reporter: Boolean(this.reportDiagnostic), reported });
  }
  private applyDiagnostics(snapshot: PhoneSnapshot) {
    const permission = snapshot.microphonePermission;
    this.update({ microphonePermission: permission === "granted" || permission === "denied" || permission === "undetermined"
      ? permission : "unknown", pushRegistered: typeof snapshot.pushRegistered === "boolean" ? snapshot.pushRegistered : null, diagnosticsError: null });
  }
  async refreshDiagnostics() {
    if (!this.native || this.stopped || this.state.checkingDiagnostics) return;
    const generation = this.generation; this.update({ checkingDiagnostics: true });
    try {
      const snapshot = await this.native.snapshot();
      if (this.current(generation)) {
        this.applyDiagnostics(snapshot);
        if (this.foreground && this.state.registration === "registered") await this.touch();
      }
    } catch {
      if (this.current(generation)) this.update({ microphonePermission: "unknown", pushRegistered: null, diagnosticsError: "Stav telefónu sa nepodarilo overiť." });
    } finally { if (this.current(generation)) this.update({ checkingDiagnostics: false }); }
  }
  connect(takeover = false): Promise<void> {
    if (this.state.cancelingAttempt) return Promise.resolve();
    if (takeover && (this.state.call || this.state.termination || this.state.dialing || this.pendingDial || this.outgoingIntent || this.authorizing.size)) return Promise.resolve();
    this.connectionRequested = true; this.reconnectAttempts = 0;
    return this.connectAttempt(takeover);
  }
  private connectAttempt(takeover = false, automatic = false): Promise<void> {
    if (!this.native || this.stopped) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    const generation = this.generation;
    this.diag("phone.connect_start", { takeover, automatic, attempts: this.reconnectAttempts, foreground: this.foreground, token: Boolean(this.token) });
    this.update({ registration: "connecting", takeoverRequired: false, error: null });
    this.connecting = (async () => {
      let step = "microphone";
      try {
        const microphone = await this.native!.requestMicrophone();
        if (!this.current(generation)) return;
        this.update({ microphonePermission: microphone ? "granted" : "denied" });
        if (!microphone) throw new MobileApiError("Povoľte mikrofón v nastaveniach iPhone.", 403);
        if (!this.current(generation) || (automatic && !this.idleForRecovery())) return;
        step = "lease";
        this.leaseId ??= await this.leases?.load() ?? null;
        if (!this.current(generation) || (automatic && !this.idleForRecovery())) return;
        step = "token";
        this.diag("token.start", { takeover, automatic });
        const token = await this.api.token(this.leaseId ?? undefined, takeover);
        this.diag("token.end", { outcome: "ok" });
        if (!this.current(generation)) { await this.api.disconnect(token.deviceSessionId).catch(() => {}); return; }
        this.leaseId = token.deviceSessionId;
        step = "save";
        await this.leases?.save(token.deviceSessionId);
        if (!this.current(generation)) return;
        this.token = token;
        if (automatic && !this.idleForRecovery()) return;
        step = "native";
        await this.native!.connect(token.token);
        if (!this.current(generation)) return;
        step = "snapshot";
        const pending = await this.native!.snapshot();
        if (!this.current(generation)) return;
        this.diag("phone.connect_native", { ready: pending.ready, pending: pending.pending.length, holds: pending.pendingHolds?.length ?? 0, push_registered: pending.pushRegistered === true });
        step = "replay";
        this.applyDiagnostics(pending);
        if (pending.ready) await this.event({ type: "registration", state: "registered" });
        for (const event of pending.pending) void this.event(event);
        for (const sync of pending.pendingSyncs ?? []) this.mediaSyncEvent({ type: "holdSyncPending", ...sync });
        for (const event of pending.pendingHolds ?? []) {
          if (event.phase !== "unclaimed") await this.handleHold({ type: "heldRequested", ...event });
        }
        if (this.state.call) await this.checkCall();
        for (const event of pending.pendingHolds ?? []) {
          if (event.phase === "unclaimed") await this.handleHold({ type: "heldRequested", ...event });
        }
        step = "done";
      } catch (error) {
        this.diag("phone.connect_error", { step, current: this.current(generation), ...failure(error) });
        if (this.current(generation)) {
          // A refusal needs a deliberate action. In particular, recovery never
          // takes the phone from another device or repeats an untrusted reply.
          if (error instanceof MobileApiError && error.status !== 0 && error.status !== 408 && error.status !== 429
            && !(error.status >= 500 && error.status <= 599 && error.status !== 502)) this.connectionRequested = false;
          this.update({ registration: "error", takeoverRequired: error instanceof MobileApiError && error.status === 409 });
          this.fail(error);
        }
      } finally {
        if (automatic && this.current(generation) && !this.idleForRecovery() && this.state.registration === "connecting") {
          this.update({ registration: "unregistered" });
        }
        this.connecting = null;
        if (this.current(generation) && this.refreshPushRegistration && this.token && this.state.registration !== "error"
          && !this.state.call && !this.pendingDial && !this.outgoingIntent) {
          this.refreshPushRegistration = false; void this.connect();
        }
        this.scheduleRecovery();
        this.diag("phone.connect_end", { step, current: this.current(generation), registration: this.state.registration, requested: this.connectionRequested });
      }
    })();
    return this.connecting;
  }
  setForeground(value: boolean) {
    if (value !== this.foreground) this.diag("phone.foreground", { value, registration: this.state.registration, token: Boolean(this.token), requested: this.connectionRequested, call: Boolean(this.state.call) });
    if (value && !this.foreground) this.reconnectAttempts = 0;
    this.foreground = value; this.schedule();
    if (value) void this.refreshDiagnostics();
    if (value && this.token && this.connectionRequested) {
      if (this.state.registration !== "registered" && !this.state.call && !this.outgoingIntent) void this.connect();
      else void this.touch();
    }
  }
  private idleForRecovery() {
    return !this.stopped && this.native && this.foreground && this.connectionRequested && !this.state.call
      && !this.state.termination && !this.pendingDial && !this.outgoingIntent && !this.state.dialing
      && this.authorizing.size === 0 && this.state.registration !== "registered" && !this.state.takeoverRequired;
  }
  private canRecover() { return !this.connecting && this.idleForRecovery(); }
  private scheduleRecovery() {
    if (!this.canRecover()) {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null; return;
    }
    if (this.reconnectTimer || this.reconnectAttempts >= 3) return;
    // connect() starts native login; allow its asynchronous registration to
    // finish before replacing an otherwise healthy, still-connecting socket.
    const delay = this.state.registration === "connecting" ? 10_000 : [1_000, 2_000, 5_000][this.reconnectAttempts];
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.canRecover()) return;
      this.reconnectAttempts += 1; void this.connectAttempt(false, true);
    }, delay);
  }
  private schedule() {
    this.scheduleRecovery();
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null;
    if (this.monitor) clearInterval(this.monitor); this.monitor = null;
    if (this.stopped || (!this.token && !(this.leaseId && this.state.termination))) return;
    // No JS/background keepalive: suspended iOS is reached through APNs.
    if (this.token && this.foreground && this.state.registration === "registered") this.heartbeat = setInterval(() => { void this.touch(); }, 30_000);
    if ((this.foreground || this.state.audioActive) && (this.state.call || this.state.termination)) this.monitor = setInterval(() => { void this.checkCall(); }, 2_000);
  }
  private async touch() {
    if (!this.token || this.heartbeatBusy || this.stopped) return;
    const generation = this.generation, token = this.token; this.heartbeatBusy = true;
    try {
      if (Date.parse(this.token.expiresAt) - Date.now() < 60_000 && !this.state.call && !this.state.termination && !this.pendingDial && !this.outgoingIntent) { await this.connect(); return; }
      const snapshot = await this.native!.snapshot();
      if (!this.current(generation) || this.token !== token) return;
      this.applyDiagnostics(snapshot);
      const microphoneBlocked = snapshot.microphonePermission === "denied";
      await this.api.heartbeat(token.deviceSessionId, microphoneBlocked ? "unregistered" : this.state.registration === "registered" ? "registered" : "registering",
        !microphoneBlocked && snapshot.pushRegistered === true);
      if (this.current(generation) && this.token === token) this.update({ lastHeartbeatAt: new Date().toISOString(), heartbeatError: null,
        ...(this.state.heartbeatError && this.state.error === this.state.heartbeatError ? { error: null } : {}) });
    } catch (error) { if (this.current(generation) && this.token === token) {
      this.update({ heartbeatError: error instanceof MobileApiError ? error.message : "Spojenie s ústredňou sa nepodarilo overiť." }); this.fail(error);
    } }
    finally { this.heartbeatBusy = false; }
  }
  private async checkCall() {
    const sessionId = this.state.termination ?? this.state.call?.sessionId;
    const leaseId = this.token?.deviceSessionId ?? this.leaseId;
    if (!leaseId || !sessionId || this.monitorBusy || this.stopped) return;
    const generation = this.generation, requestedCall = this.state.call, recordingEpoch = this.recordingEpoch, transferEpoch = this.transferEpoch; this.monitorBusy = true;
    try {
      if (this.pendingHold) { await this.refreshHold(); return; }
      const status = await this.api.status(leaseId, sessionId);
      if (!this.current(generation)) return;
      if (this.monitorError !== null && this.state.error === this.monitorError) this.update({ error: null });
      this.monitorError = null;
      await this.applyCallStatus(status, generation, false, requestedCall, recordingEpoch, transferEpoch);
    } catch (error) { if (this.current(generation)) { this.fail(error); this.monitorError = this.state.error; } }
    finally { this.monitorBusy = false; }
  }
  /** `recordingEpoch` is the fence value read before the request; null leaves the recorder as it is. */
  private async applyCallStatus(status: VoiceStatus, generation: number, holdResult = false, requestedCall = this.state.call, recordingEpoch: number | null = null, transferEpoch: number | null = null) {
    const sessionId = status.sessionId;
    const sameCall = () => this.current(generation) && this.state.call?.id === requestedCall?.id
      && this.state.call?.sessionId === requestedCall?.sessionId && this.state.call?.callControlId === requestedCall?.callControlId;
    if (!this.current(generation) || this.state.call && !sameCall()) return;
    if (this.state.call?.media && status.media.version < this.state.call.media.version) return;
    if (status.ended) {
      if (this.state.call?.sessionId === sessionId) {
        const id = this.state.call.id;
        // Server-directed loss/transfer ends only this mobile endpoint. Fence
        // its native ended callback before rejecting so it cannot hang up the
        // other endpoint's session or turn a valid lease into an auth error.
        this.rememberFinished(id);
        if (this.outgoingIntent?.sessionId === sessionId) this.outgoingIntent = null;
        this.pendingHold = null; this.nativeMediaSync = null;
        this.update({ call: null, holdPhase: "idle", nativeSyncPending: false, audioActive: false, muted: false, speaker: false });
        await this.native?.reject(id);
        if (!this.current(generation) || this.state.call) return;
      }
      if (this.state.termination === sessionId) this.update({ termination: status.terminationPending ? sessionId : null });
    } else if (this.state.call?.sessionId === sessionId) {
      const call = this.state.call, media = status.media;
      if (media.callControlId && call.callControlId && media.callControlId !== call.callControlId) {
        throw new MobileApiError("Odpoveď telefónu patrí inému spojeniu.", 502);
      }
      const currentMedia = call.media;
      const older = currentMedia && (media.version < currentMedia.version
        || media.version === currentMedia.version && ["active", "held"].includes(currentMedia.state) && media.state === "pending");
      // A status read started before a claimed action cannot resolve that
      // action. Only its immutable operation receipt may release the barrier.
      const applyMedia = !older && (!this.pendingHold || holdResult);
      this.update({ call: { ...call, connected: status.connected, ...(applyMedia ? { media, callControlId: media.callControlId ?? call.callControlId } : {}),
        ...(recordingEpoch !== null && recordingEpoch === this.recordingEpoch ? { recording: status.connected ? status.recording ?? null : null } : {}),
        ...(typeof status.internal === "boolean" ? { internal: status.internal } : {}) } });
      // A read started after the transfer answer that still shows the call here: the transfer
      // did not take it, so its hang-ups are real again.
      const guard = this.handedAway.get(sessionId);
      if (guard !== undefined && transferEpoch !== null && transferEpoch >= guard && status.connected && media.state !== "pending") {
        this.handedAway.delete(sessionId);
        if (this.state.transferPending === sessionId) this.update({ transferPending: null, error: "Prepojenie sa nepodarilo. Hovor ostáva u vás." });
      }
      if (applyMedia && call.callControlId && !holdResult) {
        await this.native?.syncMedia(call.id, sessionId, call.callControlId, media.state, media.version, media.canHold);
        if (!sameCall()) return;
        await this.reconcileNativeSync(generation);
        if (!sameCall()) return;
        if (!this.pendingHold && this.state.holdPhase !== "requesting") {
          const privacyUnresolved = media.state === "unavailable" && (currentMedia?.state === "held" || currentMedia?.state === "pending" || this.state.holdPhase === "uncertain");
          this.update({ holdPhase: privacyUnresolved ? "uncertain" : media.state === "pending" ? "pending" : "idle" });
        }
      }
      if (status.connected && call.outgoing && sameCall()) {
        await this.native?.confirmConnected(call.id);
        if (!sameCall()) return;
      }
    }
    if (!status.ended && status.terminationPending) this.update({ termination: sessionId });
    this.schedule();
  }
  async hold() {
    const call = this.state.call;
    if (!this.native || !this.token || !call?.connected || !call.media?.canHold || !call.callControlId
      || this.pendingHold || this.state.holdPhase !== "idle" || this.state.nativeSyncPending || this.state.termination
      || ["DROPPED", "RECONNECTING"].includes(call.state)) {
      this.diag("hold.skip", { token: Boolean(this.token), connected: call?.connected === true, can_hold: call?.media?.canHold === true, control: Boolean(call?.callControlId),
        pending: Boolean(this.pendingHold), phase: this.state.holdPhase, sync_pending: this.state.nativeSyncPending, termination: Boolean(this.state.termination), state: call?.state ?? "none" });
      return;
    }
    const generation = this.generation;
    this.diag("hold.request", { call: short(call.id), held: call.media.state !== "held", media: call.media.state, version: call.media.version });
    this.update({ holdPhase: "requesting", error: null });
    try { await this.native.requestHold(call.id, call.media.state !== "held"); }
    catch (error) {
      this.diag("hold.request_error", { call: short(call.id), ...failure(error) });
      if (this.current(generation) && this.state.call?.id === call.id && !this.pendingHold) {
        this.update({ holdPhase: "idle", error: "Podržanie hovoru sa nepodarilo pripraviť. Skúste znova." });
      }
    }
  }
  private holdCurrent(command: NativeHold & { leaseId: string }, generation: number) {
    const call = this.state.call;
    return this.current(generation) && this.pendingHold === command && this.token?.deviceSessionId === command.leaseId
      && call?.id === command.callId && call.sessionId === command.sessionId && call.callControlId === command.callControlId
      && !this.state.termination;
  }
  private holdPayload(command: NativeHold): VoiceHoldCommand {
    return { callControlId: command.callControlId, requestId: command.actionId, held: command.held, expectedVersion: command.expectedVersion };
  }
  private mediaSyncEvent(event: VoiceEvent) {
    const call = this.state.call;
    if (!call || event.callId !== call.id || event.sessionId !== call.sessionId || event.callControlId !== call.callControlId
      || typeof event.held !== "boolean" || !event.actionId || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(event.actionId)
      || !Number.isSafeInteger(event.expectedVersion) || event.expectedVersion! < (call.media?.version ?? 0)) return;
    if (event.type === "holdSyncPending") {
      if (this.nativeMediaSync && this.nativeMediaSync.expectedVersion > event.expectedVersion!) return;
      this.nativeSyncRevision += 1;
      this.nativeMediaSync = { callId: call.id, sessionId: call.sessionId, callControlId: event.callControlId!,
        actionId: event.actionId, held: event.held, expectedVersion: event.expectedVersion! };
      this.update({ nativeSyncPending: true });
    } else if (this.nativeMediaSync?.actionId === event.actionId && this.nativeMediaSync.expectedVersion === event.expectedVersion
      && this.nativeMediaSync.held === event.held && (event.type === "holdSyncFailed" || call.media?.state === (event.held ? "held" : "active"))) {
      this.nativeSyncRevision += 1; this.nativeMediaSync = null;
      this.update({ nativeSyncPending: false, ...(event.type === "holdSyncFailed"
        ? { holdPhase: "uncertain" as const, error: "Systémové ovládanie hovoru sa nepodarilo zosúladiť. Overte stav hovoru." } : {}) });
    }
  }
  private async reconcileNativeSync(generation: number) {
    const call = this.state.call;
    if (!call || !this.native || this.pendingHold || !call.media || !["active", "held"].includes(call.media.state)) return;
    const revision = this.nativeSyncRevision;
    const snapshot = await this.native.snapshot();
    if (!this.current(generation) || this.pendingHold || this.state.call?.id !== call.id
      || this.state.call.sessionId !== call.sessionId || this.state.call.callControlId !== call.callControlId
      || this.state.call.media?.version !== call.media.version || revision !== this.nativeSyncRevision
      || !Array.isArray(snapshot.pendingHolds) || !Array.isArray(snapshot.pendingSyncs)) return;
    for (const sync of snapshot.pendingSyncs) this.mediaSyncEvent({ type: "holdSyncPending", ...sync });
    const pending = snapshot.pendingHolds.find(item => item.callId === call.id);
    if (pending) { await this.handleHold({ type: "heldRequested", ...pending }); return; }
    const sync = this.nativeMediaSync;
    if ((!sync && !this.state.nativeSyncPending) || snapshot.pendingSyncs.some(item => item.callId === call.id)) return;
    const current = snapshot.calls?.find(item => item.callId === call.id && item.sessionId === call.sessionId && item.callControlId === call.callControlId);
    const held = call.media.state === "held";
    if (current?.media?.state !== call.media.state || current.media.version !== call.media.version
      || current.systemHeld !== held || current.privacyHold !== held) return;
    this.nativeSyncRevision += 1; this.nativeMediaSync = null; this.update({ nativeSyncPending: false });
  }
  private async handleHold(event: VoiceEvent) {
    const call = this.state.call, token = this.token;
    if (!this.native || !token || !call || call.id !== event.callId || call.sessionId !== event.sessionId
      || call.callControlId !== event.callControlId || typeof event.held !== "boolean" || !event.actionId
      || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(event.actionId)
      || !Number.isSafeInteger(event.expectedVersion) || event.expectedVersion! < 0 || this.state.termination) {
      this.diag("hold.ignored", { reason: "identity", call: short(event.callId), token: Boolean(token), own_call: call?.id === event.callId,
        same_session: call?.sessionId === event.sessionId, same_control: call?.callControlId === event.callControlId, termination: Boolean(this.state.termination) });
      return;
    }
    if (this.pendingHold) {
      if (this.pendingHold.actionId === event.actionId && this.holdWork !== this.pendingHold) await this.refreshHold();
      return;
    }
    const dispatched = event.phase === "dispatched" || event.phase === "uncertain";
    if (!dispatched && (!call.connected || !call.media?.canHold || event.expectedVersion !== call.media.version)) {
      this.diag("hold.ignored", { reason: "stale", call: short(call.id), connected: call.connected, can_hold: call.media?.canHold === true,
        version: call.media?.version ?? -1, expected: event.expectedVersion ?? -1 });
      return;
    }
    const command: NativeHold & { leaseId: string } = { callId: call.id, sessionId: call.sessionId, callControlId: event.callControlId!,
      actionId: event.actionId, held: event.held, expectedVersion: event.expectedVersion!, phase: event.phase ?? "unclaimed",
      actionLive: event.actionLive !== false, leaseId: token.deviceSessionId };
    this.pendingHold = command;
    if (dispatched) { this.update({ holdPhase: "uncertain" }); await this.refreshHold(); return; }
    const generation = this.generation;
    this.holdWork = command; this.update({ holdPhase: "pending", error: null });
    try {
      const claimed = await this.native.claimHold(command.callId, command.actionId);
      this.diag("hold.claim", { call: short(command.callId), claimed, held: command.held, version: command.expectedVersion });
      if (!this.holdCurrent(command, generation)) return;
      if (!claimed) { this.pendingHold = null; this.update({ holdPhase: "idle" }); return; }
      command.phase = "dispatched";
      const recordingEpoch = this.recordingEpoch;
      const result = await this.api.hold(command.leaseId, command.sessionId, this.holdPayload(command));
      if (this.holdCurrent(command, generation)) await this.applyHoldResult(command, result, generation, recordingEpoch);
    } catch (error) { if (this.holdCurrent(command, generation)) await this.holdFailure(command, error); }
    finally { if (this.holdWork === command) this.holdWork = null; }
  }
  async refreshHold() {
    const command = this.pendingHold;
    if (!command) { await this.checkCall(); return; }
    if (this.holdWork === command || !this.native || this.stopped) return;
    const generation = this.generation;
    if (!this.holdCurrent(command, generation)) return;
    this.holdWork = command;
    try {
      const recordingEpoch = this.recordingEpoch;
      const result = await this.api.holdStatus(command.leaseId, command.sessionId, this.holdPayload(command));
      if (this.holdCurrent(command, generation)) await this.applyHoldResult(command, result, generation, recordingEpoch);
    } catch (error) { if (this.holdCurrent(command, generation)) await this.holdFailure(command, error); }
    finally { if (this.holdWork === command) this.holdWork = null; }
  }
  private async applyHoldResult(command: NativeHold & { leaseId: string }, result: VoiceHoldResult, generation: number, recordingEpoch: number) {
    this.diag("hold.result", { call: short(command.callId), outcome: result.operation.outcome, media: result.media.state, version: result.media.version, connected: result.connected });
    await this.applyCallStatus(result, generation, true, this.state.call, recordingEpoch);
    if (!this.holdCurrent(command, generation)) return;
    const media = this.state.call!.media!;
    const outcome = result.operation.outcome === "accepted" ? "confirmed" : result.operation.outcome === "rejected" ? "rejected" : "uncertain";
    await this.native!.resolveHold(command.callId, command.sessionId, command.callControlId, command.actionId, outcome, media.state, media.version, media.canHold);
    if (!this.holdCurrent(command, generation)) return;
    if (outcome === "uncertain") {
      command.phase = "uncertain"; this.update({ holdPhase: "uncertain" });
    } else {
      this.pendingHold = null;
      this.update({ nativeSyncPending: true, holdPhase: media.state === "unavailable" ? "uncertain" : media.state === "pending" ? "pending" : "idle",
        error: outcome === "rejected" ? "Ústredňa zmenu podržania nepotvrdila." : null });
      await this.reconcileNativeSync(generation);
    }
  }
  private async holdFailure(command: NativeHold & { leaseId: string }, error: unknown) {
    this.diag("hold.failure", { call: short(command.callId), ...failure(error) });
    if (error instanceof MobileApiError && ([401, 403].includes(error.status) || ["native_lease_stale", "native_voice_disabled"].includes(error.code ?? ""))) {
      this.fail(error); return;
    }
    command.phase = "uncertain";
    this.update({ holdPhase: "uncertain", error: "Výsledok podržania ešte overujeme. Hovor môžete ukončiť." });
    const media = this.state.call?.media;
    await this.native?.resolveHold(command.callId, command.sessionId, command.callControlId, command.actionId, "uncertain",
      media?.state ?? "pending", media?.version ?? command.expectedVersion, false).catch(() => {});
  }
  async dial(to: string, verificationId?: string, caseId?: string) {
    return this.startCall({ kind: "external", number: to, ...(verificationId ? { verificationId } : {}), ...(caseId ? { caseId: caseId.toLowerCase() } : {}) });
  }
  async dialColleague(profileId: string, name: string) { return this.startCall({ kind: "internal", profileId, name }); }
  /** The server derives the destination from the request; `number` is only the caller ID shown while dialing.
   * Resolves false when the phone was not ready and nothing was sent. */
  async dialCallback(callbackRequestId: string, number: string, verificationId?: string) {
    return this.startCall({ kind: "callback", callbackRequestId: callbackRequestId.toLowerCase(), number, ...(verificationId ? { verificationId } : {}) });
  }
  private retainsOutgoingCommand(requestId: string, sessionId: string) {
    return !this.stopped && (this.pendingDial?.requestId === requestId
      || this.outgoingIntent?.sessionId === sessionId || this.state.call?.sessionId === sessionId);
  }
  /** True once the command was sent (its outcome is in state); false if nothing was sent. */
  private async startCall(target: PhoneDialTarget): Promise<boolean> {
    if (!this.native || !this.token || this.state.registration !== "registered" || this.state.microphonePermission === "denied"
      || this.state.call || this.state.termination || this.state.dialing || this.state.cancelingAttempt || this.outgoingIntent) return false;
    const original = this.pendingDial?.target;
    if (original && !sameDialTarget(original, target)) {
      this.update({ error: "Najprv zopakujte pôvodný pokus o volanie." }); return false;
    }
    this.pendingDial ??= { requestId: this.uuid(), target, uncertain: false };
    const generation = this.generation, leaseId = this.token.deviceSessionId;
    let createdSession: string | null = null;
    this.diag("call.tap", { kind: target.kind });
    this.update({ dialing: true, error: null, retryTarget: null });
    try {
      const command = this.pendingDial;
      const outgoing = command.target.kind === "internal"
        ? await this.api.startInternal(leaseId, command.requestId, command.target.profileId)
        : command.target.kind === "callback"
          ? await this.api.startCallback(leaseId, command.requestId, command.target.callbackRequestId, command.target.verificationId)
          : await this.api.start(leaseId, command.requestId, command.target.number, command.target.verificationId, command.target.caseId);
      this.diag("call.start_response", { kind: target.kind, outcome: "ok", session: short(outgoing.sessionId) });
      createdSession = outgoing.sessionId;
      if (!this.current(generation)) {
        if (!this.retainsOutgoingCommand(command.requestId, outgoing.sessionId)) await this.api.end(leaseId, outgoing.sessionId).catch(() => {});
        return true;
      }
      this.outgoingIntent = { ...outgoing, kind: command.target.kind };
      await this.native.expectOutgoing(outgoing.operatorLegCallControlId, outgoing.sessionId, outgoing.to, command.target.kind === "internal");
      if (!this.current(generation)) return true;
      this.pendingDial = null;
      const invites = [...this.pendingInvites.values()]; this.pendingInvites.clear();
      for (const event of invites) await this.event(event);
      this.schedule();
    } catch (error) { if (!createdSession) this.diag("call.start_response", { kind: target.kind, outcome: "error", ...failure(error) }); if (this.current(generation)) {
      if (createdSession) { this.pendingDial = null; this.outgoingIntent = null; await this.endSession(createdSession); }
      const denied = error instanceof MobileApiError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
      if (!createdSession && this.pendingDial && !denied) this.pendingDial.uncertain = true;
      if (denied && !this.pendingDial?.uncertain) {
        this.pendingDial = null;
        for (const id of this.pendingInvites.keys()) await this.native.reject(id);
        this.pendingInvites.clear();
      }
      this.update({ retryTarget: this.pendingDial?.target ?? null });
      this.fail(error, !createdSession && error instanceof MobileApiError && error.status === 502);
    } } finally { if (this.current(generation)) this.update({ dialing: false }); }
    return true;
  }
  async retryDial() { if (this.pendingDial) await this.startCall(this.pendingDial.target); }
  async cancelAttempt() {
    const command = this.pendingDial, token = this.token;
    if (!command || !token || this.stopped || this.state.dialing || this.state.cancelingAttempt || this.state.call || this.state.termination || this.outgoingIntent) return;
    const generation = this.generation;
    this.update({ cancelingAttempt: true, error: null });
    try {
      const result = await this.api.cancelAttempt(token.deviceSessionId, command.requestId, command.target);
      if (!this.current(generation)) return;
      if (!result.resolved) { this.update({ error: "Ústredňa ešte overuje pôvodný pokus. Skúste jeho ukončenie znova." }); return; }
      this.pendingDial = null;
      this.update({ retryTarget: null, termination: result.terminationPending ? result.sessionId : null }); this.schedule();
      const invites = [...this.pendingInvites.values()]; this.pendingInvites.clear();
      for (const event of invites) await this.event(event);
    } catch (error) { if (this.current(generation)) this.fail(error, true); }
    finally { if (this.current(generation)) this.update({ cancelingAttempt: false }); }
  }
  private async event(event: VoiceEvent) {
    if (this.stopped || !this.native) return;
    const generation = this.generation;
    this.diag("phone.event", { type: event.type, call: short(event.callId), state: event.state ?? "none", leg: Boolean(event.providerLegId) });
    try {
      if (event.type === "registration") {
        if (!this.token) return;
        const registration = event.state === "registered" ? "registered" : event.state === "error" ? "error" : "unregistered";
        if (registration === "registered") this.reconnectAttempts = 0;
        this.update({ registration }); this.schedule();
        if (registration === "registered") await this.touch();
      } else if (event.type === "pushTokenChanged") {
        this.refreshPushRegistration = true;
        if (this.token && !this.state.call && !this.pendingDial && !this.outgoingIntent && !this.connecting) {
          this.refreshPushRegistration = false; await this.connect();
        }
      } else if (event.type === "answerRequested") {
        if (!this.token) await this.connect();
      } else if (event.type === "heldRequested") {
        await this.handleHold(event);
      } else if (event.type === "heldCancelled" && event.callId === this.state.call?.id) {
        if (!this.pendingHold || this.pendingHold.actionId === event.actionId && this.pendingHold.phase === "unclaimed") {
          // CallKit or the phone refused this phone's own hold before the server was asked.
          const requested = this.pendingHold?.actionId === event.actionId || this.state.holdPhase === "requesting";
          this.diag("hold.cancelled", { call: short(event.callId), requested, phase: this.state.holdPhase });
          this.pendingHold = null; this.update({ holdPhase: "idle", ...(requested ? { error: holdRefused } : {}) });
        }
      } else if (["holdSyncPending", "holdSynced", "holdSyncFailed"].includes(event.type)) {
        this.mediaSyncEvent(event);
      } else if (event.type === "pushRejected") {
        this.pushRejected(event);
      } else if ((event.type === "incoming" || event.type === "push") && event.callId) {
        const id = event.callId;
        if (this.finished.has(id)) { this.diag("offer.done", { call: short(id), type: event.type, outcome: "finished" }); await this.native.reject(id); return; }
        if (this.authorizing.has(id)) {
          // The SDK INVITE of a push being prepared names the leg the push does not.
          if (event.type === "incoming") this.pushInvites.set(id, event);
          this.diag("offer.done", { call: short(id), type: event.type, outcome: event.type === "incoming" ? "stored_for_push" : "already_authorizing" });
          return;
        }
        if (this.state.call?.id === id) { this.diag("offer.done", { call: short(id), type: event.type, outcome: "current_call" }); return; }
        if (this.state.call || this.state.termination) { this.diag("offer.done", { call: short(id), type: event.type, outcome: "busy" }); await this.native.reject(id); return; }
        // A real SDK INVITE has a leg UUID, but no control ID until ANSWER.
        // Hold it until the HTTP result establishes the exact outgoing intent.
        if (this.pendingDial) { this.pendingInvites.set(id, event); this.diag("offer.done", { call: short(id), type: event.type, outcome: "stored_for_dial" }); return; }
        this.authorizing.add(id);
        let replayInvite = false, outcome = "stale";
        try {
          // A push wake may follow hours of suspension. Refresh the provider
          // token and prepare native signaling before forwarding CallKit answer.
          if (!this.token || event.type === "push") await this.connect();
          if (!this.current(generation) || this.finished.has(id)) return;
          if (!this.token || this.state.registration === "error") { outcome = "not_ready"; await this.native.reject(id); return; }
          if (event.type === "push") {
            // A push may arrive after a shared connect has already crossed the
            // native bridge. Its completion alone does not prove this push was prepared.
            const snapshot = await this.native.snapshot();
            if (!this.current(generation) || this.finished.has(id)) return;
            const prepared = snapshot.preparedPushCallId?.toLowerCase() === id.toLowerCase();
            const invited = Boolean(snapshot.calls?.some(call => call.callId?.toLowerCase() === id.toLowerCase()));
            this.diag("offer.prepare", { call: short(id), prepared, invited, ready: snapshot.ready });
            if (!prepared && !invited) {
              await this.native.connect(this.token.token);
              if (!this.current(generation) || this.finished.has(id)) return;
            }
            // Telnyx push metadata names no provider leg (SDK 4.2.2 reads it from the
            // INVITE). The prepared socket's INVITE is authorized by its own leg.
            if (!event.providerLegId) { outcome = "awaiting_invite"; replayInvite = true; return; }
          }
          const identity = event.callControlId ? { callControlId: event.callControlId } : { providerLegId: event.providerLegId };
          const offer = await this.authorizeOffer(this.token.deviceSessionId, identity, id, generation);
          if (!offer || !this.current(generation) || this.finished.has(id)) return;
          const intent = this.outgoingIntent;
          this.diag("offer.authorized", { call: short(id), role: offer.role, direction: offer.direction, intent: Boolean(intent) });
          if (offer.role === "caller" && !intent) { outcome = "caller_without_intent"; await this.native.reject(id); return; }
          if (intent && (offer.role !== "caller" || offer.direction !== (intent.kind === "internal" ? "internal" : "outbound")
            || offer.callControlId !== intent.operatorLegCallControlId || offer.sessionId !== intent.sessionId)) {
            outcome = "intent_mismatch"; await this.native.reject(id); return;
          }
          // Recheck after HTTP: another simultaneous offer may already own UI.
          const activeCall = this.snapshot().call;
          if (activeCall && activeCall.id !== id) { outcome = "busy_after_authorization"; await this.native.reject(id); return; }
          // Reserve the single call before crossing the async bridge. Native
          // may synchronously emit ACTIVE/ended while authorize is resolving.
          // A new call starts without an earlier call's error.
          this.update({ call: { id, sessionId: offer.sessionId, number: offer.number, displayName: offer.displayName,
            callControlId: offer.callControlId, state: intent ? "CONNECTING" : "RINGING", outgoing: Boolean(intent), connected: false, internal: offer.direction === "internal" }, holdPhase: "idle",
            ...(intent ? {} : { error: null }) });
          this.schedule();
          await this.native.authorize(id, offer.sessionId, offer.callControlId);
          outcome = "authorized";
        } catch (error) {
          outcome = "error";
          this.diag("offer.error", { call: short(id), type: event.type, ...failure(error) });
          // Preparing this push or resolving the leg it named failed before the call was
          // reserved. An INVITE that arrived meanwhile names its own leg: authorize that one.
          if (event.type !== "push" || !this.pushInvites.has(id) || this.snapshot().call?.id === id
            || !this.current(generation) || this.finished.has(id)) throw error;
          replayInvite = true;
        } finally {
          this.authorizing.delete(id);
          const invite = this.pushInvites.get(id); this.pushInvites.delete(id);
          this.diag("offer.done", { call: short(id), type: event.type, outcome, replay: replayInvite && Boolean(invite) });
          this.scheduleRecovery();
          if (replayInvite && invite && this.current(generation) && !this.finished.has(id)) await this.event(invite);
        }
      } else if (event.type === "outgoing" && event.callId && event.sessionId) {
        if (this.finished.has(event.callId)) return;
        const previous = this.state.call?.id === event.callId && this.state.call.sessionId === event.sessionId ? this.state.call : null;
        if (!previous) { this.pendingHold = null; this.nativeMediaSync = null; }
        this.update({ call: { ...previous, id: event.callId, sessionId: event.sessionId, number: event.number ?? previous?.number ?? null,
          callControlId: event.callControlId ?? previous?.callControlId, state: previous?.state ?? "CONNECTING", outgoing: true,
          connected: previous?.connected ?? false, internal: previous?.internal ?? this.outgoingIntent?.kind === "internal" }, holdPhase: previous ? this.state.holdPhase : "idle", nativeSyncPending: previous ? this.state.nativeSyncPending : false }); this.schedule();
      } else if (event.type === "callState" && event.callId && this.state.call?.id === event.callId) {
        this.update({ call: { ...this.state.call, state: event.state ?? "CONNECTING" } });
        if (event.state === "ACTIVE") await this.checkCall();
      } else if (event.type === "ended") {
        if (event.callId) {
          if (this.finished.has(event.callId)) return;
          this.pendingInvites.delete(event.callId); this.rememberFinished(event.callId);
        }
        if (event.sessionId === this.outgoingIntent?.sessionId) this.outgoingIntent = null;
        if (event.callId && this.state.call?.id === event.callId) {
          const call = this.state.call;
          if (this.outgoingIntent?.sessionId === call.sessionId) this.outgoingIntent = null;
          this.pendingHold = null; this.nativeMediaSync = null;
          // A hold refused as the call ended is not news after it.
          this.update({ call: null, holdPhase: "idle", nativeSyncPending: false, audioActive: false, muted: false, speaker: false,
            ...(this.state.error === holdRefused ? { error: null } : {}) });
          if ((call.outgoing || call.connected) && !this.handedAway.has(call.sessionId)) await this.endSession(call.sessionId);
          this.schedule();
        } else if (event.outgoing && event.sessionId) await this.endSession(event.sessionId);
        if ((this.refreshPushRegistration || (this.foreground && this.state.registration !== "registered")) && this.token && !this.connecting && !this.state.call && !this.outgoingIntent && !this.pendingDial) {
          this.refreshPushRegistration = false; await this.connect();
        }
      } else if (event.type === "outgoingFailed" && event.sessionId && this.token) {
        if (this.outgoingIntent?.sessionId !== event.sessionId
          && !(this.state.call?.outgoing && this.state.call.sessionId === event.sessionId)) return;
        if (this.outgoingIntent?.sessionId === event.sessionId) this.outgoingIntent = null;
        await this.endSession(event.sessionId);
        if (!this.current(generation)) return;
        if (!this.state.call || this.state.call.sessionId === event.sessionId) {
          this.update({ call: null, error: "Hovor sa nepodarilo spojiť. Skúste znova." }); this.schedule();
        }
      } else if (event.type === "audio") { this.update({ audioActive: event.active === true }); this.schedule(); }
      else if (event.type === "muted") this.update({ muted: event.muted === true });
    } catch (error) {
      if (!this.current(generation)) return;
      this.diag("phone.event_error", { type: event.type, call: short(event.callId), ...failure(error) });
      if (event.callId) {
        if (this.state.call?.id === event.callId) { this.update({ call: null }); this.schedule(); }
        await this.native.reject(event.callId).catch(() => {});
      }
      this.fail(error);
    }
  }
  private rememberFinished(id: string) {
    this.finished.add(id);
    if (this.finished.size > 50) this.finished.delete(this.finished.values().next().value!);
  }
  private async authorizeOffer(leaseId: string, identity: { callControlId?: string; providerLegId?: string }, id: string, generation: number) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!this.current(generation) || this.finished.has(id)) return null;
      try { return await this.api.authorize(leaseId, identity); }
      catch (error) {
        // An INVITE can beat the server's provider-leg insert. Only that
        // explicit race is retried; cancelled/foreign offers fail immediately.
        if (!(error instanceof MobileApiError) || error.code !== "native_offer_pending" || attempt === 4) throw error;
        this.diag("offer.authorize_retry", { call: short(id), attempt });
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    }
    return null;
  }
  private fail(error: unknown, preserveOutgoingRequest = false) {
    if (this.stopped) return;
    const message = error instanceof MobileApiError ? error.code === "native_voice_disabled"
      ? "Telefonovanie v aplikácii ešte nie je aktivované." : error.message : "Telefonovanie sa nepodarilo pripraviť.";
    this.update({ error: message });
    const { status, code } = failure(error);
    const revoke = error instanceof MobileApiError && ([401, 403, 502].includes(error.status) || ["native_lease_stale", "native_voice_disabled"].includes(error.code ?? ""));
    this.diag("phone.fail", { status, code, revoke });
    if (revoke) {
      this.connectionRequested = false;
      if (this.pendingDial && this.state.dialing) this.pendingDial.uncertain = true;
      const ownedSession = this.state.call && (this.state.call.outgoing || this.state.call.connected) ? this.state.call.sessionId : this.outgoingIntent?.sessionId;
      this.generation += 1;
      this.update({ termination: this.state.termination ?? ownedSession ?? null });
      // An untrusted start reply may follow a committed call. Disconnect its
      // credentials, but keep that one command for an explicit same-ID retry.
      this.token = null; if (!preserveOutgoingRequest && !this.pendingDial?.uncertain) this.pendingDial = null;
      this.pendingHold = null; this.nativeMediaSync = null;
      this.outgoingIntent = null; this.pendingInvites.clear(); this.update({ registration: "error", call: null, holdPhase: "idle", nativeSyncPending: false, dialing: false, cancelingAttempt: false, audioActive: false, muted: false, speaker: false,
        pushRegistered: null, lastHeartbeatAt: null, checkingDiagnostics: false, retryTarget: this.pendingDial?.target ?? null }); this.schedule();
      void this.native?.disconnect("fail:" + (code === "none" ? status : code)).catch(() => {});
    }
  }
  private endSession(sessionId: string): Promise<void> {
    const existing = this.ending.get(sessionId); if (existing) return existing;
    const leaseId = this.token?.deviceSessionId ?? this.leaseId;
    if (!leaseId) return Promise.resolve();
    const generation = this.generation;
    this.update({ termination: sessionId }); this.schedule();
    const work = this.api.end(leaseId, sessionId).then(result => {
      this.diag("session.end", { session: short(sessionId), result: "ok", pending: result.terminationPending });
      if (this.current(generation)) { this.update({ termination: result.terminationPending ? sessionId : null }); this.schedule(); }
    }).catch(error => {
      this.diag("session.end", { session: short(sessionId), result: "error", ...failure(error) });
      if (!this.current(generation)) return;
      if (error instanceof MobileApiError && error.status === 403 && this.handedAway.has(sessionId)) { this.update({ termination: null }); this.schedule(); return; }
      // The other side already ended it: nothing is left to terminate. Keeping the
      // marker would refuse every later incoming call as busy.
      if (error instanceof MobileApiError && error.status === 409 && error.code === "not_active") { if (this.state.termination === sessionId) this.update({ termination: null }); this.schedule(); return; }
      this.fail(error);
    }).finally(() => this.ending.delete(sessionId));
    this.ending.set(sessionId, work); return work;
  }
  async answer() { if (this.state.call) try { await this.native?.answer(this.state.call.id); } catch (error) { this.fail(error); } }
  async end() {
    const call = this.state.call;
    try {
      if (call && (call.outgoing || call.connected)) { const ended = this.endSession(call.sessionId); await this.native?.end(); await ended; }
      else if (call) await this.native?.end();
      else if (this.outgoingIntent) { const sessionId = this.outgoingIntent.sessionId; this.outgoingIntent = null; await this.native?.end(); await this.endSession(sessionId); }
      else if (this.state.termination) await this.endSession(this.state.termination);
    } catch (error) { this.fail(error); }
  }
  /** The connected call and its lease, or a refusal the call screen shows in place. A
   * confirmation names its call, so a dialog left open never acts on the next one. */
  private connectedCall(confirmed?: string) {
    const call = this.state.call, token = this.token;
    if (!call?.connected || !token || this.state.termination) throw new MobileApiError("Hovor nie je spojený.", 409);
    if (confirmed !== undefined && confirmed !== call.sessionId) throw new MobileApiError("Hovor sa medzitým zmenil. Skúste to znova.", 409);
    return { sessionId: call.sessionId, leaseId: token.deviceSessionId, internal: call.internal === true };
  }
  /** Colleagues for a transfer of the own call; the server rechecks everything on transfer. */
  async transferTargets() { const { sessionId, leaseId } = this.connectedCall(); return this.api.transferTargets(leaseId, sessionId); }
  /** Blind transfer of the confirmed call to a colleague. The server then hangs up this
   * phone's leg, which must not read as a hang-up of the call; the end is read at once.
   * Resolves the server state: "talking" while an announcement still precedes the transfer. */
  async transfer(profileId: string, confirmed: string) {
    const { sessionId, leaseId, internal } = this.connectedCall(confirmed);
    if (internal) throw new MobileApiError("Hovor s kolegom nemožno prepojiť.", 409);
    if (this.pendingHold || this.state.holdPhase !== "idle" || this.state.nativeSyncPending) throw new MobileApiError("Počkajte, kým sa overí podržanie hovoru.", 409);
    this.handedAway.set(sessionId, Number.POSITIVE_INFINITY);
    for (const old of this.handedAway.keys()) { if (this.handedAway.size <= 20) break; if (old !== sessionId) this.handedAway.delete(old); }
    this.update({ transferPending: sessionId, error: null });
    try {
      const result = await this.api.transfer(leaseId, sessionId, profileId);
      this.settleTransfer(sessionId);
      return result;
    } catch (error) {
      // A definite refusal leaves the call here; an unknown outcome is settled by the next status read.
      if (error instanceof MobileApiError && error.status >= 400 && error.status < 500) {
        this.handedAway.delete(sessionId);
        if (this.state.transferPending === sessionId) this.update({ transferPending: null });
      } else this.settleTransfer(sessionId, true);
      throw error;
    }
  }
  /** From now on a status read can show that the call stayed here; read it at once. */
  private settleTransfer(sessionId: string, failed = false) {
    if (!this.handedAway.has(sessionId)) return;
    this.transferEpoch += 1; this.handedAway.set(sessionId, this.transferEpoch);
    // The failure is already on screen; do not add a second message when the call is found here.
    if (failed && this.state.transferPending === sessionId) this.update({ transferPending: null });
    void this.checkCall();
  }
  /** A confirmed hang-up of one call; a dialog left open never ends the next one. */
  async endConfirmed(sessionId: string) {
    if (this.state.call?.sessionId !== sessionId && this.state.termination !== sessionId) return;
    await this.end();
  }
  /** Stops recording on the caller's request; `retry` repeats an unconfirmed stop. The answer is
   * the recorder as the server records it, so an unconfirmed stop stays visible as such. */
  async stopRecording(retry: boolean, confirmed: string) {
    const { sessionId, leaseId } = this.connectedCall(confirmed);
    const generation = this.generation;
    this.recordingEpoch += 1;
    try {
      const recording = await this.api.stopRecording(leaseId, sessionId, retry);
      const call = this.state.call;
      if (this.current(generation) && call?.sessionId === sessionId) this.update({ call: { ...call, recording } });
      return recording;
    } finally { this.recordingEpoch += 1; }
  }
  async mute() { try { await this.native?.mute(!this.state.muted); } catch (error) { this.fail(error); } }
  async speaker() { try { const enabled = !this.state.speaker; await this.native?.speaker(enabled); this.update({ speaker: enabled }); } catch (error) { this.fail(error); } }
  async dtmf(digits: string) {
    const call = this.state.call;
    if (!call?.connected || call.media?.state === "held" || call.media?.state === "pending" || this.state.holdPhase !== "idle" || this.state.nativeSyncPending || this.state.termination
      || ["DROPPED", "RECONNECTING"].includes(call.state)) return;
    try { await this.native?.dtmf(digits); } catch (error) { this.fail(error); }
  }
  async presence(status: "available" | "paused" | "offline") {
    if (!this.token) return;
    try { await this.api.presence(this.token.deviceSessionId, status); } catch (error) { this.fail(error); throw error; }
  }
  /** `reason` names the caller in the device log, e.g. "logout", "unmount" or "replaced". */
  async disconnect(reason = "explicit") {
    this.diag("phone.disconnect", { reason, token: Boolean(this.token), call: Boolean(this.state.call), requested: this.connectionRequested });
    this.connectionRequested = false;
    this.generation += 1; this.token = null; this.pendingDial = null; this.pendingHold = null; this.nativeMediaSync = null; this.outgoingIntent = null; this.pendingInvites.clear(); this.schedule();
    await this.native?.disconnect(reason);
    const leaseId = this.leaseId ?? await this.leases?.load();
    if (leaseId) try { await this.api.disconnect(leaseId); } catch (error) {
      this.diag("phone.disconnect_error", { reason, ...failure(error) });
      // A superseded lease is already disconnected. Provider/network failures
      // retain the saved lease so the user can retry revocation before logout.
      if (!(error instanceof MobileApiError && error.status === 409)) throw error;
    }
    await this.leases?.clear(); this.leaseId = null;
    this.update({ registration: "unregistered", call: null, holdPhase: "idle", nativeSyncPending: false, termination: null, dialing: false, cancelingAttempt: false, audioActive: false, muted: false, speaker: false,
      pushRegistered: null, lastHeartbeatAt: null, heartbeatError: null, diagnosticsError: null, checkingDiagnostics: false, retryTarget: null });
  }
  dispose() {
    this.stopped = true; this.generation += 1; this.off?.(); this.off = null;
    if (this.heartbeat) clearInterval(this.heartbeat); if (this.monitor) clearInterval(this.monitor);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.listeners.clear();
  }
}
