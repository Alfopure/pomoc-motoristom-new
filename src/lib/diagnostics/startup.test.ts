import { describe, expect, it, vi } from "vitest";
import { StartupDiagnostics } from "./startup";

describe("startup coverage", () => {
  it("retains pre-auth milestones until the collector accepts them and does not duplicate React effects", () => {
    let now = 10;
    const startup = new StartupDiagnostics(() => now);
    startup.start(); startup.start();
    startup.publish(() => null);
    now = 410;
    startup.ready(); startup.ready();
    const record = vi.fn(() => "accepted");
    startup.publish(record); startup.publish(record);
    expect(record.mock.calls).toHaveLength(2);
    expect(record.mock.calls).toMatchObject([[{ reason: "startup_started", durationMs: 0 }], [{ reason: "startup_ready", durationMs: 400 }]]);
    expect(startup.timeout()).toBe(false);
  });

  it("keeps a startup timeout even if hydration later recovers", () => {
    let now = 0;
    const startup = new StartupDiagnostics(() => now);
    startup.start(); now = 30_000;
    expect(startup.timeout()).toBe(true);
    expect(startup.timeout()).toBe(false);
    now = 35_000; startup.ready();
    const record = vi.fn(() => "accepted"); startup.publish(record);
    expect(record.mock.calls).toMatchObject([[{ reason: "startup_started" }], [{ reason: "startup_timeout", durationMs: 30_000 }], [{ reason: "startup_ready", durationMs: 35_000 }]]);
  });
});
