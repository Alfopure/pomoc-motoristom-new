import { describe, expect, it, vi } from "vitest";
import type { MobileDeliveryPositionInput } from "../../../src/lib/mobile-api";
import { DeliveryTracker, type LocationSource } from "./tracker";

const A = "55555555-5555-4555-8555-555555555555", B = "66666666-6666-4666-8666-666666666666";
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const reading = (lat = 49.2): MobileDeliveryPositionInput => ({ lat, lng: 18.7, accuracy: 12, recordedAt: "2026-10-22T10:00:00Z" });
function phone(permission: "granted" | "denied" | "undetermined" = "granted", answer: "granted" | "denied" = "granted") {
  let emit: ((position: MobileDeliveryPositionInput) => void) | null = null;
  const remove = vi.fn();
  const source: LocationSource = {
    permission: vi.fn(async () => permission),
    request: vi.fn(async () => answer),
    watch: vi.fn(async (onPosition: (position: MobileDeliveryPositionInput) => void) => { emit = onPosition; return { remove }; }),
  };
  return { source, remove, emit: (position = reading()) => emit?.(position) };
}

describe("pristavovač location", () => {
  it("never asks by itself and asks right after accepting", async () => {
    const quiet = phone("undetermined"), send = vi.fn(async () => true);
    const tracker = new DeliveryTracker(quiet.source, send);
    await tracker.follow(A);
    expect(quiet.source.request).not.toHaveBeenCalled();
    expect(quiet.source.watch).not.toHaveBeenCalled();
    expect(tracker.snapshot().status).toBe("off");
    await tracker.follow(A, true);
    expect(quiet.source.request).toHaveBeenCalledOnce();
    expect(tracker.snapshot().status).toBe("sharing");
  });

  it("reports a refusal so the screen can explain it", async () => {
    const refused = phone("undetermined", "denied"), tracker = new DeliveryTracker(refused.source, vi.fn());
    await tracker.follow(A, true);
    expect(tracker.snapshot().status).toBe("denied");
    expect(refused.source.watch).not.toHaveBeenCalled();
  });

  it("sends at most every 20 seconds, to the delivery it follows", async () => {
    let now = 0;
    const device = phone(), send = vi.fn(async (_id: string, _position: MobileDeliveryPositionInput) => true);
    const tracker = new DeliveryTracker(device.source, send, () => now);
    await tracker.follow(A);
    device.emit(reading(49.1));
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(tracker.snapshot().lastSentAt).toBe(0);
    now = 5_000; device.emit(reading(49.2));
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    now = 21_000; await tracker.follow(B); device.emit(reading(49.3));
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(call => call[0])).toEqual([A, B]);
    expect(device.source.watch).toHaveBeenCalledOnce();
  });

  it("retries with the next reading after a failed send", async () => {
    let now = 0;
    const device = phone(), send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(true);
    const tracker = new DeliveryTracker(device.source, send, () => now);
    await tracker.follow(A);
    device.emit();
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(tracker.snapshot().lastSentAt).toBeNull();
    now = 1_000; device.emit();
    await flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(tracker.snapshot().lastSentAt).toBe(1_000);
  });

  it("stops watching when no delivery needs it and after logout", async () => {
    const device = phone(), send = vi.fn(async () => true), tracker = new DeliveryTracker(device.source, send);
    await tracker.follow(A);
    await tracker.follow(null);
    expect(device.remove).toHaveBeenCalledOnce();
    expect(tracker.snapshot().status).toBe("off");
    device.emit();
    await flush();
    expect(send).not.toHaveBeenCalled();
    tracker.dispose();
    await tracker.follow(A);
    expect(device.source.watch).toHaveBeenCalledOnce();
  });

  it("stops when the server says the delivery no longer takes the position", async () => {
    const device = phone(), send = vi.fn(async () => false), tracker = new DeliveryTracker(device.source, send);
    await tracker.follow(A);
    device.emit();
    await flush();
    expect(send).toHaveBeenCalledOnce();
    expect(device.remove).toHaveBeenCalledOnce();
    expect(tracker.snapshot().status).toBe("off");
    device.emit();
    await flush();
    expect(send).toHaveBeenCalledOnce();
  });

  it("drops a watch that started after the delivery ended", async () => {
    const device = phone(), tracker = new DeliveryTracker(device.source, vi.fn());
    const starting = tracker.follow(A);
    tracker.stop();
    await starting;
    expect(device.remove).toHaveBeenCalledOnce();
    expect(tracker.snapshot().status).toBe("off");
  });

  it("reports a broken location service", async () => {
    const device = phone();
    vi.mocked(device.source.watch).mockRejectedValueOnce(new Error("unavailable"));
    const tracker = new DeliveryTracker(device.source, vi.fn());
    await tracker.follow(A);
    expect(tracker.snapshot().status).toBe("error");
  });
});
