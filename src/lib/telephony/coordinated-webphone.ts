import { TelnyxWebphone, type WebphoneSnapshot, type IncomingOfferPolicy, type TelnyxWebphoneOptions } from "./telnyx-webphone";
import { WEBPHONE_INITIAL_STATE, webphoneRegistrationView } from "./webphone-model";

const idle = (): WebphoneSnapshot => ({ status: "idle", registration: webphoneRegistrationView(WEBPHONE_INITIAL_STATE), sipUsername: null, deviceSessionId: null, call: null, message: null });
type Command = "answer" | "hangup" | "toggleMute" | "sendDtmf" | "expectOperatorLeg" | "dismissCallError" | "setIncomingOfferPolicy" | "beginOperatorRequest" | "endOperatorRequest";
type RequestIntent = { id: string; expiresAt: number; pending: boolean };
const REQUEST_INTENT_MS = 60_000;
type Message = { type: "operatorRequest"; intent: RequestIntent } | { type: "hello" } | { type: "state"; snapshot: WebphoneSnapshot } | { type: "command"; id: string; command: Command; callId: string | null; value?: unknown } | { type: "result"; id: string; error?: string };
type Pending = { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** One media owner per account/origin. Followers control that owner, never mint SIP tokens. */
export class CoordinatedWebphone {
  private local: TelnyxWebphone | null = null;
  private incomingPolicy: IncomingOfferPolicy = { automaticAllowed: true };
  private operatorRequests = new Map<string, { expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
  private ownOperatorRequests = new Set<string>();
  private snapshot = idle();
  private listeners = new Set<(state: WebphoneSnapshot) => void>();
  private channel: BroadcastChannel | null = null;
  private abort: AbortController | null = null;
  private release: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private pending = new Map<string, Pending>();
  private started = false;
  private requesting = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private resumeSessionId: string | null = null;
  private readonly beforeUnload = (event: BeforeUnloadEvent) => {
    if (!this.local?.getSnapshot().call) return;
    event.preventDefault(); event.returnValue = "";
  };
  private readonly pageHide = () => this.stop();
  private readonly pageShow = (event: PageTransitionEvent) => { if (event.persisted) this.start(); };

  constructor(private readonly options: {
    scope: string;
    mobile: boolean;
    createPhone?: (options: TelnyxWebphoneOptions) => TelnyxWebphone;
  }) {}

  getSnapshot() { return this.snapshot; }
  subscribe(listener: (state: WebphoneSnapshot) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  start() {
    if (this.started) return;
    this.started = true;
    window.addEventListener("beforeunload", this.beforeUnload);
    window.addEventListener("pagehide", this.pageHide);
    window.addEventListener("pageshow", this.pageShow);
    if (this.options.mobile) { this.publish(idle()); return; }
    if (!navigator.locks?.request || typeof BroadcastChannel === "undefined") { this.startLocal(); return; }
    const name = `pm:phone:v1:${this.options.scope}`;
    this.channel = new BroadcastChannel(name);
    this.channel.onmessage = (event: MessageEvent<Message>) => this.receive(event.data);
    this.channel.postMessage({ type: "hello" });
    this.abort = new AbortController();
    const generation = this.abort;
    void navigator.locks.request(name, { signal: generation.signal }, async () => {
      if (!this.started || generation !== this.abort) return;
      this.startLocal(true);
      const owner = this.local;
      await new Promise<void>((resolve) => { this.release = resolve; });
      if (this.local === owner) this.stopLocal();
    }).catch((error: unknown) => {
      if (generation === this.abort && !generation.signal.aborted) this.report(error);
    });
  }

  stop() {
    this.started = false;
    window.removeEventListener("beforeunload", this.beforeUnload);
    window.removeEventListener("pagehide", this.pageHide);
    // Keep pageshow for bfcache restore; dispose() removes it on real unmount.
    this.abort?.abort();
    this.abort = null;
    for (const id of this.ownOperatorRequests) this.channel?.postMessage({ type: "operatorRequest", intent: { id, pending: false, expiresAt: 0 } });
    this.ownOperatorRequests.clear();
    for (const request of this.operatorRequests.values()) clearTimeout(request.timer);
    this.operatorRequests.clear();
    this.stopLocal();
    this.release?.();
    this.release = null;
    this.channel?.close();
    this.channel = null;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("Telefón bol odpojený.")); }
    this.pending.clear();
  }

  dispose() { this.stop(); window.removeEventListener("pageshow", this.pageShow); }

  private startLocal(handoff = false, connect = true) {
    if (this.local) { if (connect) this.local.start(); return; }
    if (handoff) { try { this.resumeSessionId = localStorage.getItem(`pm:phone-session:${this.options.scope}`); } catch { /* private storage */ } }
    const phone = (this.options.createPhone ?? ((opts) => new TelnyxWebphone(opts)))({
      deviceKind: this.options.mobile ? "mobile" : "web", resumeSessionId: this.resumeSessionId, handoff,
      onSession: (id) => {
        this.resumeSessionId = id;
        if (!this.options.mobile) { try { localStorage.setItem(`pm:phone-session:${this.options.scope}`, id); } catch { /* private storage */ } }
      },
    });
    this.local = phone;
    this.applyIncomingPolicy();
    this.unsubscribe = phone.subscribe((state) => { this.publish(state); this.scheduleStandby(); });
    if (connect) phone.start();
  }

  private stopLocal() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.unsubscribe?.(); this.unsubscribe = null;
    this.local?.stop(); this.local = null;
  }

  private publish(state: WebphoneSnapshot, follower = false) {
    this.snapshot = {
      ...state, onDemand: this.options.mobile, sharedTab: follower,
      ...(this.options.mobile && state.status === "idle" ? { registration: { status: state.status, label: "Mobilná appka", detail: "Telefón sa pripojí až pri prijatí alebo spustení hovoru.", tone: "neutral" as const } } : {}),
      ...(follower && state.status === "registered" ? { registration: { ...state.registration, detail: "Telefón je spoločný pre karty tohto prehliadača. Zvuk prehráva karta, ktorá ho pripojila." } } : {}),
    };
    for (const listener of this.listeners) listener(this.snapshot);
    if (this.local && !follower) this.channel?.postMessage({ type: "state", snapshot: { ...this.snapshot, sipUsername: null, deviceSessionId: null } });
  }

  private receive(message: Message) {
    if (!message || !this.started) return;
    if (message.type === "hello" && this.local) {
      this.publish(this.local.getSnapshot());
      for (const [id, request] of this.operatorRequests) this.channel?.postMessage({ type: "operatorRequest", intent: { id, pending: true, expiresAt: request.expiresAt } });
    }
    if (message.type === "operatorRequest") this.updateOperatorRequest(message.intent);
    if (message.type === "state" && !this.local) this.publish(message.snapshot, true);
    if (message.type === "result") {
      const item = this.pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer); this.pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error)); else item.resolve();
    }
    if (message.type === "command" && this.local) {
      void this.execute(message.command, message.callId, message.value).then(() => {
        this.channel?.postMessage({ type: "result", id: message.id });
      }, (error: unknown) => {
        this.channel?.postMessage({ type: "result", id: message.id, error: error instanceof Error ? error.message : "Akcia telefónu zlyhala." });
      });
    }
  }

  private async execute(command: Command, callId: string | null, value?: unknown) {
    const phone = this.local;
    if (!phone) throw new Error("Telefón sa práve pripája v inej karte.");
    if (["answer", "hangup", "toggleMute", "sendDtmf"].includes(command) && (!callId || phone.getSnapshot().call?.id !== callId)) throw new Error("Stav hovoru sa zmenil. Obnovte ho.");
    switch (command) {
      case "answer": phone.answer(); break;
      case "hangup": await phone.hangup(); break;
      case "toggleMute": phone.toggleMute(); break;
      case "sendDtmf": if (typeof value === "string" && /^[0-9*#]$/.test(value)) phone.sendDtmf(value); break;
      case "dismissCallError": phone.dismissCallError(); break;
      case "setIncomingOfferPolicy": {
        const policy = value as IncomingOfferPolicy;
        if (typeof policy?.automaticAllowed !== "boolean") throw new Error("Neplatná prezencia.");
        if ((policy.presenceRevision ?? 0) < (this.incomingPolicy.presenceRevision ?? 0)) break;
        this.storeIncomingPolicy(policy); break;
      }
      case "beginOperatorRequest":
      case "endOperatorRequest": {
        const intent = value as RequestIntent;
        if (typeof intent?.id !== "string" || typeof intent.expiresAt !== "number") throw new Error("Neplatná požiadavka hovoru.");
        this.updateOperatorRequest(intent);
        this.channel?.postMessage({ type: "operatorRequest", intent });
        break;
      }
      case "expectOperatorLeg": {
        const leg = value as { callControlId?: unknown; sessionId?: unknown } | null;
        if (typeof leg?.callControlId !== "string" || typeof leg.sessionId !== "string") throw new Error("Neplatný hovor.");
        phone.expectOperatorLeg({ callControlId: leg.callControlId, sessionId: leg.sessionId }); break;
      }
    }
  }

  private command(command: Command, value?: unknown): Promise<void> {
    if (this.local) return this.execute(command, this.snapshot.call?.id ?? null, value);
    if (!this.channel) return Promise.reject(new Error("Telefón nie je pripojený."));
    const id = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Karta s telefónom neodpovedá. Otvorte ju a skontrolujte pripojenie.")); }, 5_000);
      this.pending.set(id, { resolve, reject, timer });
      this.channel!.postMessage({ type: "command", id, command, callId: this.snapshot.call?.id ?? null, value });
    });
  }

  private report(error: unknown) { this.publish({ ...this.snapshot, callError: error instanceof Error ? error.message : "Akcia telefónu zlyhala." }, !this.local); }
  answer() { void this.command("answer").catch((error) => this.report(error)); }
  hangup() { return this.command("hangup").catch((error) => this.report(error)); }
  toggleMute() { void this.command("toggleMute").catch((error) => this.report(error)); }
  sendDtmf(digit: string) { void this.command("sendDtmf", digit).catch((error) => this.report(error)); }
  expectOperatorLeg(leg: { callControlId: string; sessionId: string }) { void this.command("expectOperatorLeg", leg).catch((error) => this.report(error)); }
  setIncomingOfferPolicy(policy: IncomingOfferPolicy) {
    if ((policy.presenceRevision ?? 0) < (this.incomingPolicy.presenceRevision ?? 0)) return;
    this.storeIncomingPolicy(policy);
    if (!this.local && this.channel) void this.command("setIncomingOfferPolicy", policy).catch((error) => this.report(error));
  }
  private storeIncomingPolicy(policy: IncomingOfferPolicy) {
    // Presence snapshots come from every tab. A tab's local busy flag cannot
    // change another tab's request lifecycle, even at the same revision.
    this.incomingPolicy = { presenceRevision: policy.presenceRevision, automaticAllowed: policy.automaticAllowed, explicitLegs: policy.explicitLegs };
    this.applyIncomingPolicy();
  }

  private applyIncomingPolicy() {
    this.local?.setIncomingOfferPolicy({ ...this.incomingPolicy, requestPending: this.operatorRequests.size > 0 });
  }

  private updateOperatorRequest(intent: RequestIntent) {
    if (typeof intent?.id !== "string" || typeof intent.expiresAt !== "number") return;
    const previous = this.operatorRequests.get(intent.id);
    if (previous) clearTimeout(previous.timer);
    this.operatorRequests.delete(intent.id);
    if (intent.pending && intent.expiresAt > Date.now()) {
      const expiresAt = Math.min(intent.expiresAt, Date.now() + REQUEST_INTENT_MS);
      const timer = setTimeout(() => { this.operatorRequests.delete(intent.id); this.ownOperatorRequests.delete(intent.id); this.applyIncomingPolicy(); }, expiresAt - Date.now());
      this.operatorRequests.set(intent.id, { expiresAt, timer });
    }
    this.applyIncomingPolicy();
  }

  async beginOperatorRequest(): Promise<string> {
    const id = crypto.randomUUID();
    const intent: RequestIntent = { id, expiresAt: Date.now() + REQUEST_INTENT_MS, pending: true };
    this.ownOperatorRequests.add(id);
    this.updateOperatorRequest(intent);
    try {
      // Acknowledge the media owner's silent hold before sending the API call.
      await this.command("beginOperatorRequest", intent);
      return id;
    } catch (error) {
      await this.endOperatorRequest(id);
      throw error;
    }
  }

  async endOperatorRequest(id: string): Promise<void> {
    if (!this.ownOperatorRequests.delete(id)) return;
    const intent: RequestIntent = { id, expiresAt: 0, pending: false };
    this.updateOperatorRequest(intent);
    await this.command("endOperatorRequest", intent).catch(error => this.report(error));
  }

  dismissCallError() { this.publish({ ...this.snapshot, callError: null }, !this.local); void this.command("dismissCallError").catch(() => undefined); }
  takeover() { this.local?.takeover(); }
  async unlockAudio() {
    // Prepare sound during the gesture without minting a mobile SIP token.
    if (this.options.mobile && this.started && !this.local) this.startLocal(false, false);
    await this.local?.unlockAudio();
  }
  async resumeAudio() {
    if (!this.local) { this.report(new Error("Zvuk povoľte v karte, ktorá pripojila telefón. Kliknutie v tejto karte jej nemôže povoliť zvuk.")); return; }
    await this.local.resumeAudio();
  }

  async prepareForCall() {
    if (!this.started) throw new Error("Telefón bol odpojený.");
    if (!this.options.mobile) return;
    this.requesting = true;
    this.startLocal();
    const phone = this.local!;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("Mobilný telefón sa nepripojil. Skúste hovor prijať znova.")); }, 20_000);
      const check = (state: WebphoneSnapshot) => {
        if (state.status === "registered") { clearTimeout(timer); off(); resolve(); }
        else if (["failed", "superseded", "not_configured"].includes(state.status)) { clearTimeout(timer); off(); reject(new Error(state.message ?? "Mobilný telefón sa nepripojil.")); }
      };
      const off = phone.subscribe(check);
      check(phone.getSnapshot());
    });
    if (!this.started || phone !== this.local) throw new Error("Telefón bol odpojený.");
    await phone.confirmRegistration();
  }

  finishRequest() { this.requesting = false; this.scheduleStandby(); }
  private scheduleStandby() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.options.mobile || this.requesting || !this.local) return;
    const state = this.local.getSnapshot();
    if (state.call || state.pendingOperatorLegs) return;
    this.idleTimer = setTimeout(() => { this.stopLocal(); this.publish(idle()); }, 5_000);
  }
}
