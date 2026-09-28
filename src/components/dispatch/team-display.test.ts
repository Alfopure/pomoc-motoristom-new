import { describe, expect, it } from "vitest";
import { colleagueCallView, lastOnlineLabel } from "./team-display";
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

describe("colleague call from the team strip", () => {
  const base = { teamStatus: "available", inCall: false, registered: true, verified: true } as const;
  it("rings an available colleague and a colleague on pause, who keeps the pause", () => {
    expect(colleagueCallView({ ...base, presenceState: "available" })).toMatchObject({ callable: true, paused: false });
    expect(colleagueCallView({ ...base, presenceState: "paused", teamStatus: "paused" })).toMatchObject({ callable: true, paused: true, route: "Zazvoní mu v aplikácii. Je na pauze a pauza mu ostane." });
  });
  it("explains every refusal in the same words as the server", () => {
    expect(colleagueCallView({ ...base, presenceState: "on_call", inCall: true })).toEqual({ callable: false, reason: "Kolega práve telefonuje." });
    expect(colleagueCallView({ ...base, presenceState: "paused", teamStatus: "after_call_work" })).toEqual({ callable: false, reason: "Kolega práve dokončuje hovor. Skúste to o chvíľu." });
    expect(colleagueCallView({ ...base, presenceState: "offline" })).toEqual({ callable: false, reason: "Kolega je odhlásený z telefónie." });
    expect(colleagueCallView({ ...base, presenceState: "unassigned" })).toEqual({ callable: false, reason: "Kolega je odhlásený z telefónie." });
    expect(colleagueCallView({ ...base, presenceState: "unregistered", registered: false })).toEqual({ callable: false, reason: "Kolega nemá zapnutý telefón v aplikácii." });
    expect(colleagueCallView({ ...base, presenceState: "available", deliveryMode: "personal_mobile" })).toMatchObject({ callable: false, reason: expect.stringContaining("osobnom mobile") });
  });
  it("does not guess while the state is being verified", () => {
    expect(colleagueCallView({ ...base, presenceState: "available", verified: false })).toEqual({ callable: false, reason: "Stav kolegu sa overuje." });
    expect(colleagueCallView({ ...base, presenceState: "stale" })).toEqual({ callable: false, reason: "Stav kolegu sa overuje." });
  });
});
