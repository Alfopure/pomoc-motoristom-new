import { describe, expect, it, vi } from "vitest";
import { OPERATION_TRACK_PATH, deliverReadings, mergeReadings, parseQueue, parseTrackingState, sendReadings, toReading, type Reading, type TaskDeps, type TrackingState } from "./background";

const NOW = Date.parse("2026-10-22T10:00:00Z");
const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();
const reading = (seconds: number, lat = 49.2): Reading => ({ lat, lng: 18.7, accuracy: 12, recordedAt: at(seconds) });
const state: TrackingState = { version: 1, environment: "test", apiOrigin: "https://test.dispecing.linkapomoci.sk", memberId: "abababab-abab-4bab-8bab-abababababab",
  deliveryId: "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d001", token: "a".repeat(43), expiresAt: "2026-10-23T10:00:00Z" };
function deps(stored: TrackingState | null = state, kept: Reading[] = [], result: "ok" | "stop" | "retry" = "ok", lastSent = 0) {
  const saved: { queue: Reading[] | null; cleared: boolean; stopped: boolean; sentAt: number } = { queue: null, cleared: false, stopped: false, sentAt: lastSent };
  const value: TaskDeps = {
    store: { load: vi.fn(async () => stored), save: vi.fn(async () => undefined), clear: vi.fn(async () => { saved.cleared = true; }) },
    queue: { load: vi.fn(async () => kept), save: vi.fn(async (readings: Reading[]) => { saved.queue = readings; }), clear: vi.fn(async () => { saved.queue = []; }) },
    stopUpdates: vi.fn(async () => { saved.stopped = true; }),
    send: vi.fn(async () => result),
    sentAt: () => saved.sentAt, markSent: at => { saved.sentAt = at; },
  };
  return { deps: value, saved };
}

describe("readings from the location service", () => {
  it("takes only usable positions", () => {
    expect(toReading({ timestamp: NOW, coords: { latitude: 49.2, longitude: 18.7, accuracy: 15 } })).toEqual([{ lat: 49.2, lng: 18.7, accuracy: 15, recordedAt: at(0) }]);
    expect(toReading({ timestamp: NOW, coords: { latitude: 49.2, longitude: 18.7, accuracy: -1 } })[0].accuracy).toBeNull();
    for (const bad of [null, {}, { timestamp: NOW, coords: { latitude: 91, longitude: 0 } }, { timestamp: "now", coords: { latitude: 1, longitude: 1 } },
      { timestamp: Number.MAX_VALUE, coords: { latitude: 1, longitude: 1 } }]) expect(toReading(bad)).toEqual([]);
  });
  it("keeps half a day, oldest first, each moment once, 20 s apart", () => {
    const merged = mergeReadings([reading(-60), reading(-43_300)], [reading(-60, 49.3), reading(-50), reading(0), reading(600)], NOW);
    expect(merged.map(item => item.recordedAt)).toEqual([at(-60), at(0)]);
    expect(merged[0].lat).toBe(49.3);
    // Every 3 s while driving becomes one per 20 s; half a day fits.
    expect(mergeReadings([], Array.from({ length: 100 }, (_, index) => reading(-index * 3)), NOW)).toHaveLength(15);
    expect(mergeReadings([], Array.from({ length: 2_400 }, (_, index) => reading(-index * 20)), NOW)).toHaveLength(2_161);
  });
  it("reads back only what it wrote", () => {
    expect(parseTrackingState(JSON.stringify(state))).toEqual(state);
    for (const bad of [{ ...state, token: "short" }, { ...state, apiOrigin: "http://x" }, { ...state, version: 2 }]) expect(parseTrackingState(JSON.stringify(bad))).toBeNull();
    expect(parseTrackingState("{")).toBeNull();
    expect(parseQueue(JSON.stringify({ version: 1, readings: [reading(0), { lat: "x" }] }))).toEqual([reading(0)]);
    expect(parseQueue("nonsense")).toEqual([]);
  });
});

describe("the background task", () => {
  it("sends what waited with the new reading, oldest first", async () => {
    const { deps: value, saved } = deps(state, [reading(-30)]);
    await expect(deliverReadings(value, [reading(0)], NOW)).resolves.toBe("sent");
    expect(value.send).toHaveBeenCalledWith(state, [reading(-30), reading(0)]);
    expect(saved.queue).toEqual([]);
    expect(saved.sentAt).toBe(NOW);
  });
  it("sends at most every 20 s also with the app open", async () => {
    const { deps: value, saved } = deps(state, [], "ok", NOW - 5_000);
    await expect(deliverReadings(value, [reading(0)], NOW)).resolves.toBe("kept");
    expect(value.send).not.toHaveBeenCalled();
    expect(saved.queue).toEqual([reading(0)]);
  });
  it("keeps the readings without signal", async () => {
    const { deps: value, saved } = deps(state, [reading(-30)], "retry");
    await expect(deliverReadings(value, [reading(0)], NOW)).resolves.toBe("kept");
    expect(saved.queue).toEqual([reading(-30), reading(0)]);
    expect(saved.stopped).toBe(false);
  });
  it("persists new readings before starting the network request", async () => {
    const { deps: value, saved } = deps(state, [reading(-30)]);
    vi.mocked(value.send).mockImplementation(async () => {
      expect(saved.queue).toEqual([reading(-30), reading(0)]);
      throw new Error("interrupted transport");
    });
    await expect(deliverReadings(value, [reading(0)], NOW)).resolves.toBe("kept");
    expect(saved.queue).toEqual([reading(-30), reading(0)]);
  });
  it("persists each acknowledged batch before sending the next one", async () => {
    const kept = Array.from({ length: 250 }, (_, index) => reading(-20 * (250 - index)));
    const { deps: value, saved } = deps(state, kept);
    vi.mocked(value.send).mockResolvedValueOnce("ok").mockImplementationOnce(async () => {
      expect(saved.queue).toEqual(kept.slice(100));
      throw new Error("background execution interrupted");
    });
    await expect(deliverReadings(value, [], NOW)).resolves.toBe("kept");
    expect(saved.queue).toEqual(kept.slice(100));
  });
  it("after a long time without signal sends a hundred at a time, a few hundred per run", async () => {
    const kept = Array.from({ length: 650 }, (_, index) => reading(-20 * (650 - index)));
    const { deps: value, saved } = deps(state, kept);
    await deliverReadings(value, [], NOW);
    expect(vi.mocked(value.send).mock.calls.map(call => call[1].length)).toEqual([100, 100, 100, 100, 100]);
    expect(saved.queue).toHaveLength(150);
  });
  it("stops for good when the delivery ended or the secret is gone", async () => {
    const ended = deps(state, [], "stop");
    await expect(deliverReadings(ended.deps, [reading(0)], NOW)).resolves.toBe("stopped");
    expect(ended.saved).toMatchObject({ stopped: true, cleared: true, queue: [] });
    const nothing = deps(null);
    await expect(deliverReadings(nothing.deps, [reading(0)], NOW)).resolves.toBe("stopped");
    expect(nothing.deps.send).not.toHaveBeenCalled();
    const expired = deps({ ...state, expiresAt: at(-1) });
    await expect(deliverReadings(expired.deps, [reading(0)], NOW)).resolves.toBe("stopped");
  });
});

describe("sending a batch", () => {
  const reply = (status: number, body: unknown = { ok: true, apiVersion: 1, environment: "test", stored: 1, active: true }) =>
    vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  it("uses the delivery's secret, not the sign-in", async () => {
    const transport = reply(200);
    await expect(sendReadings(state, [reading(0)], transport as unknown as typeof fetch)).resolves.toBe("ok");
    const [url, init] = transport.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://test.dispecing.linkapomoci.sk/api/mobile/v1/field/track");
    expect(init).toMatchObject({ method: "POST", credentials: "omit", headers: { Authorization: "Tracker " + "a".repeat(43), "X-PM-App-Environment": "test" } });
    expect(JSON.parse(String(init.body))).toEqual({ positions: [reading(0)] });
  });
  it("stops, retries or drops by the answer", async () => {
    expect(await sendReadings(state, [reading(0)], reply(200, { ok: true, environment: "test", stored: 0, active: false }) as unknown as typeof fetch)).toBe("stop");
    for (const status of [401, 403, 404, 409]) expect(await sendReadings(state, [reading(0)], reply(status, {}) as unknown as typeof fetch)).toBe("stop");
    expect(await sendReadings(state, [reading(0)], reply(400, {}) as unknown as typeof fetch)).toBe("ok");
    expect(await sendReadings(state, [reading(0)], reply(503, {}) as unknown as typeof fetch)).toBe("retry");
    // Deliveries switched off in this environment: stop, do not keep for later.
    expect(await sendReadings(state, [reading(0)], reply(503, { ok: false, code: "delivery_unavailable" }) as unknown as typeof fetch)).toBe("stop");
    expect(await sendReadings(state, [reading(0)], reply(200, { ok: true, environment: "production", active: true }) as unknown as typeof fetch)).toBe("retry");
    expect(await sendReadings(state, [reading(0)], vi.fn(async () => { throw new TypeError("offline"); }) as unknown as typeof fetch)).toBe("retry");
  });
  it("sends an operation's readings to its own route, and stops when its positions are off", async () => {
    const transport = reply(200);
    await expect(sendReadings(state, [reading(0)], transport as unknown as typeof fetch, OPERATION_TRACK_PATH)).resolves.toBe("ok");
    expect(transport.mock.calls[0][0]).toBe("https://test.dispecing.linkapomoci.sk/api/mobile/v1/field/operations/track");
    expect(await sendReadings(state, [reading(0)], reply(503, { ok: false, code: "work_position_unavailable" }) as unknown as typeof fetch, OPERATION_TRACK_PATH)).toBe("stop");
  });
});
