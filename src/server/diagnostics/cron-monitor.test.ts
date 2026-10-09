import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./server-errors", () => ({ getServerSentryClient: vi.fn() }));

import { getServerSentryClient } from "./server-errors";
import { finishCronMonitor, startCronMonitor } from "./cron-monitor";

const client = {
  captureCheckIn: vi.fn(() => "1234567890abcdef1234567890abcdef"),
  flush: vi.fn(async () => true),
};
const privateClient = () => client as unknown as NonNullable<Awaited<ReturnType<typeof getServerSentryClient>>>;

describe("existing cron's external check-ins", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DIAGNOSTICS_SENTRY_CRON_MONITOR_SLUG", "dispatch-test-cron");
    vi.mocked(getServerSentryClient).mockReset().mockResolvedValue(privateClient());
    client.captureCheckIn.mockReset().mockReturnValue("1234567890abcdef1234567890abcdef");
    client.flush.mockReset().mockResolvedValue(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("pairs start/end with one ID, duration and no monitor creation settings", async () => {
    const started = Date.now();
    const run = await startCronMonitor(started);
    await vi.advanceTimersByTimeAsync(1_250);
    await finishCronMonitor(run, "ok");
    expect(client.captureCheckIn.mock.calls).toEqual([
      [{ monitorSlug: "dispatch-test-cron", status: "in_progress" }],
      [{ monitorSlug: "dispatch-test-cron", checkInId: "1234567890abcdef1234567890abcdef", status: "ok", duration: 1.25 }],
    ]);
    expect(client.flush).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["degraded", "failed"] as const)("reports %s execution as error once", async status => {
    const run = await startCronMonitor(Date.now());
    await finishCronMonitor(run, status);
    await finishCronMonitor(run, "ok");
    expect(client.captureCheckIn).toHaveBeenCalledTimes(2);
    expect(client.captureCheckIn).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }));
  });

  it.each(["preview", "development", ""])("does not let %s deployments satisfy the stable monitor", async environment => {
    vi.stubEnv("VERCEL_ENV", environment);
    expect(await startCronMonitor(Date.now())).toBeNull();
    expect(getServerSentryClient).not.toHaveBeenCalled();
    expect(client.captureCheckIn).not.toHaveBeenCalled();
  });

  it.each(["", "path/monitor", "monitor?secret=value", "a".repeat(101)])("requires an explicitly configured valid monitor slug %s", async slug => {
    vi.stubEnv("DIAGNOSTICS_SENTRY_CRON_MONITOR_SLUG", slug);
    expect(await startCronMonitor(Date.now())).toBeNull();
    expect(getServerSentryClient).not.toHaveBeenCalled();
  });

  it("honours the private client's environment/DSN rejection without sending", async () => {
    vi.mocked(getServerSentryClient).mockResolvedValue(null);
    expect(await startCronMonitor(Date.now())).toBeNull();
    await finishCronMonitor(null, "failed");
    expect(client.captureCheckIn).not.toHaveBeenCalled();
  });

  it("abandons a slow client initialization without a late start check-in", async () => {
    let ready!: (value: ReturnType<typeof privateClient>) => void;
    vi.mocked(getServerSentryClient).mockReturnValue(new Promise(resolve => { ready = resolve; }));
    const pending = startCronMonitor(Date.now());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toBeNull();
    ready(privateClient());
    await Promise.resolve();
    expect(client.captureCheckIn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the whole start phase, preserves its ID after unconfirmed delivery, and bounds the end", async () => {
    vi.mocked(getServerSentryClient).mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(privateClient()), 700)));
    client.flush.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    const pending = startCronMonitor(started);
    await vi.advanceTimersByTimeAsync(1_000);
    const run = await pending;
    expect(run?.checkInId).toBe("1234567890abcdef1234567890abcdef");
    expect(client.flush).toHaveBeenCalledWith(300);
    const finish = finishCronMonitor(run, "ok");
    await vi.advanceTimersByTimeAsync(1_000);
    await finish;
    expect(Date.now() - started).toBe(2_000);
    expect(client.captureCheckIn).toHaveBeenLastCalledWith(expect.objectContaining({ checkInId: run?.checkInId, status: "ok" }));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"phase":"finish"'));
  });

  it("swallows initialization, capture and flush errors without logging their payload", async () => {
    const secret = new Error("private token and customer data");
    vi.mocked(getServerSentryClient).mockRejectedValueOnce(secret);
    expect(await startCronMonitor(Date.now())).toBeNull();
    client.captureCheckIn.mockImplementationOnce(() => { throw secret; });
    expect(await startCronMonitor(Date.now())).toBeNull();
    client.flush.mockRejectedValue(secret);
    const run = await startCronMonitor(Date.now());
    client.captureCheckIn.mockImplementationOnce(() => { throw secret; });
    await expect(finishCronMonitor(run, "failed")).resolves.toBeUndefined();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(secret.message);
  });

  it("still finishes a captured start if flushing throws synchronously", async () => {
    client.flush.mockImplementationOnce(() => { throw new Error("transport unavailable"); });
    const run = await startCronMonitor(Date.now());
    expect(run).not.toBeNull();
    await finishCronMonitor(run, "ok");
    expect(client.captureCheckIn).toHaveBeenLastCalledWith(expect.objectContaining({ checkInId: run?.checkInId, status: "ok" }));
  });
});
