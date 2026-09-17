import { describe, expect, it } from "vitest";

import { colleagueBadge } from "./colleague-availability";

const now = new Date("2026-09-17T16:07:00.000Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

describe("what the transfer picker says about a colleague", () => {
  it("keeps the presence badge while the phone is connected", () => {
    for (const [status, label] of [["available", "Dostupný"], ["on_call", "Na hovore"], ["paused", "Pauza"], ["after_call_work", "Dopisuje"], ["ringing", "Zvoní"]]) {
      expect(colleagueBadge({ status, deviceLive: true, deviceSeenAt: ago(0) }, now)).toBe(label);
    }
  });

  it("stops calling somebody available once their phone is gone", () => {
    // The 17 Sep case: presence untouched since 12:15, listed as available all
    // afternoon, phone never rang once.
    expect(colleagueBadge({ status: "available", deviceLive: false, deviceSeenAt: ago(232) }, now)).toBe("Nepripojený · 3 h");
  });

  it("counts minutes while they are still readable", () => {
    expect(colleagueBadge({ status: "available", deviceLive: false, deviceSeenAt: ago(20) }, now)).toBe("Nepripojený · 20 min");
    expect(colleagueBadge({ status: "available", deviceLive: false, deviceSeenAt: ago(89) }, now)).toBe("Nepripojený · 89 min");
    expect(colleagueBadge({ status: "available", deviceLive: false, deviceSeenAt: ago(90) }, now)).toBe("Nepripojený · 1 h");
  });

  it("puts no number on a connection that dropped a moment ago", () => {
    expect(colleagueBadge({ status: "available", deviceLive: false, deviceSeenAt: ago(0) }, now)).toBe("Nepripojený");
  });

  it("says plain Nepripojený when there is no heartbeat to measure", () => {
    for (const seenAt of [null, undefined, "not a date"]) {
      expect(colleagueBadge({ status: "available", deviceLive: false, deviceSeenAt: seenAt }, now)).toBe("Nepripojený");
    }
  });

  it("prefers the operator's own decision to log out", () => {
    // "Odhlásený" is a choice; "Nepripojený" is an accident. The choice wins.
    expect(colleagueBadge({ status: "offline", deviceLive: false, deviceSeenAt: ago(240) }, now)).toBe("Odhlásený");
  });
});
