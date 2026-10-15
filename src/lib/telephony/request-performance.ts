import { callPerformanceOperation, isCallPerformanceOperation, type CallPerformanceOperation } from "./performance-operation";

export type BrowserRequestPerformance = {
  id: string; operation: CallPerformanceOperation; ms: number;
  outcome: "ok" | "accepted" | "failed" | "timeout" | "cancelled";
  status?: number; requestId?: string;
};
export const REQUEST_PERFORMANCE_BATCH_LIMIT = 16;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const outcomes = new Set(["ok", "accepted", "failed", "timeout", "cancelled"]);

/** Browser observations are untrusted; reconstruct only bounded scalar fields. */
export function readRequestPerformance(value: unknown): BrowserRequestPerformance[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, REQUEST_PERFORMANCE_BATCH_LIMIT).flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !UUID.test(row.id) || seen.has(row.id) || !isCallPerformanceOperation(row.operation) ||
      typeof row.ms !== "number" || !Number.isFinite(row.ms) || row.ms < 0 || row.ms > 120_000 ||
      typeof row.outcome !== "string" || !outcomes.has(row.outcome)) return [];
    seen.add(row.id);
    return [{ id: row.id, operation: row.operation, ms: Math.round(row.ms * 10) / 10, outcome: row.outcome as BrowserRequestPerformance["outcome"],
      ...(typeof row.status === "number" && Number.isInteger(row.status) && row.status >= 100 && row.status <= 599 ? { status: row.status } : {}),
      ...(typeof row.requestId === "string" && UUID.test(row.requestId) ? { requestId: row.requestId } : {}) }];
  });
}

/** No storage or database; reuse the existing phone diagnostics flush. */
export class RequestPerformanceQueue {
  private pending: Array<{ at: number; row: BrowserRequestPerformance }> = [];
  private dropped = 0;
  constructor(private readonly now = () => performance.now()) {}
  record(row: BrowserRequestPerformance): void {
    const valid = readRequestPerformance([row])[0];
    if (!valid) return;
    this.pending.push({ at: this.now(), row: valid });
    if (this.pending.length > 64) { this.pending.shift(); this.dropped++; }
  }
  batch(): BrowserRequestPerformance[] {
    const cutoff = this.now() - 600_000;
    const retained = this.pending.filter(entry => entry.at >= cutoff);
    this.dropped += this.pending.length - retained.length;
    this.pending = retained;
    return retained.slice(0, REQUEST_PERFORMANCE_BATCH_LIMIT).map(entry => entry.row);
  }
  droppedCount(): number { return this.dropped; }
  acknowledge(batch: BrowserRequestPerformance[], dropped: number): void {
    const ids = new Set(batch.map(entry => entry.id));
    this.pending = this.pending.filter(entry => !ids.has(entry.row.id));
    this.dropped = Math.max(0, this.dropped - dropped);
  }
}
let queue: RequestPerformanceQueue | undefined;
export function requestPerformanceQueue(): RequestPerformanceQueue { return queue ??= new RequestPerformanceQueue(); }

/** Starts at request dispatch, after microphone/user prompts. Never includes ringing. */
export function beginRequestPerformance(input: string, method?: string): (result: Omit<BrowserRequestPerformance, "id" | "operation" | "ms">) => void {
  try {
    const operation = callPerformanceOperation(input, method ?? "GET");
    if (!operation || typeof window === "undefined") return () => {};
    const started = performance.now();
    const id = crypto.randomUUID();
    let finished = false;
    return result => {
      if (finished) return;
      finished = true;
      try { requestPerformanceQueue().record({ ...result, id, operation, ms: performance.now() - started }); }
      catch { /* Optional telemetry must preserve the call result. */ }
    };
  } catch { return () => {}; }
}
