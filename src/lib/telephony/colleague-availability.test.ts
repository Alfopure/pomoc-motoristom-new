import { describe, expect, it } from "vitest";

import { colleagueDeviceNote } from "./colleague-availability";

const now = new Date("2026-09-17T16:07:00.000Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

describe("why a colleague cannot take the call", () => {
  it("says nothing about somebody who can take it", () => {
    expect(colleagueDeviceNote({ available: true, deviceLive: true, deviceSeenAt: ago(0) }, now)).toBeNull();
  });

  it("stays quiet when the phone is connected and the reason is presence", () => {
    // On a call, paused, wrapping up: the badge already says so.
    expect(colleagueDeviceNote({ available: false, deviceLive: true, deviceSeenAt: ago(0) }, now)).toBeNull();
  });

  it("counts the minutes since the phone last reported", () => {
    expect(colleagueDeviceNote({ available: false, deviceLive: false, deviceSeenAt: ago(20) }, now))
      .toBe("Nie je pri počítači (20 min)");
  });

  it("switches to hours once minutes stop being readable", () => {
    // The 17 Sep case: last heartbeat 12:15, still listed as available at 16:07.
    expect(colleagueDeviceNote({ available: false, deviceLive: false, deviceSeenAt: ago(232) }, now))
      .toBe("Nie je pri počítači (3 h)");
  });

  it("does not put a number on a connection that just dropped", () => {
    expect(colleagueDeviceNote({ available: false, deviceLive: false, deviceSeenAt: ago(0) }, now))
      .toBe("Nie je pri počítači");
  });

  it("falls back when the phone has never reported at all", () => {
    for (const seenAt of [null, undefined, "not a date"]) {
      expect(colleagueDeviceNote({ available: false, deviceLive: false, deviceSeenAt: seenAt }, now)).toBe("Telefón nepripojený");
    }
  });
});
