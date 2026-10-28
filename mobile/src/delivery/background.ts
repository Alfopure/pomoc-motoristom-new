import type { MobileDeliveryPositionInput, MobileEnvironment } from "../../../src/lib/mobile-api";

/** Position of the pristavovač in the background: the app may be in the background,
 * the phone locked, or the app closed by iOS and woken for a location event. The
 * readings go to the server with a secret of the one delivery (not the sign-in
 * session); without signal they wait on the phone and go with the next reading.
 * Moja práca follows the member's own operation the same way, under its own task,
 * Keychain entry, waiting list and route. */
export const DELIVERY_TASK = "pm-delivery-location";
export const OPERATION_TASK = "pm-operation-location";
export const DELIVERY_TRACK_PATH = "/api/mobile/v1/field/track";
export const OPERATION_TRACK_PATH = "/api/mobile/v1/field/operations/track";
export type Reading = MobileDeliveryPositionInput;
/** `deliveryId`: the followed job – the delivery, or the operation in Moja práca's own entry (the stored name stays). */
export type TrackingState = { version: 1; environment: MobileEnvironment; apiOrigin: string; memberId: string; deliveryId: string; token: string; expiresAt: string };
export type TrackingStore = { load: () => Promise<TrackingState | null>; save: (state: TrackingState) => Promise<void>; clear: () => Promise<void> };
export type ReadingQueue = { load: () => Promise<Reading[]>; save: (readings: Reading[]) => Promise<void>; clear: () => Promise<void> };
export type SendResult = "ok" | "stop" | "retry";
export type TaskDeps = {
  store: TrackingStore; queue: ReadingQueue; stopUpdates: () => Promise<void>; send: (state: TrackingState, batch: Reading[]) => Promise<SendResult>;
  /** When this phone last sent, so the open app sends no more than every 20 s either. */
  sentAt: () => number; markSent: (at: number) => void;
};

/** One reading per 20 s at most, kept up to half a day (about 2 200 of them). */
export const GAP_MS = 20_000;
const KEEP_MS = 12 * 3_600_000, FUTURE_MS = 2 * 60_000, KEEP_COUNT = 2_200, BATCH = 100, ROUNDS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A reading from the location service, or nothing if it is not a usable position. */
export function toReading(value: unknown): Reading[] {
  const location = value as { timestamp?: unknown; coords?: { latitude?: unknown; longitude?: unknown; accuracy?: unknown } } | null;
  const lat = location?.coords?.latitude, lng = location?.coords?.longitude, accuracy = location?.coords?.accuracy, time = location?.timestamp;
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180
    || typeof time !== "number" || !Number.isFinite(time) || !Number.isFinite(new Date(time).getTime())) return [];
  return [{ lat, lng, accuracy: typeof accuracy === "number" && Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 100_000 ? accuracy : null, recordedAt: new Date(time).toISOString() }];
}

/** Kept and new readings, oldest first, at least 20 s apart, at most half a day. */
export function mergeReadings(kept: readonly Reading[], incoming: readonly Reading[], now = Date.now()): Reading[] {
  const byTime = new Map<string, Reading>();
  for (const reading of [...kept, ...incoming]) {
    const time = Date.parse(reading.recordedAt);
    if (Number.isFinite(time) && time >= now - KEEP_MS && time <= now + FUTURE_MS) byTime.set(new Date(time).toISOString(), { ...reading, recordedAt: new Date(time).toISOString() });
  }
  const spaced: Reading[] = [];
  for (const reading of [...byTime.values()].sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt))) {
    const last = spaced[spaced.length - 1];
    if (!last || Date.parse(reading.recordedAt) - Date.parse(last.recordedAt) >= GAP_MS) spaced.push(reading);
  }
  return spaced.slice(-KEEP_COUNT);
}

export function parseTrackingState(raw: string | null): TrackingState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<TrackingState>;
    if (value.version !== 1 || (value.environment !== "test" && value.environment !== "production") || typeof value.apiOrigin !== "string" || !/^https:\/\/[^/]+$/.test(value.apiOrigin)
      || typeof value.memberId !== "string" || !UUID.test(value.memberId) || typeof value.deliveryId !== "string" || !UUID.test(value.deliveryId)
      || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) return null;
    return value as TrackingState;
  } catch { return null; }
}
export function parseQueue(raw: string | null): Reading[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as { version?: unknown; readings?: unknown };
    if (value.version !== 1 || !Array.isArray(value.readings)) return [];
    return value.readings.flatMap(item => {
      const reading = item as Partial<Reading>;
      return typeof reading?.lat === "number" && typeof reading.lng === "number" && typeof reading.recordedAt === "string"
        ? toReading({ timestamp: Date.parse(reading.recordedAt), coords: { latitude: reading.lat, longitude: reading.lng, accuracy: reading.accuracy } }) : [];
    });
  } catch { return []; }
}

/** One run of the background task (one at a time): what came now plus what
 * waited. It sends at most every 20 s, then the oldest hundred at a time, a few
 * hundred at most per run. The server's "stop" ends the sharing on this phone. */
export async function deliverReadings(deps: TaskDeps, incoming: readonly Reading[], now = Date.now()): Promise<"sent" | "kept" | "stopped" | "idle"> {
  const state = await deps.store.load();
  if (!state || Date.parse(state.expiresAt) <= now) { await halt(deps); return "stopped"; }
  let queue = mergeReadings(await deps.queue.load(), incoming, now);
  if (!queue.length) return "idle";
  // iOS may suspend or end the task during any network request. The new readings
  // must already be durable; only acknowledged batches leave the waiting list.
  await deps.queue.save(queue);
  if (now - deps.sentAt() < GAP_MS && queue.length <= BATCH) return "kept";
  for (let round = 0; round < ROUNDS && queue.length; round++) {
    const batch = queue.slice(0, BATCH);
    const result = await deps.send(state, batch).catch(() => "retry" as const);
    if (result === "stop") { await halt(deps); return "stopped"; }
    if (result === "retry") return "kept";
    deps.markSent(now);
    queue = queue.slice(batch.length);
    await deps.queue.save(queue);
  }
  return "sent";
}
async function halt(deps: Pick<TaskDeps, "store" | "queue" | "stopUpdates">) {
  await deps.stopUpdates().catch(() => undefined);
  await deps.store.clear().catch(() => undefined);
  await deps.queue.clear().catch(() => undefined);
}

/** Sends one batch with the job's secret. An ended delivery or operation or a refused
 * secret stops the sharing; no connection keeps the readings for the next try. */
export async function sendReadings(state: TrackingState, batch: readonly Reading[], transport: typeof fetch = fetch, path = DELIVERY_TRACK_PATH): Promise<SendResult> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await transport(state.apiOrigin + path, {
      method: "POST", credentials: "omit", signal: controller.signal, body: JSON.stringify({ positions: batch }),
      headers: { Authorization: "Tracker " + state.token, "X-PM-App-Environment": state.environment, "Content-Type": "application/json", Accept: "application/json" },
    });
    if ([401, 403, 404, 409].includes(response.status)) return "stop";
    // A batch the server cannot read is dropped, not repeated for ever.
    if (response.status === 400) return "ok";
    const body = await response.json().catch(() => null) as { ok?: unknown; environment?: unknown; active?: unknown; code?: unknown } | null;
    // Field work or its positions switched off in this environment: nothing more to send.
    if (response.status === 503 && (body?.code === "delivery_unavailable" || body?.code === "work_position_unavailable")) return "stop";
    if (!response.ok) return "retry";
    if (!body || body.ok !== true || body.environment !== state.environment || typeof body.active !== "boolean") return "retry";
    return body.active ? "ok" : "stop";
  } catch { return "retry"; } finally { clearTimeout(timer); }
}
