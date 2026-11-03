import type { MobileCasePlaceSelection } from "../../../src/lib/mobile-api";

export const LOCATION_TIMEOUT_MS = 25_000;
export const LOCATION_MAX_AGE_MS = 15_000;
export type PhoneFix = { latitude: number; longitude: number; accuracy: number; timestamp: number };
export type LocationSubscription = { remove: () => void };
export type DeviceLocationAdapter = {
  permission: () => Promise<{ granted: boolean; canAskAgain: boolean }>;
  services: () => Promise<boolean>;
  watch: (receive: (value: unknown) => void, fail: () => void) => Promise<LocationSubscription>;
};
export type DeviceLocationState = { phase: "idle" | "permission" | "locating" | "ready" | "error"; fix: PhoneFix | null; message: string | null };

export function phoneFix(value: unknown, now: number): PhoneFix | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { coords?: { latitude?: unknown; longitude?: unknown; accuracy?: unknown }; timestamp?: unknown };
  const c = v.coords;
  if (!c || typeof c.latitude !== "number" || !Number.isFinite(c.latitude) || Math.abs(c.latitude) > 90
    || typeof c.longitude !== "number" || !Number.isFinite(c.longitude) || Math.abs(c.longitude) > 180
    || typeof c.accuracy !== "number" || !Number.isFinite(c.accuracy) || c.accuracy < 0 || c.accuracy > 1000
    || typeof v.timestamp !== "number" || !Number.isFinite(v.timestamp) || now - v.timestamp > LOCATION_MAX_AGE_MS || v.timestamp > now + 5000) return null;
  return { latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy, timestamp: v.timestamp };
}

export class DeviceLocation {
  private state: DeviceLocationState = { phase: "idle", fix: null, message: null };
  private listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;
  private visible = true;
  private activity = "active";
  private permissionStep: "none" | "pending" | "inactive" = "none";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private subscription: LocationSubscription | null = null;
  private waiting: { adapter: DeviceLocationAdapter; generation: number } | null = null;
  constructor(private load: () => Promise<DeviceLocationAdapter>, private now = Date.now) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(state: DeviceLocationState) { this.state = state; for (const listener of this.listeners) listener(); }
  private current(generation: number) { return !this.disposed && this.visible && generation === this.generation; }
  private stop() {
    this.generation++; this.waiting = null; this.permissionStep = "none";
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.subscription?.remove(); this.subscription = null;
  }
  cancel(message: string | null = null) {
    this.stop();
    if (!this.disposed) this.update({ phase: message ? "error" : "idle", fix: null, message });
  }
  context(visible: boolean, activity: string) {
    this.visible = visible; this.activity = activity;
    if (activity === "active" && this.permissionStep === "inactive") this.permissionStep = "none";
    if (activity === "inactive" && this.permissionStep === "pending") this.permissionStep = "inactive";
    if (!visible || activity === "background" || activity === "inactive" && this.permissionStep === "none") {
      this.cancel(); return;
    }
    if (activity === "active" && this.waiting) {
      const pending = this.waiting; this.waiting = null;
      void this.watch(pending.adapter, pending.generation);
    }
  }
  async request() {
    if (this.disposed || !this.visible || this.activity !== "active" || this.state.phase === "permission" || this.state.phase === "locating") return;
    this.stop(); const generation = this.generation;
    this.update({ phase: "permission", fix: null, message: null });
    this.timer = setTimeout(() => { if (this.current(generation)) this.cancel("Čerstvú polohu s presnosťou do 1 km sa nepodarilo získať. Skúste znova alebo vyberte miesto ručne."); }, LOCATION_TIMEOUT_MS);
    try {
      const adapter = await this.load(); if (!this.current(generation)) return;
      if (this.activity !== "active") { this.cancel(); return; }
      this.permissionStep = "pending";
      const permission = await adapter.permission(); if (!this.current(generation)) return;
      if (this.activity === "active") this.permissionStep = "none";
      if (!permission.granted) {
        this.cancel(permission.canAskAgain ? "Prístup k polohe nebol povolený. Miesto môžete vybrať ručne." : "Prístup k polohe je zablokovaný. Povoľte ho v nastaveniach telefónu alebo vyberte miesto ručne."); return;
      }
      if (!await adapter.services()) { if (this.current(generation)) this.cancel("Poloha telefónu je vypnutá. Zapnite ju v nastaveniach alebo vyberte miesto ručne."); return; }
      if (!this.current(generation)) return;
      if (this.activity !== "active") this.waiting = { adapter, generation };
      else await this.watch(adapter, generation);
    } catch {
      if (this.current(generation)) this.cancel("Poloha nie je dostupná v tejto aplikácii alebo na tomto zariadení. Miesto môžete vybrať ručne.");
    }
  }
  private async watch(adapter: DeviceLocationAdapter, generation: number) {
    if (!this.current(generation) || this.activity !== "active") return;
    this.permissionStep = "none";
    this.update({ phase: "locating", fix: null, message: null });
    try {
      const subscription = await adapter.watch(value => {
        if (!this.current(generation) || this.activity !== "active") return;
        const fix = phoneFix(value, this.now());
        if (!fix) return;
        this.stop(); this.update({ phase: "ready", fix, message: null });
      }, () => { if (this.current(generation)) this.cancel("Polohu sa nepodarilo získať. Skúste znova alebo vyberte miesto ručne."); });
      if (!this.current(generation)) subscription.remove();
      else this.subscription = subscription;
    } catch {
      if (this.current(generation)) this.cancel("Polohu sa nepodarilo získať. Skúste znova alebo vyberte miesto ručne.");
    }
  }
  selection(): MobileCasePlaceSelection | null {
    if (this.disposed || !this.visible || this.activity !== "active" || !this.state.fix) return null;
    const fix = phoneFix({ coords: this.state.fix, timestamp: this.state.fix.timestamp }, this.now());
    if (!fix) { this.cancel("Táto poloha už nie je čerstvá. Zistite polohu znova."); return null; }
    return { label: "Poloha telefónu", address: `${fix.latitude.toFixed(6)}, ${fix.longitude.toFixed(6)}`, lat: fix.latitude, lng: fix.longitude, provider: "approximate" };
  }
  dispose() { this.stop(); this.disposed = true; this.listeners.clear(); }
}
