export type LogoutState = { busy: boolean; message: string | null };
type Attempt = { userId: string; localRemoved: boolean };

/** Auth events outlive Workspace. Keep feedback here until a fresh login,
 * and never infer local removal from a remote endpoint's returned error. */
export class SessionLogout {
  private state: LogoutState = { busy: false, message: null };
  private userId: string | null = null;
  private attempt: Attempt | null = null;
  private disposed = false;
  private listeners = new Set<() => void>();
  constructor(private signOut: () => Promise<{ error: unknown | null }>) {}
  snapshot = () => this.state;
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
  private update(change: Partial<LogoutState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change };
    for (const notify of this.listeners) notify();
  }
  observe(event: string, userId: string | null) {
    if (this.disposed) return;
    if (event === "SIGNED_OUT" && userId === null && this.attempt?.userId === this.userId) {
      this.attempt.localRemoved = true;
    } else if (userId !== this.userId) {
      // SIGNED_IN also confirms an existing valid stored session. A fresh
      // login after local logout changes null -> user, even for the same user.
      this.attempt = null;
      this.update({ busy: false, message: null });
    }
    this.userId = userId;
  }
  async run(disconnect: () => Promise<void>) {
    if (this.disposed || this.state.busy || !this.userId) return;
    const attempt: Attempt = { userId: this.userId, localRemoved: false };
    this.attempt = attempt;
    this.update({ busy: true, message: null });
    let authStarted = false;
    const failure = () => !authStarted ? "Telefón sa nepodarilo odpojiť. Odhlásenie zopakujte."
      : attempt.localRemoved ? "Odhlásenie na tomto zariadení je dokončené. Server ho zatiaľ nepotvrdil."
        : "Odhlásenie sa nepodarilo dokončiť. Skúste znova.";
    try {
      await disconnect();
      if (this.attempt !== attempt || this.userId !== attempt.userId) return;
      authStarted = true;
      const { error } = await this.signOut();
      if (this.attempt === attempt) this.update({ message: error ? failure() : null });
    } catch {
      if (this.attempt === attempt) this.update({ message: failure() });
    } finally {
      if (this.attempt === attempt) { this.attempt = null; this.update({ busy: false }); }
    }
  }
  dispose() { this.disposed = true; this.attempt = null; this.userId = null; this.listeners.clear(); }
}
