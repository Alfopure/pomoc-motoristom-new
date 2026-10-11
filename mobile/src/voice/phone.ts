import { MobileApiError } from "../lib/api";
import type { VoiceApi, VoiceOutgoing, VoiceToken } from "./api";

export type VoiceEvent = { type: string; callId?: string; callControlId?: string; providerLegId?: string; sessionId?: string; number?: string; state?: string; active?: boolean; muted?: boolean; outgoing?: boolean };
export type PhoneSnapshot = { ready: boolean; audioActive: boolean; pushRegistered?: boolean; wasEnabled?: boolean; calls?: VoiceEvent[]; pending: VoiceEvent[] };
export type NativePhone = {
  snapshot(): Promise<PhoneSnapshot>; requestMicrophone(): Promise<boolean>; connect(token: string): Promise<void>; disconnect(): Promise<void>;
  authorize(callId: string, sessionId: string, controlId: string): Promise<void>; reject(callId: string): Promise<void>;
  expectOutgoing(controlId: string, sessionId: string, number: string): Promise<void>;
  answer(callId: string): Promise<void>; confirmConnected(callId: string): Promise<void>; end(): Promise<void>; mute(muted: boolean): Promise<void>; speaker(enabled: boolean): Promise<void>; dtmf(digits: string): Promise<void>;
  subscribe(callback: (event: VoiceEvent) => void): () => void;
};
export type PhoneLeaseStore = { load(): Promise<string | null>; save(id: string): Promise<void>; clear(): Promise<void> };
export type PhoneState = {
  supported: boolean; registration: "unregistered" | "connecting" | "registered" | "error"; takeoverRequired: boolean;
  call: { id: string; sessionId: string; number: string | null; state: string; outgoing: boolean; connected: boolean } | null;
  termination: string | null; dialing: boolean; audioActive: boolean; muted: boolean; speaker: boolean; error: string | null;
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
  private pendingDial: { requestId: string; to: string } | null = null;
  private outgoingIntent: VoiceOutgoing | null = null;
  private refreshPushRegistration = false;
  private pendingInvites = new Map<string, VoiceEvent>();
  private authorizing = new Set<string>();
  private finished = new Set<string>();
  private ending = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  constructor(private api: VoiceApi, private native: NativePhone | null, private uuid: () => string, private leases?: PhoneLeaseStore) {
    this.state = { supported: Boolean(native), registration: "unregistered", takeoverRequired: false, call: null, termination: null,
      dialing: false, audioActive: false, muted: false, speaker: false, error: null };
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
    for (const call of snapshot.calls ?? []) {
      if (call.callId && call.sessionId) this.update({ call: { id: call.callId, sessionId: call.sessionId, number: call.number ?? null,
        state: call.state ?? "CONNECTING", outgoing: call.outgoing === true, connected: false }, audioActive: snapshot.audioActive });
    }
    if (snapshot.pending.length || snapshot.wasEnabled) await this.connect();
  }
  connect(takeover = false): Promise<void> {
    if (!this.native || this.stopped) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const generation = this.generation;
    this.update({ registration: "connecting", takeoverRequired: false, error: null });
    this.connecting = (async () => {
      try {
        if (!await this.native!.requestMicrophone()) throw new MobileApiError("Povoľte mikrofón v nastaveniach iPhone.", 403);
        this.leaseId ??= await this.leases?.load() ?? null;
        if (!this.current(generation)) return;
        const token = await this.api.token(this.leaseId ?? undefined, takeover);
        if (!this.current(generation)) { await this.api.disconnect(token.deviceSessionId).catch(() => {}); return; }
        this.leaseId = token.deviceSessionId;
        await this.leases?.save(token.deviceSessionId);
        if (!this.current(generation)) return;
        this.token = token;
        await this.native!.connect(token.token);
        if (!this.current(generation)) return;
        const pending = await this.native!.snapshot();
        if (pending.ready) await this.event({ type: "registration", state: "registered" });
        for (const event of pending.pending) void this.event(event);
      } catch (error) {
        if (this.current(generation)) {
          this.update({ registration: "error", takeoverRequired: error instanceof MobileApiError && error.status === 409 });
          this.fail(error);
        }
      } finally {
        this.connecting = null;
        if (this.current(generation) && this.refreshPushRegistration && this.token && this.state.registration !== "error"
          && !this.state.call && !this.pendingDial && !this.outgoingIntent) {
          this.refreshPushRegistration = false; void this.connect();
        }
      }
    })();
    return this.connecting;
  }
  setForeground(value: boolean) {
    this.foreground = value; this.schedule();
    if (value && this.token) {
      if (this.state.registration !== "registered" && !this.state.call && !this.outgoingIntent) void this.connect();
      else void this.touch();
    }
  }
  private schedule() {
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null;
    if (this.monitor) clearInterval(this.monitor); this.monitor = null;
    if (this.stopped || (!this.token && !(this.leaseId && this.state.termination))) return;
    // No JS/background keepalive: suspended iOS is reached through APNs.
    if (this.token && this.foreground && this.state.registration === "registered") this.heartbeat = setInterval(() => { void this.touch(); }, 30_000);
    if ((this.foreground || this.state.audioActive) && (this.state.call || this.state.termination)) this.monitor = setInterval(() => { void this.checkCall(); }, 2_000);
  }
  private async touch() {
    if (!this.token || this.heartbeatBusy || this.stopped) return;
    const generation = this.generation; this.heartbeatBusy = true;
    try {
      if (Date.parse(this.token.expiresAt) - Date.now() < 60_000 && !this.state.call && !this.state.termination && !this.pendingDial && !this.outgoingIntent) { await this.connect(); return; }
      const snapshot = await this.native!.snapshot();
      if (!this.current(generation)) return;
      await this.api.heartbeat(this.token.deviceSessionId, this.state.registration === "registered" ? "registered" : "registering", snapshot.pushRegistered === true);
    } catch (error) { if (this.current(generation)) this.fail(error); }
    finally { this.heartbeatBusy = false; }
  }
  private async checkCall() {
    const sessionId = this.state.termination ?? this.state.call?.sessionId;
    const leaseId = this.token?.deviceSessionId ?? this.leaseId;
    if (!leaseId || !sessionId || this.monitorBusy || this.stopped) return;
    const generation = this.generation; this.monitorBusy = true;
    try {
      const status = await this.api.status(leaseId, sessionId);
      if (!this.current(generation)) return;
      if (status.ended) {
        if (this.state.call?.sessionId === sessionId) {
          const id = this.state.call.id;
          // Server-directed loss/transfer ends only this mobile endpoint. Fence
          // its native ended callback before rejecting so it cannot hang up the
          // other endpoint's session or turn a valid lease into an auth error.
          this.rememberFinished(id);
          if (this.outgoingIntent?.sessionId === sessionId) this.outgoingIntent = null;
          this.update({ call: null, audioActive: false, muted: false, speaker: false });
          await this.native?.reject(id);
        }
        if (this.state.termination === sessionId) this.update({ termination: status.terminationPending ? sessionId : null });
      } else if (this.state.call?.sessionId === sessionId) {
        this.update({ call: { ...this.state.call, connected: status.connected } });
        if (status.connected && this.state.call?.outgoing) await this.native?.confirmConnected(this.state.call.id);
      }
      if (!status.ended && status.terminationPending) this.update({ termination: sessionId });
      this.schedule();
    } catch (error) { if (this.current(generation)) this.fail(error); }
    finally { this.monitorBusy = false; }
  }
  async dial(to: string) {
    if (!this.native || !this.token || this.state.registration !== "registered" || this.state.call || this.state.termination || this.state.dialing || this.outgoingIntent) return;
    if (this.pendingDial && this.pendingDial.to !== to) { this.update({ error: "Najprv zopakujte pôvodný pokus o volanie." }); return; }
    this.pendingDial ??= { requestId: this.uuid(), to };
    const generation = this.generation, leaseId = this.token.deviceSessionId;
    let createdSession: string | null = null;
    this.update({ dialing: true, error: null });
    try {
      const outgoing = await this.api.start(leaseId, this.pendingDial.requestId, to);
      createdSession = outgoing.sessionId;
      if (!this.current(generation)) { await this.api.end(leaseId, outgoing.sessionId).catch(() => {}); return; }
      this.outgoingIntent = outgoing;
      await this.native.expectOutgoing(outgoing.operatorLegCallControlId, outgoing.sessionId, outgoing.to);
      if (!this.current(generation)) return;
      this.pendingDial = null;
      const invites = [...this.pendingInvites.values()]; this.pendingInvites.clear();
      for (const event of invites) await this.event(event);
      this.schedule();
    } catch (error) { if (this.current(generation)) {
      if (createdSession) { this.pendingDial = null; this.outgoingIntent = null; await this.endSession(createdSession); }
      if (error instanceof MobileApiError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
        this.pendingDial = null;
        for (const id of this.pendingInvites.keys()) await this.native.reject(id);
        this.pendingInvites.clear();
      }
      this.fail(error);
    } } finally { if (this.current(generation)) this.update({ dialing: false }); }
  }
  private async event(event: VoiceEvent) {
    if (this.stopped || !this.native) return;
    const generation = this.generation;
    try {
      if (event.type === "registration") {
        if (!this.token) return;
        const registration = event.state === "registered" ? "registered" : event.state === "error" ? "error" : "unregistered";
        this.update({ registration }); this.schedule();
        if (registration === "registered") await this.touch();
      } else if (event.type === "pushTokenChanged") {
        this.refreshPushRegistration = true;
        if (this.token && !this.state.call && !this.pendingDial && !this.outgoingIntent && !this.connecting) {
          this.refreshPushRegistration = false; await this.connect();
        }
      } else if (event.type === "answerRequested") {
        if (!this.token) await this.connect();
      } else if ((event.type === "incoming" || event.type === "push") && event.callId) {
        const id = event.callId;
        if (this.finished.has(id)) { await this.native.reject(id); return; }
        if (this.authorizing.has(id)) return;
        if (this.state.call?.id === id) return;
        if (this.state.call || this.state.termination) { await this.native.reject(id); return; }
        // A real SDK INVITE has a leg UUID, but no control ID until ANSWER.
        // Hold it until the HTTP result establishes the exact outgoing intent.
        if (event.type === "incoming" && this.pendingDial) { this.pendingInvites.set(id, event); return; }
        this.authorizing.add(id);
        try {
          // A push wake may follow hours of suspension. Refresh the provider
          // token and prepare native signaling before forwarding CallKit answer.
          if (!this.token || event.type === "push") await this.connect();
          if (!this.current(generation) || this.finished.has(id)) return;
          if (!this.token || this.state.registration === "error") { await this.native.reject(id); return; }
          const identity = event.callControlId ? { callControlId: event.callControlId } : { providerLegId: event.providerLegId };
          const offer = await this.authorizeOffer(this.token.deviceSessionId, identity, id, generation);
          if (!offer || !this.current(generation) || this.finished.has(id)) return;
          const intent = this.outgoingIntent;
          if (offer.direction === "outbound" && !intent) { await this.native.reject(id); return; }
          if (intent && (offer.callControlId !== intent.operatorLegCallControlId || offer.sessionId !== intent.sessionId)) {
            await this.native.reject(id); return;
          }
          // Recheck after HTTP: another simultaneous offer may already own UI.
          const activeCall = this.snapshot().call;
          if (activeCall && activeCall.id !== id) { await this.native.reject(id); return; }
          // Reserve the single call before crossing the async bridge. Native
          // may synchronously emit ACTIVE/ended while authorize is resolving.
          this.update({ call: { id, sessionId: offer.sessionId, number: offer.number,
            state: intent ? "CONNECTING" : "RINGING", outgoing: Boolean(intent), connected: false } });
          this.schedule();
          await this.native.authorize(id, offer.sessionId, offer.callControlId);
        } finally { this.authorizing.delete(id); }
      } else if (event.type === "outgoing" && event.callId && event.sessionId) {
        if (this.finished.has(event.callId)) return;
        this.update({ call: { id: event.callId, sessionId: event.sessionId, number: event.number ?? null, state: "CONNECTING", outgoing: true, connected: false } }); this.schedule();
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
          this.update({ call: null, audioActive: false, muted: false, speaker: false });
          if (call.outgoing || call.connected) await this.endSession(call.sessionId);
          this.schedule();
        } else if (event.outgoing && event.sessionId) await this.endSession(event.sessionId);
        if ((this.refreshPushRegistration || (this.foreground && this.state.registration !== "registered")) && this.token && !this.connecting && !this.state.call && !this.outgoingIntent && !this.pendingDial) {
          this.refreshPushRegistration = false; await this.connect();
        }
      } else if (event.type === "outgoingFailed" && event.sessionId && this.token) {
        if (this.outgoingIntent?.sessionId === event.sessionId) this.outgoingIntent = null;
        await this.endSession(event.sessionId);
        this.update({ call: null, error: "Hovor sa nepodarilo spojiť. Skúste znova." }); this.schedule();
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
  private fail(error: unknown) {
    if (this.stopped) return;
    const message = error instanceof MobileApiError ? error.code === "native_voice_disabled"
      ? "Telefonovanie v tejto TEST aplikácii ešte nie je aktivované." : error.message : "Telefonovanie sa nepodarilo pripraviť.";
    this.update({ error: message });
    if (error instanceof MobileApiError && ([401, 403, 502].includes(error.status) || ["native_lease_stale", "native_voice_disabled"].includes(error.code ?? ""))) {
      const ownedSession = this.state.call && (this.state.call.outgoing || this.state.call.connected) ? this.state.call.sessionId : this.outgoingIntent?.sessionId;
      this.generation += 1;
      this.update({ termination: this.state.termination ?? ownedSession ?? null });
      this.token = null; this.pendingDial = null; this.outgoingIntent = null; this.pendingInvites.clear(); this.update({ registration: "error", call: null, dialing: false, audioActive: false, muted: false, speaker: false }); this.schedule();
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
  async dtmf(digits: string) { try { await this.native?.dtmf(digits); } catch (error) { this.fail(error); } }
  async presence(status: "available" | "paused" | "offline") {
    if (!this.token) return;
    try { await this.api.presence(this.token.deviceSessionId, status); } catch (error) { this.fail(error); throw error; }
  }
  async disconnect() {
    this.generation += 1; this.token = null; this.pendingDial = null; this.outgoingIntent = null; this.pendingInvites.clear(); this.schedule();
    await this.native?.disconnect();
    const leaseId = this.leaseId ?? await this.leases?.load();
    if (leaseId) try { await this.api.disconnect(leaseId); } catch (error) {
      // A superseded lease is already disconnected. Provider/network failures
      // retain the saved lease so the user can retry revocation before logout.
      if (!(error instanceof MobileApiError && error.status === 409)) throw error;
    }
    await this.leases?.clear(); this.leaseId = null;
    this.update({ registration: "unregistered", call: null, termination: null, dialing: false, audioActive: false, muted: false, speaker: false });
  }
  dispose() {
    this.stopped = true; this.generation += 1; this.off?.(); this.off = null;
    if (this.heartbeat) clearInterval(this.heartbeat); if (this.monitor) clearInterval(this.monitor); this.listeners.clear();
  }
}
