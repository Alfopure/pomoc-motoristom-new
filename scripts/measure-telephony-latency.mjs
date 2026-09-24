import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Offline exports only: this tool never connects to a database or provider. */
export function readRows(path) {
  const source = readFileSync(path, "utf8").trim();
  if (!source) return [];
  const rows = source.startsWith("[") ? JSON.parse(source) : source.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (!Array.isArray(rows)) throw new Error("Expected a JSON array or NDJSON");
  return rows.flatMap(row => {
    if (row && typeof row.message === "string") {
      try { return [JSON.parse(row.message)]; } catch { return []; }
    }
    return [row];
  });
}

const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const delta = (start, end) => {
  const a = timestamp(start), b = timestamp(end);
  return a !== null && b !== null && b >= a ? b - a : null;
};
function distribution(values) {
  const sorted = values.filter(value => typeof value === "number" && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const percentile = p => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return { n: sorted.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95), max_ms: sorted.at(-1) ?? null };
}

export function measureLatency(events, logs = []) {
  const groups = new Map();
  for (const event of events) {
    const timing = event.normalized_payload?.timing;
    if (!timing) continue;
    const key = event.event_type ?? "unknown";
    const group = groups.get(key) ?? [];
    group.push(timing);
    groups.set(key, group);
  }
  const byEvent = Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([type, rows]) => [type, {
    rows: rows.length,
    ingress_to_claim: distribution(rows.filter(row => row.source !== "ledger_replay").map(row => delta(row.ingress_at, row.claimed_at))),
    claim_to_lease: distribution(rows.map(row => delta(row.claimed_at, row.lease_acquired_at))),
    lease_to_dispatch: distribution(rows.map(row => delta(row.lease_acquired_at, row.first_command_at))),
    processing: distribution(rows.map(row => row.processing_ms)),
    guard: distribution(rows.map(row => row.guard_ms)),
    guard_and_stage: distribution(rows.map(row => row.guard_stage_ms)),
  }]));
  const spans = logs.filter(row => row.scope === "lease-timing" && row.outcome === "finished" && row.release_confirmed === true);
  const blockers = logs.filter(row => row.scope === "webhook" && row.deferral === "lease_busy").map(waiter => {
    const end = timestamp(waiter.finished_at);
    const start = end !== null && typeof waiter.lease_wait_ms === "number" ? end - waiter.lease_wait_ms : null;
    const holders = start === null ? [] : spans.flatMap(holder => {
      if (holder.sessionId !== waiter.sessionId) return [];
      const a = timestamp(holder.lease_acquired_at), b = timestamp(holder.finished_at);
      if (a === null || b === null) return [];
      const overlap = Math.min(b, end) - Math.max(a, start);
      return overlap > 0 ? [{ request_id: holder.request_id ?? null, event_type: holder.eventType,
        generation: holder.generation, overlap_ms: overlap, held_ms: holder.held_ms }] : [];
    });
    return { event_id: waiter.eventId, session_id: waiter.sessionId, lease_wait_ms: waiter.lease_wait_ms ?? null,
      polls: waiter.polls ?? null, holders, attribution: holders.length ? "observed_overlap" : "unknown" };
  });
  return { by_event: byEvent, lease_deferrals: blockers,
    notes: ["Missing timestamps are excluded, never treated as zero.",
      "p95 uses nearest rank; use at least 20 samples per scenario for a p95 claim.",
      "Holder matches require retained logs from all instances. A missing holder remains unknown.",
      "Application timestamps measure server work, not audible ringing or browser audio."] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [eventsPath, logsPath] = process.argv.slice(2);
  if (!eventsPath) {
    console.error("Usage: node scripts/measure-telephony-latency.mjs <call-events.json> [runtime-logs.ndjson]");
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(measureLatency(readRows(eventsPath), logsPath ? readRows(logsPath) : []), null, 2)); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  }
}
