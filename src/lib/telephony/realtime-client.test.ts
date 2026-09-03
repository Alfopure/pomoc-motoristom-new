import { describe, expect, it, vi } from "vitest";

import {
  realtimeResubscribeDelayMs,
  resetTelephonyRealtime,
  subscribeTelephonyRealtime,
  telephonyRealtimeStatus,
  telephonyRealtimeStatusFrom,
  telephonyRealtimeTopic,
  type RealtimeChannelLike,
  type RealtimeClientLike,
  type TelephonyRealtimeSeams,
  type TelephonyRealtimeStatus,
} from "./realtime-client";

const ORG = "8c2f9b1e-0f3d-4c1a-9f61-3b2c1d4e5f60";

type FakeChannel = RealtimeChannelLike & {
  topic: string;
  privateChannel: boolean;
  emit(): void;
  report(status: string): void;
  removed: boolean;
};

function createFakeClient() {
  const channels: FakeChannel[] = [];
  const client: RealtimeClientLike = {
    channel(topic, options) {
      let handler: ((payload: unknown) => void) | null = null;
      let statusCallback: ((status: string) => void) | null = null;
      const channel: FakeChannel = {
        topic,
        privateChannel: options?.config?.private === true,
        removed: false,
        on(_type, _filter, callback) {
          handler = callback;
          return channel;
        },
        subscribe(callback) {
          statusCallback = callback ?? null;
          return channel;
        },
        emit() {
          handler?.({ event: "UPDATE" });
        },
        report(status: string) {
          statusCallback?.(status);
        },
      };
      channels.push(channel);
      return channel;
    },
    removeChannel(channel) {
      (channel as FakeChannel).removed = true;
    },
  };
  return { client, channels };
}

function seamsFor(client: RealtimeClientLike, timers: Array<{ handler: () => void; ms: number }>): TelephonyRealtimeSeams {
  return {
    createClient: () => client,
    setTimer: (handler, ms) => {
      timers.push({ handler, ms });
      return timers.length;
    },
    clearTimer: () => {},
    random: () => 0.5,
  };
}

describe("telephony realtime subscription", () => {
  it("subscribes once per browser to the private organisation topic", () => {
    const { client, channels } = createFakeClient();
    const timers: Array<{ handler: () => void; ms: number }> = [];
    const first = vi.fn();
    const second = vi.fn();

    const stopFirst = subscribeTelephonyRealtime({ organizationId: ORG, onChange: first, seams: seamsFor(client, timers) });
    const stopSecond = subscribeTelephonyRealtime({ organizationId: ORG, onChange: second, seams: seamsFor(client, timers) });

    // Two consoles, one websocket channel: that is the whole point of 2b.
    expect(channels).toHaveLength(1);
    expect(channels[0].topic).toBe(`org:${ORG}:telephony`);
    expect(channels[0].privateChannel).toBe(true);

    channels[0].emit();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    // The channel survives while anyone is still listening.
    stopFirst();
    expect(channels[0].removed).toBe(false);
    channels[0].emit();
    expect(second).toHaveBeenCalledTimes(2);

    stopSecond();
    expect(channels[0].removed).toBe(true);
    expect(telephonyRealtimeStatus(ORG)).toBeNull();
  });

  it("refetches once the channel is connected, because a reconnect may have missed messages", () => {
    const { client, channels } = createFakeClient();
    const timers: Array<{ handler: () => void; ms: number }> = [];
    const onChange = vi.fn();
    const statuses: TelephonyRealtimeStatus[] = [];

    const stop = subscribeTelephonyRealtime({
      organizationId: ORG,
      onChange,
      onStatus: (status) => statuses.push(status),
      seams: seamsFor(client, timers),
    });

    expect(statuses).toEqual(["connecting"]);
    channels[0].report("SUBSCRIBED");
    expect(statuses).toEqual(["connecting", "connected"]);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
    resetTelephonyRealtime();
  });

  it("reopens the channel with backoff after a channel error and reports the gap", () => {
    const { client, channels } = createFakeClient();
    const timers: Array<{ handler: () => void; ms: number }> = [];
    const statuses: TelephonyRealtimeStatus[] = [];

    const stop = subscribeTelephonyRealtime({
      organizationId: ORG,
      onChange: () => {},
      onStatus: (status) => statuses.push(status),
      seams: seamsFor(client, timers),
    });

    channels[0].report("SUBSCRIBED");
    channels[0].report("CHANNEL_ERROR");
    // The console has to learn immediately: it goes back to the fast cadence.
    expect(statuses).toEqual(["connecting", "connected", "disconnected"]);
    expect(timers).toHaveLength(1);

    timers[0].handler();
    expect(channels).toHaveLength(2);
    expect(channels[0].removed).toBe(true);
    channels[1].report("SUBSCRIBED");
    expect(statuses.at(-1)).toBe("connected");

    stop();
  });

  it("does not stack reopen timers while one is pending", () => {
    const { client, channels } = createFakeClient();
    const timers: Array<{ handler: () => void; ms: number }> = [];
    const stop = subscribeTelephonyRealtime({ organizationId: ORG, onChange: () => {}, seams: seamsFor(client, timers) });

    channels[0].report("CHANNEL_ERROR");
    channels[0].report("CLOSED");
    channels[0].report("TIMED_OUT");
    expect(timers).toHaveLength(1);

    stop();
  });

  it("stops delivering after the last listener leaves", () => {
    const { client, channels } = createFakeClient();
    const timers: Array<{ handler: () => void; ms: number }> = [];
    const onChange = vi.fn();
    const stop = subscribeTelephonyRealtime({ organizationId: ORG, onChange, seams: seamsFor(client, timers) });

    stop();
    channels[0].emit();
    channels[0].report("SUBSCRIBED");
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("realtime status mapping and backoff", () => {
  it("treats anything but SUBSCRIBED as not receiving messages", () => {
    expect(telephonyRealtimeStatusFrom("SUBSCRIBED")).toBe("connected");
    for (const status of ["CLOSED", "CHANNEL_ERROR", "TIMED_OUT"]) {
      expect(telephonyRealtimeStatusFrom(status)).toBe("disconnected");
    }
    expect(telephonyRealtimeStatusFrom("joining")).toBe("connecting");
  });

  it("backs off between reopen attempts but stays bounded", () => {
    const first = realtimeResubscribeDelayMs(1, () => 0.5);
    const later = realtimeResubscribeDelayMs(4, () => 0.5);
    expect(later).toBeGreaterThan(first);
    expect(realtimeResubscribeDelayMs(20, () => 1)).toBeLessThanOrEqual(30_000);
  });

  it("embeds the organisation id the RLS policy reads out of the topic", () => {
    expect(telephonyRealtimeTopic(ORG)).toBe(`org:${ORG}:telephony`);
  });
});
