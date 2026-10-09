import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCallJourneyPoller, type CallJourneyResource } from "./call-journey-poller";
import type { TelephonyJsonResult } from "@/lib/telephony/client-request";

type Snapshot = { ok: true; ended: boolean; evidence: string; asOf: number };
const terminalKey = ({ ended, evidence }: Snapshot) => ended ? evidence : null;
const response = (overrides: Partial<Snapshot> = {}): TelephonyJsonResult<Snapshot> => ({
  ok: true, status: 200, body: { ok: true, ended: true, evidence: "ended", asOf: Date.now(), ...overrides },
});
const loops: ReturnType<typeof createCallJourneyPoller<Snapshot>>[] = [];

function setup(options: { intervalMs?: number; terminalKey?: typeof terminalKey; read?: (signal: AbortSignal) => Promise<TelephonyJsonResult<Snapshot>> } = {}) {
  let available = true;
  const updates: CallJourneyResource<Snapshot>[] = [];
  const read = vi.fn(options.read ?? (async () => response()));
  const poller = createCallJourneyPoller<Snapshot>({
    read, onChange: state => updates.push(state), canPoll: () => available,
    intervalMs: options.intervalMs ?? 5_000, terminalKey: options.terminalKey ?? terminalKey,
  });
  loops.push(poller);
  return {
    read, poller, updates,
    state: () => updates.at(-1)!,
    availability(value: boolean) { available = value; poller.availabilityChanged(); },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  loops.splice(0).forEach(loop => loop.stop());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("call journey polling lifecycle", () => {
  it("reads through the 30-second terminal window, then makes no reads for another two minutes", async () => {
    const resource = setup();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(resource.read).toHaveBeenCalledTimes(6);
    expect(resource.state().settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resource.read).toHaveBeenCalledTimes(7);
    expect(resource.state().settled).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resource.read).toHaveBeenCalledTimes(7);
    expect(resource.state().loading).toBe(false);
  });

  it("keeps active calls polling at five seconds without reducing their freshness", async () => {
    const resource = setup({ read: async () => response({ ended: false }) });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resource.read).toHaveBeenCalledTimes(25);
    expect(resource.state().settled).toBe(false);
    expect(resource.state().observedAt).toBe(Date.now());
  });

  it("restarts the terminal window for late evidence while ignoring the refreshed asOf timestamp", async () => {
    const started = Date.now();
    const resource = setup({ read: async () => response({ evidence: Date.now() - started < 20_000 ? "ended" : "ended,callback-confirmed" }) });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resource.state().settled).toBe(false);
    expect(resource.state().data?.evidence).toBe("ended,callback-confirmed");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(resource.state().settled).toBe(true);
    expect(resource.read).toHaveBeenCalledTimes(11);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resource.read).toHaveBeenCalledTimes(11);
  });

  it("requires another successful terminal observation even when the first response took over 30 seconds", async () => {
    const resource = setup({ intervalMs: 60_000, read: async () => {
      await new Promise(resolve => setTimeout(resolve, 35_000));
      return response();
    } });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(resource.read).toHaveBeenCalledTimes(1);
    expect(resource.state().settled).toBe(false);
    await vi.advanceTimersByTimeAsync(95_000);
    expect(resource.read).toHaveBeenCalledTimes(2);
    expect(resource.state().settled).toBe(true);
  });

  it("resets terminal stability after a failed check, retaining confirmed data and using backoff", async () => {
    let count = 0;
    const resource = setup({ read: async () => {
      if (++count === 6) throw new Error("Read timed out");
      return response();
    } });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(resource.state()).toMatchObject({ error: "Read timed out", settled: false, loading: false });
    expect(resource.state().data?.evidence).toBe("ended");
    const previousObservedAt = resource.state().observedAt;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(resource.read).toHaveBeenCalledTimes(6);
    expect(resource.state().observedAt).toBe(previousObservedAt);
    await vi.advanceTimersByTimeAsync(1);
    expect(resource.state()).toMatchObject({ error: null, settled: false });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resource.state().settled).toBe(true);
    expect(resource.read).toHaveBeenCalledTimes(13);
  });

  it("manual refresh revalidates a settled call and runs a new terminal window", async () => {
    const resource = setup();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resource.state().settled).toBe(true);
    resource.poller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(resource.read).toHaveBeenCalledTimes(8);
    expect(resource.state().settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resource.read).toHaveBeenCalledTimes(14);
    expect(resource.state().settled).toBe(true);
  });

  it("pauses hidden or offline views and revalidates a settled call on return", async () => {
    const resource = setup();
    await vi.advanceTimersByTimeAsync(30_000);
    resource.availability(false);
    resource.poller.refresh();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resource.read).toHaveBeenCalledTimes(7);
    resource.availability(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(resource.read).toHaveBeenCalledTimes(8);
    expect(resource.state().settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(resource.read).toHaveBeenCalledTimes(14);
    expect(resource.state().settled).toBe(true);
  });

  it("does not count a long hidden period as verified terminal stability", async () => {
    const resource = setup();
    await vi.advanceTimersByTimeAsync(10_000);
    resource.availability(false);
    await vi.advanceTimersByTimeAsync(120_000);
    resource.availability(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(resource.state().settled).toBe(false);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(resource.state().settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resource.state().settled).toBe(true);
  });

  it.each([401, 403, 404])("clears private data on %s when revalidating a settled call", async status => {
    let denied = false;
    const resource = setup({ read: async () => denied ? { ok: false, status, body: null } : response() });
    await vi.advanceTimersByTimeAsync(30_000);
    denied = true;
    resource.poller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(resource.state()).toMatchObject({ data: null, observedAt: null, loading: false, settled: false });
    expect(resource.state().error).toBeTruthy();
    resource.availability(false);
    resource.availability(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resource.read).toHaveBeenCalledTimes(8);
    denied = false;
    resource.poller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(resource.read).toHaveBeenCalledTimes(9);
    expect(resource.state().data).not.toBeNull();
  });

  it("never overlaps reads during repeated refreshes and ignores an aborted response after cleanup", async () => {
    let resolve!: (value: TelephonyJsonResult<Snapshot>) => void;
    const resource = setup({ read: () => new Promise(value => { resolve = value; }) });
    resource.poller.refresh();
    resource.poller.refresh();
    resource.availability(false);
    resource.availability(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resource.read).toHaveBeenCalledTimes(1);
    const signal = resource.read.mock.calls[0][0];
    const updatesBeforeStop = resource.updates.length;
    resource.poller.stop();
    expect(signal.aborted).toBe(true);
    resolve(response());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resource.updates).toHaveLength(updatesBeforeStop);
    expect(resource.read).toHaveBeenCalledTimes(1);
  });

  it("restarts ordinary polling if a supposedly terminal session is active again", async () => {
    let active = false;
    const resource = setup({ read: async () => response({ ended: !active }) });
    await vi.advanceTimersByTimeAsync(30_000);
    active = true;
    resource.poller.refresh();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resource.state().settled).toBe(false);
    expect(resource.read).toHaveBeenCalledTimes(32);
  });

  it("preserves one-shot reads when automatic polling is disabled", async () => {
    const resource = setup({ intervalMs: 0 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resource.read).toHaveBeenCalledTimes(1);
    resource.poller.refresh();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resource.read).toHaveBeenCalledTimes(2);
  });
});
