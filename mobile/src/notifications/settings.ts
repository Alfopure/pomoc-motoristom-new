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
};
export type PushStatus = "off" | "working" | "on" | "denied" | "unavailable" | "unsupported" | "error";
export type PushView = { status: PushStatus; preferences: MobilePushPreferences | null; message: string | null; saving: MobilePushType | null };

export const PUSH_DENIED = "Notifikácie sú pre aplikáciu vypnuté v nastaveniach telefónu.";
export const PUSH_UNAVAILABLE = "Notifikácie ešte nie sú v tomto prostredí zapnuté. Skúste to neskôr.";
const FAILED = "Telefón sa nepodarilo prihlásiť na notifikácie. Skontrolujte pripojenie a skúste znova.";
/** Registration is refreshed at most this often while the app keeps coming back. */
const REFRESH_MS = 6 * 3_600_000;

/** Notifications of the signed-in operator on this phone. Nothing is asked or sent
 * before the operator switches them on; after that every start refreshes the
 * registration quietly, and logout removes it while keeping the choice. */
export class PushSettings {
  private view: PushView = { status: "off", preferences: null, message: null, saving: null };
  private listeners = new Set<() => void>();
  private token: string | null = null;
  private syncedAt = 0;
  private running = false;
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
  private async exclusive(work: () => Promise<void>) {
    if (this.running || this.disposed || this.view.status === "unsupported") return;
    this.running = true;
    try { await work(); } finally { this.running = false; }
  }

  /** At start and on return to the app: quiet, never shows the system question. */
  resume() {
    return this.exclusive(async () => {
      if (!this.device.remembered()) return;
      if (this.view.status === "on" && this.clock() - this.syncedAt < REFRESH_MS) return;
      if (await this.device.permission() !== "granted") { this.update({ status: "denied", preferences: null, message: PUSH_DENIED }); return; }
      await this.connect(this.view.status === "on");
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
    if (this.view.status !== "on" || !before || this.view.saving) return Promise.resolve();
    return this.exclusive(async () => {
      this.update({ preferences: { ...before, [type]: on }, saving: type, message: null });
      try {
        const preferences = await this.api.register(this.registration({ [type]: on }));
        this.syncedAt = this.clock();
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
        await this.api.unregister(this.device.installationId());
        this.device.remember(false);
        this.syncedAt = 0;
        this.update({ status: "off", preferences: null, message: null });
      } catch {
        this.update({ ...previous, message: "Notifikácie sa nepodarilo vypnúť. Skúste to znova." });
      }
    });
  }
  /** Logout: this phone stops receiving the account's notices; never blocks logout. */
  async forget() {
    if (this.view.status === "unsupported" || !this.device.remembered()) return;
    this.syncedAt = 0;
    try { await this.api.unregister(this.device.installationId()); } catch { /* The server also skips a phone unused for a month. */ }
  }
  dispose() { this.disposed = true; this.listeners.clear(); }

  private registration(preferences?: Partial<MobilePushPreferences>) {
    return { installationId: this.device.installationId(), token: this.token!, platform: this.device.platform, appVersion: this.device.appVersion,
      ...(preferences ? { preferences } : {}) };
  }
  private async connect(quiet: boolean) {
    try {
      this.token = await this.device.token();
      const preferences = await this.api.register(this.registration());
      this.device.remember(true);
      this.syncedAt = this.clock();
      this.update({ status: "on", preferences, message: null });
    } catch (error) {
      if (error instanceof MobileApiError && error.code === "push_unavailable") this.update({ status: "unavailable", preferences: null, message: PUSH_UNAVAILABLE });
      // A quiet refresh of a working phone keeps it on; the server still has it.
      else if (quiet) this.update({ message: null });
      else this.update({ status: "error", preferences: null, message: error instanceof MobileApiError && error.status === 401 ? error.message : FAILED });
    }
  }
}
