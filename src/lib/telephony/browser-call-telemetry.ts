/** Small, tab-local observations. All clocks are monotonic within pageId only. */
export type BrowserCallPhase = "ui_first_seen" | "sdk_invite" | "ringtone_start" | "answer_requested" | "sdk_active" | "sdk_ended";
export type BrowserCallObservation = {
  id: string;
  pageId: string;
  callControlId: string;
  phase: BrowserCallPhase;
  atMs: number;
  outcome?: "ok" | "failed" | "cancelled" | "suppressed";
  durationMs?: number;
  answerMode?: "manual" | "automatic";
};

export const BROWSER_CALL_BATCH_LIMIT = 16;
const BUFFER_LIMIT = 64;
const MEMORY_LIMIT = 256;
const PENDING_TTL_MS = 10 * 60_000;
const PHASES = new Set<BrowserCallPhase>(["ui_first_seen", "sdk_invite", "ringtone_start", "answer_requested", "sdk_active", "sdk_ended"]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CONTROL_ID = /^[a-zA-Z0-9_:+/.=-]{1,1024}$/;

/** The server reconstructs allowlisted fields; never forward an arbitrary browser object. */
export function readBrowserCallObservations(value: unknown): BrowserCallObservation[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.slice(0, BROWSER_CALL_BATCH_LIMIT).flatMap((item): BrowserCallObservation[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !UUID.test(row.id) || ids.has(row.id) ||
      typeof row.pageId !== "string" || !UUID.test(row.pageId) ||
      typeof row.callControlId !== "string" || !CONTROL_ID.test(row.callControlId) ||
      typeof row.phase !== "string" || !PHASES.has(row.phase as BrowserCallPhase) ||
      typeof row.atMs !== "number" || !Number.isFinite(row.atMs) || row.atMs < 0 || row.atMs > Number.MAX_SAFE_INTEGER) return [];
    ids.add(row.id);
    return [{ id: row.id, pageId: row.pageId, callControlId: row.callControlId, phase: row.phase as BrowserCallPhase, atMs: Math.round(row.atMs),
      ...(["ok", "failed", "cancelled", "suppressed"].includes(String(row.outcome)) ? { outcome: row.outcome as BrowserCallObservation["outcome"] } : {}),
      ...(typeof row.durationMs === "number" && Number.isFinite(row.durationMs) && row.durationMs >= 0 && row.durationMs <= 120_000 ? { durationMs: Math.round(row.durationMs) } : {}),
      ...(row.answerMode === "manual" || row.answerMode === "automatic" ? { answerMode: row.answerMode } : {}),
    }];
  });
}

export class BrowserCallTelemetry {
  private readonly pageId: string;
  private pending: BrowserCallObservation[] = [];
  private queuedAt = new Map<string, number>();
  private seen = new Set<string>();
  private visibleSessions = new Map<string, number>();
  private dropped = 0;

  constructor(private readonly now = () => performance.now(), private readonly uuid = () => crypto.randomUUID()) {
    this.pageId = uuid();
  }

  record(callControlId: string | undefined, phase: BrowserCallPhase, details: Pick<BrowserCallObservation, "outcome" | "durationMs" | "answerMode"> = {}, atMs = this.now()): void {
    if (!callControlId || !CONTROL_ID.test(callControlId)) return;
    const key = `${callControlId}:${phase}:${details.outcome ?? ""}:${details.answerMode ?? ""}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > MEMORY_LIMIT) this.seen.delete(this.seen.values().next().value!);
    const id = this.uuid();
    this.pending.push({ id, pageId: this.pageId, callControlId, phase, atMs, ...details });
    this.queuedAt.set(id, this.now());
    if (this.pending.length > BUFFER_LIMIT) { this.queuedAt.delete(this.pending.shift()!.id); this.dropped++; }
  }

  /** A session can appear before its operator leg. Retain its first UI commit time. */
  observeVisible(calls: ReadonlyArray<{ sessionId: string; browserIncomingCallControlIds?: string[] }>): void {
    for (const call of calls) {
      if (!this.visibleSessions.has(call.sessionId)) this.visibleSessions.set(call.sessionId, this.now());
      const firstSeen = this.visibleSessions.get(call.sessionId)!;
      for (const id of call.browserIncomingCallControlIds ?? []) this.record(id, "ui_first_seen", {}, firstSeen);
    }
    while (this.visibleSessions.size > MEMORY_LIMIT) this.visibleSessions.delete(this.visibleSessions.keys().next().value!);
  }

  batch(): BrowserCallObservation[] {
    const cutoff = this.now() - PENDING_TTL_MS;
    const retained = this.pending.filter(entry => {
      if ((this.queuedAt.get(entry.id) ?? 0) >= cutoff) return true;
      this.queuedAt.delete(entry.id);
      return false;
    });
    this.dropped += this.pending.length - retained.length;
    this.pending = retained;
    return this.pending.slice(0, BROWSER_CALL_BATCH_LIMIT);
  }
  droppedCount(): number { return this.dropped; }
  acknowledgeDropped(count: number): void { this.dropped = Math.max(0, this.dropped - count); }
  acknowledge(batch: BrowserCallObservation[]): void {
    const ids = new Set(batch.map((entry) => entry.id));
    this.pending = this.pending.filter((entry) => !ids.has(entry.id));
    for (const id of ids) this.queuedAt.delete(id);
  }
  defer(batch: BrowserCallObservation[]): void {
    // Uncorrelated old legs must not block newer, valid call measurements.
    const ids = new Set(batch.map(entry => entry.id));
    this.pending = [...this.pending.filter(entry => !ids.has(entry.id)), ...this.pending.filter(entry => ids.has(entry.id))];
  }
}

let telemetry: BrowserCallTelemetry | undefined;
export function browserCallTelemetry(): BrowserCallTelemetry {
  return telemetry ??= new BrowserCallTelemetry();
}

/** Beacon fallback only: scheduling an after-response log is not an acknowledgement. */
export function prepareBrowserCallHeartbeat(body: string, getQueue = browserCallTelemetry): { body: string } {
  try {
    const queue = getQueue();
    const batch = queue.batch();
    return {
      body: batch.length ? JSON.stringify({ ...JSON.parse(body), callTimings: batch }) : body,
    };
  } catch {
    return { body };
  }
}

export function browserCallMonotonicNow(): number | undefined {
  try { return performance.now(); } catch { return undefined; }
}
