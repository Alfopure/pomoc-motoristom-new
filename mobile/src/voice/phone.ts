import { MobileApiError } from "../lib/api";
import type { VoiceApi, VoiceCallTarget, VoiceHoldCommand, VoiceHoldResult, VoiceMedia, VoiceMediaState, VoiceOutgoing, VoiceStatus, VoiceToken } from "./api";

export type VoiceEvent = { type: string; callId?: string; callControlId?: string; providerLegId?: string; sessionId?: string; number?: string; state?: string; active?: boolean; muted?: boolean; outgoing?: boolean;
  actionId?: string; held?: boolean; expectedVersion?: number; phase?: "unclaimed" | "dispatched" | "uncertain"; actionLive?: boolean; systemHeld?: boolean; privacyHold?: boolean; media?: Pick<VoiceMedia, "state" | "version" | "canHold"> };
export type NativeHold = { callId: string; sessionId: string; callControlId: string; actionId: string; held: boolean; expectedVersion: number; phase: "unclaimed" | "dispatched" | "uncertain"; actionLive: boolean };
export type NativeMediaSync = Pick<NativeHold, "callId" | "sessionId" | "callControlId" | "actionId" | "held" | "expectedVersion">;
export type MicrophonePermission = "granted" | "denied" | "undetermined" | "unknown";
export type PhoneSnapshot = { ready: boolean; audioActive: boolean; microphonePermission?: MicrophonePermission; pushRegistered?: boolean; preparedPushCallId?: string | null; wasEnabled?: boolean; calls?: VoiceEvent[]; pending: VoiceEvent[]; pendingHolds?: NativeHold[]; pendingSyncs?: NativeMediaSync[] };
export type NativePhone = {
  snapshot(): Promise<PhoneSnapshot>; requestMicrophone(): Promise<boolean>; connect(token: string): Promise<void>; disconnect(): Promise<void>;
  authorize(callId: string, sessionId: string, controlId: string): Promise<void>; reject(callId: string): Promise<void>;
  expectOutgoing(controlId: string, sessionId: string, number: string, genericHandle?: boolean): Promise<void>;
  answer(callId: string): Promise<void>; confirmConnected(callId: string): Promise<void>; end(): Promise<void>; mute(muted: boolean): Promise<void>; speaker(enabled: boolean): Promise<void>; dtmf(digits: string): Promise<void>;
  requestHold(callId: string, held: boolean): Promise<void>; claimHold(callId: string, actionId: string): Promise<boolean>;
  syncMedia(callId: string, sessionId: string, controlId: string, state: VoiceMediaState, version: number, canHold: boolean): Promise<void>;
  resolveHold(callId: string, sessionId: string, controlId: string, actionId: string, outcome: "confirmed" | "rejected" | "uncertain", state: VoiceMediaState, version: number, canHold: boolean): Promise<void>;
  subscribe(callback: (event: VoiceEvent) => void): () => void;
};
export type PhoneLeaseStore = { load(): Promise<string | null>; save(id: string): Promise<void>; clear(): Promise<void> };
export type PhoneDialTarget = VoiceCallTarget;
export type PhoneState = {
  supported: boolean; registration: "unregistered" | "connecting" | "registered" | "error"; takeoverRequired: boolean;
  call: { id: string; sessionId: string; number: string | null; displayName?: string | null; state: string; outgoing: boolean; connected: boolean; callControlId?: string; media?: VoiceMedia } | null;
  termination: string | null; dialing: boolean; cancelingAttempt: boolean; audioActive: boolean; muted: boolean; speaker: boolean; error: string | null;
  microphonePermission: MicrophonePermission; pushRegistered: boolean | null; lastHeartbeatAt: string | null;
  heartbeatError: string | null; diagnosticsError: string | null; checkingDiagnostics: boolean;
  retryTarget: PhoneDialTarget | null;
  holdPhase: "idle" | "requesting" | "pending" | "uncertain";
  nativeSyncPending: boolean;
};

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
  private pendingDial: { requestId: string; target: PhoneDialTarget; uncertain: boolean } | null = null;
  private outgoingIntent: (VoiceOutgoing & { kind: PhoneDialTarget["kind"] }) | null = null;
  private pendingHold: (NativeHold & { leaseId: string }) | null = null;
  private holdWork: NativeHold | null = null;
  private nativeMediaSync: NativeMediaSync | null = null;
  private nativeSyncRevision = 0;
  private refreshPushRegistration = false;
  private pendingInvites = new Map<string, VoiceEvent>();
  private authorizing = new Set<string>();
  private finished = new Set<string>();
  private ending = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  constructor(private api: VoiceApi, private native: NativePhone | null, private uuid: () => string, private leases?: PhoneLeaseStore) {
    this.state = { supported: Boolean(native), registration: "unregistered", takeoverRequired: false, call: null, termination: null,
      dialing: false, cancelingAttempt: false, audioActive: false, muted: false, speaker: false, error: null,
      microphonePermission: "unknown", pushRegistered: null, lastHeartbeatAt: null, heartbeatError: null, diagnosticsError: null, checkingDiagnostics: false, retryTarget: null, holdPhase: "idle", nativeSyncPending: false };
  }
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  snapshot = () => this.state;
  private current(generation: number) { return !this.stopped && generation === this.generation; }
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
    this.applyDiagnostics(snapshot);
    for (const call of snapshot.calls ?? []) {
      if (call.callId && call.sessionId) this.update({ call: { id: call.callId, sessionId: call.sessionId, number: call.number ?? null,
        callControlId: call.callControlId, state: call.state ?? "CONNECTING", outgoing: call.outgoing === true, connected: false }, muted: call.muted === true, audioActive: snapshot.audioActive });
    }
    for (const sync of snapshot.pendingSyncs ?? []) this.mediaSyncEvent({ type: "holdSyncPending", ...sync });
    if (snapshot.pending.length || snapshot.wasEnabled) await this.connect();
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
    this.reconnectAttempts = 0;
    return this.connectAttempt(takeover);
  }
  private connectAttempt(takeover = false, automatic = false): Promise<void> {
    if (!this.native || this.stopped) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    const generation = this.generation;
    this.update({ registration: "connecting", takeoverRequired: false, error: null });
    this.connecting = (async () => {
      try {
        const microphone = await this.native!.requestMicrophone();
        if (!this.current(generation)) return;
        this.update({ microphonePermission: microphone ? "granted" : "denied" });
        if (!microphone) throw new MobileApiError("Povoľte mikrofón v nastaveniach iPhone.", 403);
        if (!this.current(generation) || (automatic && !this.idleForRecovery())) return;
        this.leaseId ??= await this.leases?.load() ?? null;
        if (!this.current(generation) || (automatic && !this.idleForRecovery())) return;
        const token = await this.api.token(this.leaseId ?? undefined, takeover);
        if (!this.current(generation)) { await this.api.disconnect(token.deviceSessionId).catch(() => {}); return; }
        this.leaseId = token.deviceSessionId;
        await this.leases?.save(token.deviceSessionId);
        if (!this.current(generation)) return;
        this.token = token;
        if (automatic && !this.idleForRecovery()) return;
        await this.native!.connect(token.token);
        if (!this.current(generation)) return;
        const pending = await this.native!.snapshot();
        if (!this.current(generation)) return;
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
      } catch (error) {
        if (this.current(generation)) {
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
      }
    })();
    return this.connecting;
  }
  setForeground(value: boolean) {
    this.foreground = value; this.schedule();
    if (value) void this.refreshDiagnostics();
    if (value && this.token) {
      if (this.state.registration !== "registered" && !this.state.call && !this.outgoingIntent) void this.connect();
      else void this.touch();
    }
  }
  private idleForRecovery() {
    return !this.stopped && this.foreground && this.token && !this.state.call
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
    const generation = this.generation, requestedCall = this.state.call; this.monitorBusy = true;
    try {
      if (this.pendingHold) { await this.refreshHold(); return; }
      const status = await this.api.status(leaseId, sessionId);
      if (!this.current(generation)) return;
      await this.applyCallStatus(status, generation, false, requestedCall);
    } catch (error) { if (this.current(generation)) this.fail(error); }
    finally { this.monitorBusy = false; }
  }
  private async applyCallStatus(status: VoiceStatus, generation: number, holdResult = false, requestedCall = this.state.call) {
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
        this.update({ call: { ...call, connected: status.connected, ...(applyMedia ? { media, callControlId: media.callControlId ?? call.callControlId } : {}) } });
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
      || ["DROPPED", "RECONNECTING"].includes(call.state)) return;
    const generation = this.generation;
    this.update({ holdPhase: "requesting", error: null });
    try { await this.native.requestHold(call.id, call.media.state !== "held"); }
    catch {
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
      this.nativeSyncRevision += 1; this.nativeMediaSync = event as NativeMediaSync; this.update({ nativeSyncPending: true });
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
      || !Number.isSafeInteger(event.expectedVersion) || event.expectedVersion! < 0 || this.state.termination) return;
    if (this.pendingHold) {
      if (this.pendingHold.actionId === event.actionId && this.holdWork !== this.pendingHold) await this.refreshHold();
      return;
    }
    const dispatched = event.phase === "dispatched" || event.phase === "uncertain";
    if (!dispatched && (!call.connected || !call.media?.canHold || event.expectedVersion !== call.media.version)) return;
    const command: NativeHold & { leaseId: string } = { callId: call.id, sessionId: call.sessionId, callControlId: event.callControlId!,
      actionId: event.actionId, held: event.held, expectedVersion: event.expectedVersion!, phase: event.phase ?? "unclaimed",
      actionLive: event.actionLive !== false, leaseId: token.deviceSessionId };
    this.pendingHold = command;
    if (dispatched) { this.update({ holdPhase: "uncertain" }); await this.refreshHold(); return; }
    const generation = this.generation;
    this.holdWork = command; this.update({ holdPhase: "pending", error: null });
    try {
      const claimed = await this.native.claimHold(command.callId, command.actionId);
      if (!this.holdCurrent(command, generation)) return;
      if (!claimed) { this.pendingHold = null; this.update({ holdPhase: "idle" }); return; }
      command.phase = "dispatched";
      const result = await this.api.hold(command.leaseId, command.sessionId, this.holdPayload(command));
      if (this.holdCurrent(command, generation)) await this.applyHoldResult(command, result, generation);
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
      const result = await this.api.holdStatus(command.leaseId, command.sessionId, this.holdPayload(command));
      if (this.holdCurrent(command, generation)) await this.applyHoldResult(command, result, generation);
    } catch (error) { if (this.holdCurrent(command, generation)) await this.holdFailure(command, error); }
    finally { if (this.holdWork === command) this.holdWork = null; }
  }
  private async applyHoldResult(command: NativeHold & { leaseId: string }, result: VoiceHoldResult, generation: number) {
    await this.applyCallStatus(result, generation, true);
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
    if (error instanceof MobileApiError && ([401, 403].includes(error.status) || ["native_lease_stale", "native_voice_disabled"].includes(error.code ?? ""))) {
      this.fail(error); return;
    }
    command.phase = "uncertain";
    this.update({ holdPhase: "uncertain", error: "Výsledok podržania ešte overujeme. Hovor môžete ukončiť." });
    const media = this.state.call?.media;
    await this.native?.resolveHold(command.callId, command.sessionId, command.callControlId, command.actionId, "uncertain",
      media?.state ?? "pending", media?.version ?? command.expectedVersion, false).catch(() => {});
  }
  async dial(to: string) { await this.startCall({ kind: "external", number: to }); }
  async dialColleague(profileId: string, name: string) { await this.startCall({ kind: "internal", profileId, name }); }
  private retainsOutgoingCommand(requestId: string, sessionId: string) {
    return !this.stopped && (this.pendingDial?.requestId === requestId
      || this.outgoingIntent?.sessionId === sessionId || this.state.call?.sessionId === sessionId);
  }
  private async startCall(target: PhoneDialTarget) {
    if (!this.native || !this.token || this.state.registration !== "registered" || this.state.microphonePermission === "denied"
      || this.state.call || this.state.termination || this.state.dialing || this.state.cancelingAttempt || this.outgoingIntent) return;
    const original = this.pendingDial?.target;
    if (original && !(original.kind === "external" && target.kind === "external" && original.number === target.number
      || original.kind === "internal" && target.kind === "internal" && original.profileId === target.profileId)) {
      this.update({ error: "Najprv zopakujte pôvodný pokus o volanie." }); return;
    }
    this.pendingDial ??= { requestId: this.uuid(), target, uncertain: false };
    const generation = this.generation, leaseId = this.token.deviceSessionId;
    let createdSession: string | null = null;
    this.update({ dialing: true, error: null, retryTarget: null });
    try {
      const command = this.pendingDial;
      const outgoing = command.target.kind === "internal"
        ? await this.api.startInternal(leaseId, command.requestId, command.target.profileId)
        : await this.api.start(leaseId, command.requestId, command.target.number);
      createdSession = outgoing.sessionId;
      if (!this.current(generation)) {
        if (!this.retainsOutgoingCommand(command.requestId, outgoing.sessionId)) await this.api.end(leaseId, outgoing.sessionId).catch(() => {});
        return;
      }
      this.outgoingIntent = { ...outgoing, kind: command.target.kind };
      await this.native.expectOutgoing(outgoing.operatorLegCallControlId, outgoing.sessionId, outgoing.to, command.target.kind === "internal");
      if (!this.current(generation)) return;
      this.pendingDial = null;
      const invites = [...this.pendingInvites.values()]; this.pendingInvites.clear();
      for (const event of invites) await this.event(event);
      this.schedule();
    } catch (error) { if (this.current(generation)) {
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
          this.pendingHold = null; this.update({ holdPhase: "idle" });
        }
      } else if (["holdSyncPending", "holdSynced", "holdSyncFailed"].includes(event.type)) {
        this.mediaSyncEvent(event);
      } else if ((event.type === "incoming" || event.type === "push") && event.callId) {
        const id = event.callId;
        if (this.finished.has(id)) { await this.native.reject(id); return; }
        if (this.authorizing.has(id)) return;
        if (this.state.call?.id === id) return;
        if (this.state.call || this.state.termination) { await this.native.reject(id); return; }
        // A real SDK INVITE has a leg UUID, but no control ID until ANSWER.
        // Hold it until the HTTP result establishes the exact outgoing intent.
        if (this.pendingDial) { this.pendingInvites.set(id, event); return; }
        this.authorizing.add(id);
        try {
          // A push wake may follow hours of suspension. Refresh the provider
          // token and prepare native signaling before forwarding CallKit answer.
          if (!this.token || event.type === "push") await this.connect();
          if (!this.current(generation) || this.finished.has(id)) return;
          if (!this.token || this.state.registration === "error") { await this.native.reject(id); return; }
          if (event.type === "push") {
            // A push may arrive after a shared connect has already crossed the
            // native bridge. Its completion alone does not prove this push was prepared.
            const snapshot = await this.native.snapshot();
            if (!this.current(generation) || this.finished.has(id)) return;
            if (snapshot.preparedPushCallId?.toLowerCase() !== id.toLowerCase()
              && !snapshot.calls?.some(call => call.callId?.toLowerCase() === id.toLowerCase())) {
              await this.native.connect(this.token.token);
              if (!this.current(generation) || this.finished.has(id)) return;
            }
          }
          const identity = event.callControlId ? { callControlId: event.callControlId } : { providerLegId: event.providerLegId };
          const offer = await this.authorizeOffer(this.token.deviceSessionId, identity, id, generation);
          if (!offer || !this.current(generation) || this.finished.has(id)) return;
          const intent = this.outgoingIntent;
          if (offer.role === "caller" && !intent) { await this.native.reject(id); return; }
          if (intent && (offer.role !== "caller" || offer.direction !== (intent.kind === "internal" ? "internal" : "outbound")
            || offer.callControlId !== intent.operatorLegCallControlId || offer.sessionId !== intent.sessionId)) {
            await this.native.reject(id); return;
          }
          // Recheck after HTTP: another simultaneous offer may already own UI.
          const activeCall = this.snapshot().call;
          if (activeCall && activeCall.id !== id) { await this.native.reject(id); return; }
          // Reserve the single call before crossing the async bridge. Native
          // may synchronously emit ACTIVE/ended while authorize is resolving.
          this.update({ call: { id, sessionId: offer.sessionId, number: offer.number, displayName: offer.displayName,
            callControlId: offer.callControlId, state: intent ? "CONNECTING" : "RINGING", outgoing: Boolean(intent), connected: false }, holdPhase: "idle" });
          this.schedule();
          await this.native.authorize(id, offer.sessionId, offer.callControlId);
        } finally { this.authorizing.delete(id); this.scheduleRecovery(); }
      } else if (event.type === "outgoing" && event.callId && event.sessionId) {
        if (this.finished.has(event.callId)) return;
        const previous = this.state.call?.id === event.callId && this.state.call.sessionId === event.sessionId ? this.state.call : null;
        if (!previous) { this.pendingHold = null; this.nativeMediaSync = null; }
        this.update({ call: { ...previous, id: event.callId, sessionId: event.sessionId, number: event.number ?? previous?.number ?? null,
          callControlId: event.callControlId ?? previous?.callControlId, state: previous?.state ?? "CONNECTING", outgoing: true,
          connected: previous?.connected ?? false }, holdPhase: previous ? this.state.holdPhase : "idle", nativeSyncPending: previous ? this.state.nativeSyncPending : false }); this.schedule();
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
          this.update({ call: null, holdPhase: "idle", nativeSyncPending: false, audioActive: false, muted: false, speaker: false });
          if (call.outgoing || call.connected) await this.endSession(call.sessionId);
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
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    }
    return null;
  }
  private fail(error: unknown, preserveOutgoingRequest = false) {
    if (this.stopped) return;
    const message = error instanceof MobileApiError ? error.code === "native_voice_disabled"
      ? "Telefonovanie v tejto TEST aplikácii ešte nie je aktivované." : error.message : "Telefonovanie sa nepodarilo pripraviť.";
    this.update({ error: message });
    if (error instanceof MobileApiError && ([401, 403, 502].includes(error.status) || ["native_lease_stale", "native_voice_disabled"].includes(error.code ?? ""))) {
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
      void this.native?.disconnect().catch(() => {});
    }
  }
  private endSession(sessionId: string): Promise<void> {
    const existing = this.ending.get(sessionId); if (existing) return existing;
    const leaseId = this.token?.deviceSessionId ?? this.leaseId;
    if (!leaseId) return Promise.resolve();
    const generation = this.generation;
    this.update({ termination: sessionId }); this.schedule();
    const work = this.api.end(leaseId, sessionId).then(result => {
      if (this.current(generation)) { this.update({ termination: result.terminationPending ? sessionId : null }); this.schedule(); }
    }).catch(error => { if (this.current(generation)) this.fail(error); }).finally(() => this.ending.delete(sessionId));
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
  async disconnect() {
    this.generation += 1; this.token = null; this.pendingDial = null; this.pendingHold = null; this.nativeMediaSync = null; this.outgoingIntent = null; this.pendingInvites.clear(); this.schedule();
    await this.native?.disconnect();
    const leaseId = this.leaseId ?? await this.leases?.load();
    if (leaseId) try { await this.api.disconnect(leaseId); } catch (error) {
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
