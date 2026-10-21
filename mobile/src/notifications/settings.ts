import type { MobilePushPreferences, MobilePushType } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import type { PushApi } from "./api";

export type PushPermission = "granted" | "denied" | "undetermined";
/** What this phone can do; the real one wraps expo-notifications and the keychain. */
export type PushDevice = {
  platform: "ios" | "android";
  appVersion: string | null;
  /** Why notifications cannot work here at all, e.g. the browser preview. */
  unsupported: () => string | null;
  permission: () => Promise<PushPermission>;
  request: () => Promise<PushPermission>;
  token: () => Promise<string>;
  installationId: () => string;
  /** The operator switched notifications on for this account on this phone. */
  remembered: () => boolean;
  remember: (on: boolean) => void;
  /** The switches this account chose on this phone; they outlive a logout. */
  savedPreferences: () => Partial<MobilePushPreferences> | null;
  savePreferences: (value: MobilePushPreferences) => void;
  /** The server may still deliver to this phone for some account. */
  registered: () => boolean;
  markRegistered: (on: boolean) => void;
};
export type PushStatus = "off" | "working" | "on" | "denied" | "unavailable" | "unsupported" | "error";
export type PushView = {
  status: PushStatus; preferences: MobilePushPreferences | null; message: string | null;
  /** The switch being saved. */
  saving: MobilePushType | null;
  /** Any operation is running; the controls wait for it. */
  busy: boolean;
};

export const PUSH_DENIED = "Notifikácie sú pre aplikáciu vypnuté v nastaveniach telefónu.";
export const PUSH_UNAVAILABLE = "Notifikácie ešte nie sú v tomto prostredí zapnuté. Skúste to neskôr.";
export const PUSH_FAILED = "Telefón sa nepodarilo prihlásiť na odber notifikácií. Skontrolujte pripojenie a skúste znova.";
/** Registration is refreshed at most this often while the app keeps coming back. */
const REFRESH_MS = 6 * 3_600_000;
/** iOS answers the token request itself; offline it may never answer. */
const TOKEN_MS = 15_000;

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out")), ms); })])
    .finally(() => clearTimeout(timer));
}

/** Notifications of the signed-in operator on this phone. Nothing is asked or sent
 * before the operator switches them on; after that every start refreshes the
 * registration quietly, and logout removes it while keeping the choice. */
export class PushSettings {
  private view: PushView = { status: "off", preferences: null, message: null, saving: null, busy: false };
  private listeners = new Set<() => void>();
  private token: string | null = null;
  private syncedAt = 0;
  private running: Promise<void> | null = null;
  private forgotten = false;
  private disposed = false;
  constructor(private device: PushDevice, private api: PushApi, private clock: () => number = Date.now) {
    const reason = device.unsupported();
    if (reason) this.view = { ...this.view, status: "unsupported", message: reason };
  }
  snapshot = () => this.view;
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
  private update(change: Partial<PushView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...change };
    for (const notify of this.listeners) notify();
  }
  /** One operation at a time; after logout none starts. */
  private exclusive(work: () => Promise<void>): Promise<void> {
    if (this.running || this.forgotten || this.disposed || this.view.status === "unsupported") return Promise.resolve();
    this.update({ busy: true });
    const run = (async () => {
      try { await work(); } catch { /* Every step reports its own outcome. */ } finally {
        this.running = null;
        this.update({ busy: false });
      }
    })();
    this.running = run;
    return run;
  }

  /** At start and on return to the app: quiet, never shows the system question. */
  resume() {
    return this.exclusive(async () => {
      if (!this.device.remembered()) {
        // A registration left behind, e.g. by a logout that never reached the server.
        if (this.device.registered()) await this.unregister().catch(() => undefined);
        return;
      }
      const wasOn = this.view.status === "on";
      if (wasOn && this.clock() - this.syncedAt < REFRESH_MS) return;
      const permission = await this.device.permission().catch(() => "undetermined" as const);
      // Reinstalled, or the system forgot the answer: notifications are simply off again.
      if (permission === "undetermined") { this.device.remember(false); this.update({ status: "off", preferences: null, message: null }); return; }
      if (permission !== "granted") { this.update({ status: "denied", preferences: null, message: PUSH_DENIED }); return; }
      if (!wasOn) this.update({ status: "working", message: null });
      await this.connect(wasOn);
    });
  }
  /** "Zapnúť notifikácie": the system asks once; a refusal is changed only in Settings. */
  enable() {
    return this.exclusive(async () => {
      this.update({ status: "working", message: null });
      let permission = await this.device.permission().catch(() => "denied" as const);
      if (permission === "undetermined") permission = await this.device.request().catch(() => "denied" as const);
      if (permission !== "granted") { this.update({ status: "denied", preferences: null, message: PUSH_DENIED }); return; }
      await this.connect(false);
    });
  }
  /** One switch; the server answers with all of them. */
  set(type: MobilePushType, on: boolean) {
    const before = this.view.preferences;
    if (this.view.status !== "on" || !before) return Promise.resolve();
    return this.exclusive(async () => {
      this.update({ preferences: { ...before, [type]: on }, saving: type, message: null });
      try {
        const preferences = await this.api.register(this.registration({ [type]: on }));
        this.saved(preferences);
        this.update({ preferences, saving: null });
      } catch (error) {
        this.update({ preferences: before, saving: null, message: error instanceof MobileApiError && error.code === "push_unavailable" ? PUSH_UNAVAILABLE
          : "Nastavenie sa nepodarilo uložiť. Skúste to znova." });
      }
    });
  }
  /** "Vypnúť na tomto telefóne". */
  disable() {
    return this.exclusive(async () => {
      const previous = this.view;
      this.update({ status: "working", message: null });
      try {
        await this.unregister();
        this.device.remember(false);
        this.syncedAt = 0;
        this.update({ status: "off", preferences: null, message: null });
      } catch {
        this.update({ status: previous.status, preferences: previous.preferences, message: "Notifikácie sa nepodarilo vypnúť. Skúste to znova." });
      }
    });
  }
  /** Logout: this phone stops receiving the account's notices; never blocks logout.
   * A registration still on its way finishes first, so it cannot come back after. */
  async forget() {
    this.forgotten = true;
    await this.running;
    if (this.view.status === "unsupported" || !this.device.registered()) return;
    // A failure leaves the phone marked, and the next start on it removes the registration.
    await this.unregister().catch(() => undefined);
  }
  dispose() { this.disposed = true; this.listeners.clear(); }

  private async unregister() {
    await this.api.unregister(this.device.installationId());
    this.device.markRegistered(false);
  }
  private saved(preferences: MobilePushPreferences) {
    this.syncedAt = this.clock();
    this.device.savePreferences(preferences);
  }
  private registration(preferences?: Partial<MobilePushPreferences> | null) {
    return { installationId: this.device.installationId(), token: this.token!, platform: this.device.platform, appVersion: this.device.appVersion,
      ...(preferences ? { preferences } : {}) };
  }
  private async connect(quiet: boolean) {
    try {
      this.token = await within(this.device.token(), TOKEN_MS);
      // Marked before sending: an answer lost on the way may still leave the server registered.
      this.device.markRegistered(true);
      // The phone keeps this account's switches, so a new login starts where it ended.
      const preferences = await this.api.register(this.registration(this.device.savedPreferences()));
      this.device.remember(true);
      this.saved(preferences);
      this.update({ status: "on", preferences, message: null });
    } catch (error) {
      if (error instanceof MobileApiError && error.code === "push_unavailable") this.update({ status: "unavailable", preferences: null, message: PUSH_UNAVAILABLE });
      // A quiet refresh of a working phone keeps it on; the server still has it.
      else if (quiet) this.update({ message: null });
      else this.update({ status: "error", preferences: null, message: error instanceof MobileApiError && error.status === 401 ? error.message : PUSH_FAILED });
    }
  }
}
