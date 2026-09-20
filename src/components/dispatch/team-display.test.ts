import { describe, expect, it } from "vitest";
import { lastOnlineLabel } from "./team-display";
const now = Date.parse("2026-09-20T07:30:00Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
describe("last confirmed operator connection", () => {
  it("shows verified current connection independently of old availability or old metadata", () => {
    expect(lastOnlineLabel(true, ago(600), now)).toBe("Online teraz");
    expect(lastOnlineLabel(false, ago(12), now)).toBe("Naposledy pred 12 min");
  });
  it("uses minutes and then hours, without claiming an old status age is time online", () => {
    expect(lastOnlineLabel(false, ago(0.5), now)).toBe("Naposledy pred chvíľou");
    expect(lastOnlineLabel(false, ago(59), now)).toBe("Naposledy pred 59 min");
    expect(lastOnlineLabel(false, ago(60), now)).toBe("Naposledy pred 1 h");
    expect(lastOnlineLabel(false, ago(125), now)).toBe("Naposledy pred 2 h");
    expect(lastOnlineLabel(false, ago(48 * 60), now)).toBe("Naposledy pred 2 dňami");
  });
  it("does not turn an expired or absent record into online or a fabricated zero", () => {
    expect(lastOnlineLabel(true, ago(1), now, false)).toBe("Overuje sa spojenie");
    for (const value of [null, "invalid", ago(-10)]) expect(lastOnlineLabel(false, value, now)).toBe("Bez záznamu pripojenia");
  });
});
