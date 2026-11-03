import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceLocation, LOCATION_TIMEOUT_MS, phoneFix, type DeviceLocationAdapter, type LocationSubscription } from "./device-location";
const now = 2_000_000;
const value = { coords: { latitude: 48.1, longitude: 17.1, accuracy: 24 }, timestamp: now };
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
function setup() {
  let receive!: (value: unknown) => void;
  const remove = vi.fn();
  const adapter: DeviceLocationAdapter = { permission: vi.fn(async () => ({ granted: true, canAskAgain: true })), services: vi.fn(async () => true), watch: vi.fn(async callback => { receive = callback; return { remove }; }) };
  const load = vi.fn(async () => adapter), clock = vi.fn(() => now), controller = new DeviceLocation(load, clock);
  return { adapter, load, clock, controller, remove, receive: (v: unknown = value) => receive(v) };
}
afterEach(() => vi.useRealTimers());
describe("explicit bounded phone position", () => {
  it("does no permission or device IO until explicit request, keeps numeric approximate seed and removes first-fix watch", async () => {
    const f = setup(); expect(f.load).not.toHaveBeenCalled(); await f.controller.request(); f.receive();
    expect(f.remove).toHaveBeenCalledTimes(1); expect(f.controller.snapshot().fix?.accuracy).toBe(24);
    expect(f.controller.selection()).toEqual({ label: "Poloha telefónu", address: "48.100000, 17.100000", lat: 48.1, lng: 17.1, provider: "approximate" }); f.controller.dispose();
  });
  it("accepts real zero coordinates/accuracy without inventing missing values", () => {
    expect(phoneFix({ coords: { latitude: 0, longitude: 0, accuracy: 0 }, timestamp: now }, now)).not.toBeNull();
    for (const patch of [{ latitude: "48" }, { latitude: NaN }, { latitude: 91 }, { longitude: 181 }, { accuracy: null }, { accuracy: -1 }, { accuracy: 1001 }]) expect(phoneFix({ ...value, coords: { ...value.coords, ...patch } }, now)).toBeNull();
    for (const timestamp of [undefined, "2000000", now - 15001, now + 5001]) expect(phoneFix({ ...value, timestamp }, now)).toBeNull();
  });
  it("waits through stale/inaccurate updates then times out without a cached selection", async () => {
    vi.useFakeTimers(); const f = setup(); await f.controller.request(); f.receive({ ...value, timestamp: now - 16000 });
    expect(f.controller.snapshot().phase).toBe("locating"); await vi.advanceTimersByTimeAsync(LOCATION_TIMEOUT_MS);
    expect(f.controller.snapshot().phase).toBe("error"); expect(f.remove).toHaveBeenCalledOnce(); expect(f.controller.selection()).toBeNull(); f.controller.dispose();
  });
  it.each([true, false])("denied permission never starts watch, blocked=%s", async blocked => {
    const f = setup(); vi.mocked(f.adapter.permission).mockResolvedValue({ granted: false, canAskAgain: !blocked }); await f.controller.request();
    expect(f.adapter.watch).not.toHaveBeenCalled(); expect(f.controller.snapshot().message).toContain(blocked ? "zablokovaný" : "nebol povolený"); f.controller.dispose();
  });
  it("services off and unavailable native import stay explicit errors", async () => {
    const f = setup(); vi.mocked(f.adapter.services).mockResolvedValue(false); await f.controller.request(); expect(f.controller.snapshot().message).toContain("vypnutá"); expect(f.adapter.watch).not.toHaveBeenCalled(); f.controller.dispose();
    const unavailable = new DeviceLocation(async () => { throw Error("missing"); }); await unavailable.request(); expect(unavailable.snapshot().phase).toBe("error"); unavailable.dispose();
  });
  it("preserves own inactive permission prompt, waits resumed active before watcher", async () => {
    const f = setup(), permission = deferred<{ granted: boolean; canAskAgain: boolean }>(); vi.mocked(f.adapter.permission).mockReturnValue(permission.promise);
    const request = f.controller.request(); await Promise.resolve(); f.controller.context(true, "inactive"); permission.resolve({ granted: true, canAskAgain: true }); await request;
    expect(f.adapter.watch).not.toHaveBeenCalled(); f.controller.context(true, "active"); await Promise.resolve(); f.receive(); expect(f.controller.snapshot().phase).toBe("ready"); f.controller.dispose();
  });
  it("does not initiate permission when module loading finishes after leaving active", async () => {
    const f = setup(), loading = deferred<DeviceLocationAdapter>(); f.load.mockReturnValue(loading.promise);
    const request = f.controller.request(); f.controller.context(true, "inactive"); loading.resolve(f.adapter); await request;
    f.controller.context(true, "active"); expect(f.adapter.permission).not.toHaveBeenCalled(); expect(f.controller.snapshot().phase).toBe("idle"); f.controller.dispose();
  });
  it("fences services and native callbacks after a superseding request", async () => {
    const f = setup(), services = deferred<boolean>(); vi.mocked(f.adapter.services).mockReturnValueOnce(services.promise);
    const first = f.controller.request(); await vi.waitFor(() => expect(f.adapter.services).toHaveBeenCalledOnce()); f.controller.cancel();
    await f.controller.request(); services.resolve(true); await first;
    expect(f.adapter.watch).toHaveBeenCalledOnce(); f.receive(); expect(f.controller.snapshot().phase).toBe("ready"); f.controller.dispose();
  });
  it("does not extend permission-sheet exception to later inactive service lookup", async () => {
    const f = setup(), services = deferred<boolean>(); vi.mocked(f.adapter.services).mockReturnValue(services.promise);
    const request = f.controller.request(); await vi.waitFor(() => expect(f.adapter.services).toHaveBeenCalledOnce());
    f.controller.context(true, "inactive"); services.resolve(true); await request; f.controller.context(true, "active");
    expect(f.adapter.watch).not.toHaveBeenCalled(); expect(f.controller.snapshot().phase).toBe("idle"); f.controller.dispose();
  });
  it("ends the completed permission exception on first active even while services remain pending", async () => {
    const f = setup(), permission = deferred<{ granted: boolean; canAskAgain: boolean }>(), services = deferred<boolean>();
    vi.mocked(f.adapter.permission).mockReturnValue(permission.promise); vi.mocked(f.adapter.services).mockReturnValue(services.promise);
    const request = f.controller.request(); await Promise.resolve(); f.controller.context(true, "inactive");
    permission.resolve({ granted: true, canAskAgain: true }); await vi.waitFor(() => expect(f.adapter.services).toHaveBeenCalledOnce());
    f.controller.context(true, "active"); f.controller.context(true, "inactive"); services.resolve(true); await request;
    f.controller.context(true, "active"); expect(f.adapter.watch).not.toHaveBeenCalled(); expect(f.controller.snapshot().phase).toBe("idle"); f.controller.dispose();
  });
  it("consumes the dialog exception on first return active even if the native permission promise is still held", async () => {
    const f = setup(), permission = deferred<{ granted: boolean; canAskAgain: boolean }>();
    vi.mocked(f.adapter.permission).mockReturnValue(permission.promise);
    const request = f.controller.request(); await Promise.resolve(); expect(f.adapter.permission).toHaveBeenCalledOnce();
    f.controller.context(true, "inactive"); f.controller.context(true, "active"); f.controller.context(true, "inactive");
    permission.resolve({ granted: true, canAskAgain: true }); await request; f.controller.context(true, "active");
    expect(f.adapter.services).not.toHaveBeenCalled(); expect(f.adapter.watch).not.toHaveBeenCalled(); expect(f.controller.snapshot().phase).toBe("idle"); f.controller.dispose();
  });
  it("removes an existing watcher on its public error callback and ignores subsequent fixes", async () => {
    const f = setup(); let receive!: (v: unknown) => void, fail!: () => void;
    vi.mocked(f.adapter.watch).mockImplementation(async (callback, error) => { receive = callback; fail = error; return { remove: f.remove }; });
    await f.controller.request(); fail(); receive(value);
    expect(f.remove).toHaveBeenCalledOnce(); expect(f.controller.snapshot().phase).toBe("error"); expect(f.controller.selection()).toBeNull(); f.controller.dispose();
  });
  it("times out a held permission without starting a late watcher", async () => {
    vi.useFakeTimers(); const f = setup(), permission = deferred<{ granted: boolean; canAskAgain: boolean }>(); vi.mocked(f.adapter.permission).mockReturnValue(permission.promise);
    const request = f.controller.request(); await Promise.resolve(); f.controller.context(true, "inactive");
    await vi.advanceTimersByTimeAsync(LOCATION_TIMEOUT_MS); permission.resolve({ granted: true, canAskAgain: true }); await request;
    f.controller.context(true, "active"); expect(f.adapter.watch).not.toHaveBeenCalled(); expect(f.controller.snapshot().phase).toBe("error"); f.controller.dispose();
  });
  it("reports rejected watch startup and ignores inaccessible SDK callbacks without claiming removal", async () => {
    const f = setup(); let receive!: (v: unknown) => void;
    vi.mocked(f.adapter.watch).mockImplementation(async callback => { receive = callback; throw Error("native startup"); });
    await f.controller.request(); receive(value); expect(f.controller.snapshot().phase).toBe("error"); expect(f.controller.snapshot().fix).toBeNull(); expect(f.remove).not.toHaveBeenCalled(); f.controller.dispose();
  });
  it.each(["background", "hidden", "disposed"])("fences late permission after %s and never auto retries on resume", async state => {
    const f = setup(), permission = deferred<{ granted: boolean; canAskAgain: boolean }>(); vi.mocked(f.adapter.permission).mockReturnValue(permission.promise);
    const request = f.controller.request(); await Promise.resolve(); if (state === "disposed") f.controller.dispose(); else f.controller.context(state !== "hidden", state === "background" ? "background" : "inactive");
    permission.resolve({ granted: true, canAskAgain: true }); await request; f.controller.context(true, "active"); expect(f.adapter.watch).not.toHaveBeenCalled(); expect(f.load).toHaveBeenCalledOnce(); f.controller.dispose();
  });
  it("removes a subscription that arrives after cancellation and ignores its callback", async () => {
    const f = setup(), registration = deferred<LocationSubscription>(); let receive!: (v: unknown) => void;
    vi.mocked(f.adapter.watch).mockImplementation(callback => { receive = callback; return registration.promise; });
    const request = f.controller.request(); await vi.waitFor(() => expect(f.adapter.watch).toHaveBeenCalledOnce()); f.controller.cancel(); receive(value);
    registration.resolve({ remove: f.remove }); await request; expect(f.remove).toHaveBeenCalledOnce(); expect(f.controller.snapshot().fix).toBeNull(); f.controller.dispose();
  });
  it("removes a late subscription even when its first callback fires before registration resolves", async () => {
    const f = setup(); vi.mocked(f.adapter.watch).mockImplementation(async callback => { callback(value); return { remove: f.remove }; });
    await f.controller.request(); expect(f.controller.snapshot().phase).toBe("ready"); expect(f.remove).toHaveBeenCalledOnce(); f.controller.dispose();
  });
  it("single-flights a double tap and rejects an expired fix at explicit map action", async () => {
    const f = setup(); const a = f.controller.request(), b = f.controller.request(); await Promise.all([a, b]); expect(f.load).toHaveBeenCalledOnce(); f.receive();
    f.clock.mockReturnValue(now + 15001); expect(f.controller.selection()).toBeNull(); expect(f.controller.snapshot().phase).toBe("error"); f.controller.dispose();
  });
});
