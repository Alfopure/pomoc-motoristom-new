/** Expiry is independent of polling, visibility and network success. */
export class AuthorizationLease {
  private expiresAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private hide: () => void, private durationMs = 30_000, private now: () => number = Date.now) {}
  renew(requestStartedAt: number) {
    clearTimeout(this.timer);
    this.expiresAt = requestStartedAt + this.durationMs;
    this.timer = setTimeout(() => this.check(), Math.max(0, this.expiresAt - this.now()));
    return this.now() < this.expiresAt;
  }
  check = () => { if (this.now() >= this.expiresAt) this.hide(); };
  clear() { clearTimeout(this.timer); this.expiresAt = 0; }
}
