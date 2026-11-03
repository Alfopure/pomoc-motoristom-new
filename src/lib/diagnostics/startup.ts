import type { DiagnosticEventInput } from "./types";

/** Tiny in-memory buffer until the first authenticated identity is known. */
export class StartupDiagnostics {
  private startedAt: number | undefined;
  private completed = false;
  private timedOut = false;
  private pending: DiagnosticEventInput[] = [];
  constructor(private readonly now = () => performance.now()) {}

  start(): void {
    if (this.startedAt !== undefined) return;
    this.startedAt = this.now();
    this.pending.push({ type: "page_lifecycle", module: "app", operation: "app.refresh", reason: "startup_started", outcome: "unknown", durationMs: 0 });
  }
  ready(): void {
    if (this.startedAt === undefined || this.completed) return;
    this.completed = true;
    this.pending.push({ type: "page_lifecycle", module: "app", operation: "app.refresh", reason: "startup_ready", outcome: "ok", durationMs: this.duration() });
  }
  timeout(): boolean {
    if (this.startedAt === undefined || this.completed || this.timedOut) return false;
    this.timedOut = true;
    this.pending.push({ type: "page_lifecycle", module: "app", operation: "app.refresh", reason: "startup_timeout", outcome: "timeout", durationMs: this.duration() });
    return true;
  }
  publish(record: (event: DiagnosticEventInput) => string | null): void {
    // The collector owns privacy/identity. A pre-login startup stays in memory
    // until it can be accepted; no anonymous endpoint or identity persistence.
    this.pending = this.pending.filter(event => !record(event));
  }
  private duration(): number { return Math.min(86_400_000, Math.max(0, this.now() - this.startedAt!)); }
}

export const startupDiagnostics = new StartupDiagnostics();
