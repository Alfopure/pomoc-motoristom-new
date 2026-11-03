import type { MobileDraftScope } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";

export class DraftScopeSuperseded extends Error {}
export const lostDraftAuthority = (error: unknown) => error instanceof MobileApiError && [401, 403, 404, 409, 502].includes(error.status);
type State = { scope: MobileDraftScope | null; error: unknown };

/** Background reads and mutation preflights share one ordering authority.
 * An older success can never undo a newer organization change or denial. */
export class DraftAuthority {
  private epoch = 0;
  private state: State = { scope: null, error: null };
  private listeners = new Set<() => void>();
  private disposed = false;
  constructor(private fetchScope: (signal?: AbortSignal) => Promise<MobileDraftScope>, private liveUser: () => string | null, private userId: string) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  current = (organizationId: string) => !this.disposed && this.liveUser() === this.userId && this.state.scope?.organizationId === organizationId;
  async read(signal?: AbortSignal) {
    const epoch = ++this.epoch;
    try {
      if (this.disposed || this.liveUser() !== this.userId) throw new MobileApiError("Prihlásenie sa zmenilo.", 401);
      const scope = await this.fetchScope(signal);
      if (this.disposed || epoch !== this.epoch) throw new DraftScopeSuperseded();
      if (this.liveUser() !== this.userId) throw new MobileApiError("Prihlásenie sa zmenilo.", 401);
      this.state = { scope, error: null }; this.notify(); return scope;
    } catch (error) {
      if (this.disposed || epoch !== this.epoch || error instanceof DraftScopeSuperseded) throw new DraftScopeSuperseded();
      this.state = { scope: lostDraftAuthority(error) ? null : this.state.scope, error }; this.notify(); throw error;
    }
  }
  private notify() { for (const listener of this.listeners) listener(); }
  dispose() { this.disposed = true; this.epoch++; this.state = { scope: null, error: null }; this.listeners.clear(); }
}
