import { MobileApiError } from "../lib/api";
import type { VoiceApi, VoiceToken } from "./api";

export type VoiceEvent = { type: string; callId?: string; callControlId?: string; providerLegId?: string; sessionId?: string; number?: string; state?: string; active?: boolean; muted?: boolean; outgoing?: boolean };
export type PhoneSnapshot = { ready: boolean; audioActive: boolean; pushRegistered?: boolean; wasEnabled?: boolean; calls?: VoiceEvent[]; pending: VoiceEvent[] };
export type NativePhone = {
  snapshot(): Promise<PhoneSnapshot>; requestMicrophone(): Promise<boolean>; connect(token: string): Promise<void>; disconnect(): Promise<void>;
  authorize(callId: string, sessionId: string): Promise<void>; reject(callId: string): Promise<void>;
  expectOutgoing(controlId: string, sessionId: string, number: string): Promise<void>;
  answer(callId: string): Promise<void>; end(): Promise<void>; mute(muted: boolean): Promise<void>; speaker(enabled: boolean): Promise<void>; dtmf(digits: string): Promise<void>;
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
    const snapshot = await this.native.snapshot();
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
      } finally { this.connecting = null; }
    })();
    return this.connecting;
  }
  setForeground(value: boolean) { this.foreground = value; this.schedule(); if (value && this.token) void this.touch(); }
  private schedule() {
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null;
    if (this.monitor) clearInterval(this.monitor); this.monitor = null;
    if (this.stopped || !this.token) return;
    // No JS/background keepalive: suspended iOS is reached through APNs.
    if (this.foreground && this.state.registration === "registered") this.heartbeat = setInterval(() => { void this.touch(); }, 30_000);
    if ((this.foreground || this.state.audioActive) && (this.state.call || this.state.termination)) this.monitor = setInterval(() => { void this.checkCall(); }, 2_000);
  }
  private async touch() {
    if (!this.token || this.heartbeatBusy || this.stopped) return;
    const generation = this.generation; this.heartbeatBusy = true;
    try {
      if (Date.parse(this.token.expiresAt) - Date.now() < 60_000 && !this.state.call && !this.state.termination) { await this.connect(); return; }
      const snapshot = await this.native!.snapshot();
      if (!this.current(generation)) return;
      await this.api.heartbeat(this.token.deviceSessionId, this.state.registration === "registered" ? "registered" : "registering", snapshot.pushRegistered === true);
    } catch (error) { if (this.current(generation)) this.fail(error); }
    finally { this.heartbeatBusy = false; }
  }
  private async checkCall() {
    const sessionId = this.state.termination ?? this.state.call?.sessionId;
    if (!this.token || !sessionId || this.monitorBusy || this.stopped) return;
    const generation = this.generation; this.monitorBusy = true;
    try {
      const status = await this.api.status(this.token.deviceSessionId, sessionId);
      if (!this.current(generation)) return;
      if (status.ended) {
        if (this.state.call?.sessionId === sessionId) { await this.native?.reject(this.state.call.id); this.update({ call: null }); }
        if (this.state.termination === sessionId) this.update({ termination: null });
      } else if (this.state.call?.sessionId === sessionId) this.update({ call: { ...this.state.call, connected: status.connected } });
      if (status.terminationPending) this.update({ termination: sessionId });
      this.schedule();
    } catch (error) { if (this.current(generation)) this.fail(error); }
    finally { this.monitorBusy = false; }
  }
  async dial(to: string) {
    if (!this.native || !this.token || this.state.registration !== "registered" || this.state.call || this.state.termination || this.state.dialing) return;
    if (this.pendingDial && this.pendingDial.to !== to) { this.update({ error: "Najprv zopakujte pôvodný pokus o volanie." }); return; }
    this.pendingDial ??= { requestId: this.uuid(), to };
    const generation = this.generation, leaseId = this.token.deviceSessionId;
    let createdSession: string | null = null;
    this.update({ dialing: true, error: null });
    try {
      const outgoing = await this.api.start(leaseId, this.pendingDial.requestId, to);
      createdSession = outgoing.sessionId;
      if (!this.current(generation)) { await this.api.end(leaseId, outgoing.sessionId).catch(() => {}); return; }
      await this.native.expectOutgoing(outgoing.operatorLegCallControlId, outgoing.sessionId, outgoing.to);
      if (!this.current(generation)) return;
      this.pendingDial = null;
      for (const [id, event] of this.pendingInvites) {
        if (event.callControlId === outgoing.operatorLegCallControlId && !this.finished.has(id)) {
          await this.native.authorize(id, outgoing.sessionId);
          if (this.current(generation)) this.update({ call: { id, sessionId: outgoing.sessionId, number: outgoing.to, state: "CONNECTING", outgoing: true, connected: false } });
        } else await this.native.reject(id);
      }
      this.pendingInvites.clear(); this.schedule();
    } catch (error) { if (this.current(generation)) {
      if (createdSession) { this.pendingDial = null; await this.endSession(createdSession); }
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
        const registration = event.state === "registered" ? "registered" : event.state === "error" ? "error" : "unregistered";
        this.update({ registration }); this.schedule();
        if (registration === "registered") await this.touch();
      } else if (event.type === "pushTokenChanged") {
        if (this.token && !this.state.call && !this.connecting) await this.connect();
      } else if (event.type === "answerRequested") {
        if (!this.token) await this.connect();
      } else if ((event.type === "incoming" || event.type === "push") && event.callId) {
        const id = event.callId;
        if (this.finished.has(id)) { await this.native.reject(id); return; }
        if (this.authorizing.has(id)) return;
        if (this.state.call?.id === id) return;
        if (this.state.call || this.state.termination) { await this.native.reject(id); return; }
        if (!this.token) { await this.connect(); if (!this.current(generation)) return; if (!this.token) { await this.native.reject(id); return; } }
        // Buffer an invite until HTTP returns the exact operator leg. No
        // number-, elapsed-time- or arbitrary-invite-based auto-answer.
        if (event.type === "incoming" && this.pendingDial) { this.pendingInvites.set(id, event); return; }
        this.authorizing.add(id);
        try {
          const identity = event.callControlId ? { callControlId: event.callControlId } : { providerLegId: event.providerLegId };
          const offer = await this.api.authorize(this.token!.deviceSessionId, identity);
          if (!this.current(generation) || this.finished.has(id)) return;
          await this.native.authorize(id, offer.sessionId);
          if (!this.current(generation) || this.finished.has(id)) return;
          this.update({ call: { id, sessionId: offer.sessionId, number: offer.number, state: "RINGING", outgoing: false, connected: false } });
          this.schedule();
        } finally { this.authorizing.delete(id); }
      } else if (event.type === "outgoing" && event.callId && event.sessionId) {
        this.update({ call: { id: event.callId, sessionId: event.sessionId, number: event.number ?? null, state: "CONNECTING", outgoing: true, connected: false } }); this.schedule();
      } else if (event.type === "callState" && event.callId && this.state.call?.id === event.callId) {
        this.update({ call: { ...this.state.call, state: event.state ?? "CONNECTING" } });
        if (event.state === "ACTIVE") await this.checkCall();
      } else if (event.type === "ended") {
        if (event.callId) { this.pendingInvites.delete(event.callId); this.finished.add(event.callId); if (this.finished.size > 50) this.finished.delete(this.finished.values().next().value!); }
        if (this.state.call?.id === event.callId) {
          const call = this.state.call;
          this.update({ call: null, audioActive: false, muted: false, speaker: false });
          if (call && (call.outgoing || call.connected)) await this.endSession(call.sessionId);
          this.schedule();
        }
      } else if (event.type === "outgoingFailed" && event.sessionId && this.token) {
        await this.endSession(event.sessionId);
        this.update({ call: null, error: "Hovor sa nepodarilo spojiť. Skúste znova." }); this.schedule();
      } else if (event.type === "audio") { this.update({ audioActive: event.active === true }); this.schedule(); }
      else if (event.type === "muted") this.update({ muted: event.muted === true });
    } catch (error) {
      if (!this.current(generation)) return;
      if (event.callId) await this.native.reject(event.callId).catch(() => {});
      this.fail(error);
    }
  }
  private fail(error: unknown) {
    if (this.stopped) return;
    const message = error instanceof MobileApiError ? error.code === "native_voice_disabled"
      ? "Telefonovanie v tejto TEST aplikácii ešte nie je aktivované." : error.message : "Telefonovanie sa nepodarilo pripraviť.";
    this.update({ error: message });
    if (error instanceof MobileApiError && ([401, 403, 502].includes(error.status) || error.code === "native_lease_stale")) {
      this.token = null; this.update({ registration: "error", call: null }); this.schedule();
      void this.native?.disconnect().catch(() => {});
    }
  }
  private endSession(sessionId: string): Promise<void> {
    const existing = this.ending.get(sessionId); if (existing) return existing;
    if (!this.token) return Promise.resolve();
    const generation = this.generation, leaseId = this.token.deviceSessionId;
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
    this.generation += 1; this.token = null; this.pendingDial = null; this.pendingInvites.clear(); this.schedule();
    await this.native?.disconnect();
    const leaseId = this.leaseId ?? await this.leases?.load();
    if (leaseId) try { await this.api.disconnect(leaseId); } catch (error) {
      // A superseded lease is already disconnected. Provider/network failures
      // retain the saved lease so the user can retry revocation before logout.
      if (!(error instanceof MobileApiError && error.status === 409)) throw error;
    }
    await this.leases?.clear(); this.leaseId = null;
    this.update({ registration: "unregistered", call: null, termination: null, audioActive: false });
  }
  dispose() {
    this.stopped = true; this.generation += 1; this.off?.(); this.off = null;
    if (this.heartbeat) clearInterval(this.heartbeat); if (this.monitor) clearInterval(this.monitor); this.listeners.clear();
  }
}
