import { recordDiagnostic } from "@/lib/diagnostics/client";
import { browserCallTelemetry, type BrowserCallTelemetry } from "./browser-call-telemetry";

/** A separate bounded request: registration and answering never await diagnostics. */
export class BrowserCallTransport {
  private inFlight = false;
  private nextAttempt = 0;
  private failures = 0;

  constructor(private readonly queue: BrowserCallTelemetry, private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {}

  async flush(): Promise<void> {
    if (this.inFlight || this.now() < this.nextAttempt) return;
    const batch = this.queue.batch();
    const dropped = Math.min(10_000, this.queue.droppedCount());
    if (dropped && recordDiagnostic({ type: "coverage", module: "telephony", outcome: "unknown", reason: "queue_drop", count: dropped })) this.queue.acknowledgeDropped(dropped);
    if (!batch.length) return;
    this.inFlight = true;
    this.nextAttempt = this.now() + 5_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await this.fetcher("/api/telephony/devices/observations", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observations: batch }), signal: controller.signal,
      });
      if (!response.ok) throw new Error("Observation delivery unavailable");
      const result: unknown = await response.json();
      const ids = result && typeof result === "object" && "loggedIds" in result && Array.isArray(result.loggedIds) ? new Set(result.loggedIds) : new Set();
      const accepted = batch.filter(entry => ids.has(entry.id));
      this.queue.acknowledge(accepted);
      if (!accepted.length) throw new Error("Observation correlation pending");
      this.failures = 0;
    } catch {
      this.nextAttempt = this.now() + Math.min(300_000, 5_000 * 2 ** Math.min(this.failures++, 6));
    } finally {
      this.queue.defer(batch);
      clearTimeout(timer);
      this.inFlight = false;
    }
  }
}

let transport: BrowserCallTransport | undefined;
export async function flushBrowserCallTelemetry(): Promise<void> {
  try { await (transport ??= new BrowserCallTransport(browserCallTelemetry())).flush(); }
  catch { /* Optional telemetry must not reject into the voice path. */ }
}
