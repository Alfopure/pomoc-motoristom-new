import { MobileApiError } from "../lib/api";

export type ToolRequestState<T> = { data: T | null; busy: boolean; error: string | null; retryAt: number };

/** Explicit read operations only. Cancellation fences transports which resolve after abort. */
export class ToolRequest<T> {
  private state: ToolRequestState<T> = { data: null, busy: false, error: null, retryAt: 0 };
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private active = false;
  private disposed = false;
  constructor(private now: () => number = Date.now) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<ToolRequestState<T>>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  remainingSeconds() { return Math.max(0, Math.ceil((this.state.retryAt - this.now()) / 1000)); }
  setActive(active: boolean) {
    if (this.disposed) return;
    this.active = active;
    if (!active) this.invalidate();
  }
  invalidate() {
    this.controller?.abort(); this.controller = null;
    this.update({ data: null, busy: false, error: null });
  }
  async run(operation: (signal: AbortSignal) => Promise<T>): Promise<void> {
    if (this.disposed || !this.active || this.controller || this.remainingSeconds()) return;
    const controller = new AbortController(); this.controller = controller;
    this.update({ data: null, error: null, busy: true });
    const current = () => !this.disposed && this.active && this.controller === controller && !controller.signal.aborted;
    try {
      const data = await operation(controller.signal);
      if (current()) this.update({ data });
    } catch (error) {
      if (!current()) return;
      const retry = error instanceof MobileApiError
        ? (error as MobileApiError & { retryAfterSeconds?: number }).retryAfterSeconds : undefined;
      const seconds = typeof retry === "number" && Number.isFinite(retry) ? Math.min(300, Math.max(0, Math.ceil(retry))) : error instanceof MobileApiError && error.status === 429 ? 30 : 0;
      this.update({ error: error instanceof MobileApiError ? error.message : "Údaje sa nepodarilo načítať. Skúste znova.", retryAt: this.now() + seconds * 1000 });
    } finally {
      if (current()) { this.controller = null; this.update({ busy: false }); }
    }
  }
  dispose() { this.active = false; this.invalidate(); this.disposed = true; this.listeners.clear(); }
}
