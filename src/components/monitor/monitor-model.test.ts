import { describe, expect, it } from "vitest";
import { canShowPercentiles, duration, freshness, timestamp } from "./monitor-model";

describe("monitor evidence presentation", () => {
  it("expires observations independently of later successful responses", () => {
    const readAt = 1_000_000;
    expect(freshness(null, readAt, 120_000)).toBe("unknown");
    expect(freshness(readAt, readAt + 119_999, 120_000)).toBe("fresh");
    expect(freshness(readAt, readAt + 120_000, 120_000)).toBe("stale");
    expect(freshness(readAt, readAt + 180_000, 600_000)).toBe("fresh");
    expect(freshness(readAt, readAt + 600_000, 600_000)).toBe("stale");
    expect(freshness(Number.NaN, readAt, 120_000)).toBe("unknown");
    expect(freshness(readAt + 120_000, readAt, 120_000)).toBe("unknown");
  });
  it("does not expose percentiles below the representative minimum even if supplied", () => {
    expect(canShowPercentiles(99, false)).toBe(false);
    expect(canShowPercentiles(100, true)).toBe(false);
    expect(canShowPercentiles(100, false)).toBe(true);
  });
  it("keeps an unknown call duration distinct from a known zero", () => {
    expect(duration(null)).toBe("Nezistené");
    expect(duration(0)).toBe("0 s");
    expect(duration(135)).toBe("2 min 15 s");
    expect(duration(Number.NaN)).toBe("Nezistené");
    expect(timestamp("not-a-date")).toBe("Nezistené");
  });
  it("keeps Bratislava time correct when reused across daylight-saving changes", () => {
    expect(timestamp("2026-03-29T00:30:00.000Z")).toBe("29. 03. 01:30:00");
    expect(timestamp("2026-03-29T01:30:00.000Z")).toBe("29. 03. 03:30:00");
    expect(timestamp("2026-01-01T23:30:00.000Z")).toBe("02. 01. 00:30:00");
    expect(timestamp(null)).toBe("Nezistené");
    expect(timestamp(undefined)).toBe("Nezistené");
    expect(timestamp("")).toBe("Nezistené");
    expect(timestamp("2026-03-29T00:30:00.000Z")).toBe("29. 03. 01:30:00");
  });
});
