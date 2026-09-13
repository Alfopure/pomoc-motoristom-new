/** A bounded gate for exact-leg verification, never a retry of a call-control command. */
export class BrowserReconciliationGate {
  private attempts = new Map<string, {
    inFlight: boolean; count: number; completed: boolean; retryAt: number; invalidated: boolean;
  }>();
  constructor(private readonly now: () => number = Date.now) {}

  begin(legId: string): boolean {
    const entry = this.attempts.get(legId);
    if (entry && (entry.inFlight || entry.completed || entry.count >= 6 || entry.retryAt > this.now())) return false;
    this.attempts.set(legId, {
      inFlight: true, count: (entry?.count ?? 0) + 1, completed: false, retryAt: 0, invalidated: false,
    });
    return true;
  }

  finish(legId: string, completed: boolean, retryAfterMs?: number): void {
    const entry = this.attempts.get(legId);
    if (!entry) return;
    if (entry.invalidated) { this.attempts.delete(legId); return; }
    entry.inFlight = false;
    entry.completed = completed;
    const requestedDelay = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? retryAfterMs : 0;
    entry.retryAt = this.now() + Math.min(15_000, Math.max(1_000 * 2 ** (entry.count - 1), requestedDelay));
  }

  exhausted(legId: string): boolean {
    const entry = this.attempts.get(legId);
    return Boolean(entry && !entry.inFlight && !entry.completed && entry.count >= 6);
  }

  /** Foreground/terminal hints cannot create concurrent verification requests. */
  invalidate(legId?: string): void {
    for (const [id, entry] of this.attempts) {
      if (legId && id !== legId) continue;
      if (entry.inFlight) entry.invalidated = true;
      else if (entry.completed || (entry.count >= 6 && entry.retryAt <= this.now())) this.attempts.delete(id);
    }
  }
}
