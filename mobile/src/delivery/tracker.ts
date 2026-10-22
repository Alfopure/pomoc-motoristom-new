import type { MobileDeliveryPositionInput } from "../../../src/lib/mobile-api";

/** The phone's location, as far as this app uses it: asked only for a delivery the
 * pristavovač accepted, and only while the app is open (Expo Go and v1). */
export type LocationSource = {
  permission: () => Promise<"granted" | "denied" | "undetermined">;
  request: () => Promise<"granted" | "denied" | "undetermined">;
  watch: (onPosition: (position: MobileDeliveryPositionInput) => void) => Promise<{ remove: () => void }>;
};
export type TrackerState = { status: "off" | "sharing" | "denied" | "error"; lastSentAt: number | null };

/** Sends where the pristavovač is to the dispatcher during one accepted delivery,
 * at most every 20 seconds; the server keeps only what arrives during the delivery
 * and says when to stop (a closed or cancelled delivery). */
export class DeliveryTracker {
  private state: TrackerState = { status: "off", lastSentAt: null };
  private listeners = new Set<() => void>();
  private watcher: { remove: () => void } | null = null;
  private target: string | null = null;
  private starting: Promise<void> | null = null;
  private sending = false;
  private disposed = false;
  constructor(private source: LocationSource, private send: (deliveryId: string, position: MobileDeliveryPositionInput) => Promise<boolean>,
    private clock: () => number = Date.now, private minInterval = 20_000) {}
  snapshot = () => this.state;
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
  private update(change: Partial<TrackerState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change };
    for (const notify of this.listeners) notify();
  }

  /** Follow this delivery (or none). `ask` lets the system question appear, e.g. right after Prijať. */
  async follow(deliveryId: string | null, ask = false) {
    if (this.disposed) return;
    if (!deliveryId) { this.stop(); return; }
    this.target = deliveryId;
    if (this.watcher || this.starting) return this.starting ?? undefined;
    this.starting = (async () => {
      try {
        let permission = await this.source.permission();
        if (permission === "undetermined" && ask) permission = await this.source.request();
        if (permission !== "granted") { this.update({ status: permission === "denied" ? "denied" : "off" }); return; }
        const watcher = await this.source.watch(position => { void this.report(position); });
        if (this.disposed || !this.target) { watcher.remove(); return; }
        this.watcher = watcher;
        this.update({ status: "sharing" });
      } catch {
        this.update({ status: "error" });
      } finally { this.starting = null; }
    })();
    return this.starting;
  }
  private async report(position: MobileDeliveryPositionInput) {
    const target = this.target, now = this.clock();
    if (!target || this.sending || this.state.lastSentAt !== null && now - this.state.lastSentAt < this.minInterval) return;
    this.sending = true;
    try {
      const active = await this.send(target, position);
      this.update({ lastSentAt: now });
      if (!active && this.target === target) this.stop();
    } catch { /* The next reading tries again; a lost one is not repeated. */ } finally { this.sending = false; }
  }
  stop() {
    this.target = null;
    this.watcher?.remove();
    this.watcher = null;
    if (this.state.status === "sharing") this.update({ status: "off" });
  }
  dispose() { this.stop(); this.disposed = true; this.listeners.clear(); }
}
