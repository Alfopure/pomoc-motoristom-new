import type { MobileEnvironment } from "../../../src/lib/mobile-api";
import type { ReadingQueue, TrackingState, TrackingStore } from "./background";

export type Permission = "granted" | "denied" | "undetermined";
/** `background`: "always" keeps sending when the app is closed, "whenInUse" only
 * while the app runs (also in the background, with the blue indicator); null in
 * Expo Go and before sharing starts. */
export type SharingState = { status: "off" | "sharing" | "denied" | "error"; lastSentAt: number | null; background: "always" | "whenInUse" | null };
/** Where the pristavovač is goes to the dispatcher during the delivery they took. */
export interface LocationSharing {
  readonly mode: "foreground" | "background";
  snapshot: () => SharingState;
  subscribe: (notify: () => void) => () => void;
  /** Follow this delivery (or none). `ask` lets the system questions appear, e.g. right after Prijať. */
  follow: (deliveryId: string | null, ask?: boolean) => Promise<void>;
  /** The signed-in pristavovač, once known; sharing needs it. */
  setMember: (memberId: string | null) => void;
  /** Signed in as this pristavovač (or nobody): sharing left by another account stops. */
  reconcile: (memberId: string | null) => Promise<void>;
  /** Logout: the delivery's secret is revoked and nothing more is sent. */
  forget: () => Promise<void>;
  /** The screen went away; background sending goes on. */
  dispose: () => void;
}

export type BackgroundSource = {
  permission: () => Promise<Permission>; request: () => Promise<Permission>;
  backgroundPermission: () => Promise<Permission>; requestBackground: () => Promise<Permission>;
  running: () => Promise<boolean>; start: () => Promise<void>; stop: () => Promise<void>;
};
type Deps = {
  source: BackgroundSource; store: TrackingStore; queue: ReadingQueue;
  issue: (deliveryId: string) => Promise<{ token: string; expiresAt: string }>;
  revoke: (deliveryId: string) => Promise<unknown>;
  scope: { environment: MobileEnvironment; apiOrigin: string };
};

/** Every change of the background sharing, of any account's tracker on this phone,
 * runs one at a time: a late logout cannot undo the next account's start. */
let chain: Promise<void> = Promise.resolve();
export function serially(work: () => Promise<void>): Promise<void> {
  const next = chain.then(work, work);
  chain = next.catch(() => undefined);
  return next;
}

/** The native app: iOS keeps delivering positions to a background task, also while
 * the phone is locked, and wakes a closed app on a larger move. One step at a time. */
export class BackgroundTracker implements LocationSharing {
  readonly mode = "background" as const;
  private state: SharingState = { status: "off", lastSentAt: null, background: null };
  private listeners = new Set<() => void>();
  private disposed = false;
  private member: string | null = null;
  private generation = 0;
  constructor(private deps: Deps) {}
  snapshot = () => this.state;
  setMember(memberId: string | null) { if (memberId !== this.member) this.generation += 1; this.member = memberId; }
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
  follow(deliveryId: string | null, ask = false) {
    const generation = this.generation;
    return this.serial(async () => { if (this.current(generation)) await this.apply(deliveryId, ask, generation); });
  }
  reconcile(memberId: string | null) {
    return this.serial(async () => {
      const stored = await this.deps.store.load();
      if (stored && (stored.memberId !== memberId || !this.inScope(stored))) { await this.halt(); this.update({ status: "off", background: null }); }
    });
  }
  forget() {
    this.generation += 1;
    return this.serial(async () => {
      const stored = await this.deps.store.load();
      if (stored) await this.deps.revoke(stored.deliveryId).catch(() => undefined);
      await this.halt();
      this.update({ status: "off", background: null });
    });
  }
  dispose() { this.disposed = true; this.generation += 1; this.listeners.clear(); }

  private current(generation: number) { return !this.disposed && generation === this.generation; }
  private inScope(stored: TrackingState) {
    return stored.environment === this.deps.scope.environment && stored.apiOrigin === this.deps.scope.apiOrigin;
  }

  private serial(work: () => Promise<void>): Promise<void> {
    return serially(work).catch(() => this.update({ status: "error", background: null }));
  }
  private update(change: Partial<SharingState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change };
    for (const notify of this.listeners) notify();
  }
  private async halt() {
    const { source, store, queue } = this.deps;
    if (await source.running().catch(() => false)) await source.stop().catch(() => undefined);
    await store.clear().catch(() => undefined);
    await queue.clear().catch(() => undefined);
  }
  private async apply(deliveryId: string | null, ask: boolean, generation: number) {
    const { source, store, queue, scope } = this.deps;
    const stored = await store.load();
    if (!this.current(generation)) return;
    if (!deliveryId) {
      if (stored || await source.running().catch(() => false)) await this.halt();
      this.update({ status: "off", background: null });
      return;
    }
    const memberId = this.member;
    if (!memberId) return;
    let permission = await source.permission();
    if (!this.current(generation)) return;
    if (permission === "undetermined" && ask) permission = await source.request();
    if (!this.current(generation)) return;
    if (permission !== "granted") {
      if (stored) await this.halt();
      this.update({ status: permission === "denied" ? "denied" : "off", background: null });
      return;
    }
    let always = await source.backgroundPermission();
    if (!this.current(generation)) return;
    if (always === "undetermined" && ask) always = await source.requestBackground();
    if (!this.current(generation)) return;
    const background = always === "granted" ? "always" as const : "whenInUse" as const;
    const current = stored !== null && this.inScope(stored) && stored.deliveryId === deliveryId && stored.memberId === memberId && Date.parse(stored.expiresAt) > Date.now();
    if (current && await source.running()) { if (this.current(generation)) this.update({ status: "sharing", background }); return; }
    if (!this.current(generation)) return;
    if (!current) {
      // A new delivery/account/server must never leave the previous tracker
      // running when obtaining its replacement fails.
      await this.halt();
      if (!this.current(generation)) return;
      const tracker = await this.deps.issue(deliveryId);
      if (!this.current(generation)) return;
      await queue.clear();
      if (!this.current(generation)) return;
      await store.save({ version: 1, environment: scope.environment, apiOrigin: scope.apiOrigin, memberId, deliveryId, token: tracker.token, expiresAt: tracker.expiresAt });
    }
    if (!this.current(generation)) { await this.halt(); return; }
    await source.start();
    if (!this.current(generation)) { await this.halt(); return; }
    this.update({ status: "sharing", background });
  }
}
