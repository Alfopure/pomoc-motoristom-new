import type { StorageDriver } from "../lib/session-storage";
import type { ModuleId } from "./modules";
import { normalizePins } from "./pins";

/** Per account and organization profile on this device. Server sync follows
 * once preferences have an API; until then each phone keeps its own bar. */
export type ShellPreferencesState = {
  pins: ModuleId[]; customized: boolean; tipDismissed: boolean; loaded: boolean; saveError: boolean;
  /** The stored value could not be read (e.g. Keychain before first unlock); retry later. */
  readFailed: boolean;
};
type Stored = { version: 1; pins: string[] | null; tipDismissed: boolean };
const empty: Stored = { version: 1, pins: null, tipDismissed: false };

export function shellPreferencesKey(scope: { environment: string; userId: string; profileId: string }): string {
  const key = ["pm-shell-v1", scope.environment, scope.userId, scope.profileId].join(".");
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(key)) throw new Error("Invalid shell preferences scope");
  return key;
}
export function parseShellPreferences(raw: string | null): Stored {
  if (raw === null) return empty;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
    const data = value as Record<string, unknown>;
    if (data.version !== 1) return empty;
    const pins = data.pins === null ? null : Array.isArray(data.pins) && data.pins.every(item => typeof item === "string") ? data.pins as string[] : null;
    return { version: 1, pins, tipDismissed: data.tipDismissed === true };
  } catch { return empty; }
}

export class ShellPreferences {
  private stored: Stored = empty;
  private state: ShellPreferencesState;
  private listeners = new Set<() => void>();
  private revision = 0;
  private disposed = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly storage: StorageDriver, private readonly key: string,
    private readonly available: readonly ModuleId[], private readonly defaults: readonly ModuleId[]) {
    this.state = this.derive(false, false, false);
  }
  snapshot = () => this.state;
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };

  /** A choice made while the stored value is still loading wins over it. An
   * unreadable value stays unloaded: defaults show, but nothing implicit is saved over it. */
  async load(): Promise<void> {
    const revision = this.revision;
    let raw: string | null;
    try { raw = await this.storage.getItem(this.key); }
    catch {
      if (this.disposed) return;
      if (revision === this.revision) { this.state = { ...this.state, readFailed: true }; this.emit(); }
      else this.publish(true);
      return;
    }
    if (this.disposed) return;
    if (revision === this.revision) this.stored = parseShellPreferences(raw);
    this.publish(true);
  }
  setPins(pins: readonly ModuleId[]) { this.change({ ...this.stored, pins: [...pins] }); }
  reset() { this.change({ ...this.stored, pins: null }); }
  dismissTip() { if (!this.stored.tipDismissed) this.change({ ...this.stored, tipDismissed: true }); }
  dispose() { this.disposed = true; this.listeners.clear(); }
  /** Resolves after queued writes; used by tests and before reporting saved. */
  flush() { return this.writes; }

  private change(next: Stored) {
    if (this.disposed) return;
    this.revision++;
    this.stored = next;
    this.publish(this.state.loaded);
    const value = JSON.stringify(next);
    this.writes = this.writes.then(() => this.storage.setItem(this.key, value)).then(
      () => { if (!this.disposed && this.state.saveError) { this.state = { ...this.state, saveError: false }; this.emit(); } },
      () => { if (!this.disposed) { this.state = { ...this.state, saveError: true }; this.emit(); } });
  }
  private derive(loaded: boolean, saveError: boolean, readFailed: boolean): ShellPreferencesState {
    return { pins: normalizePins(this.stored.pins, this.available, this.defaults), customized: this.stored.pins !== null,
      tipDismissed: this.stored.tipDismissed, loaded, saveError, readFailed };
  }
  private publish(loaded: boolean) { this.state = this.derive(loaded, this.state?.saveError ?? false, loaded ? false : this.state?.readFailed ?? false); this.emit(); }
  private emit() { for (const notify of this.listeners) notify(); }
}
