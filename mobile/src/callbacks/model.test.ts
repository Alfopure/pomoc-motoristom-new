import { describe, expect, it } from "vitest";
import type { MobileCallbackRequest } from "../../../src/lib/mobile-callbacks";
import { callbackUrgency, checkDialTarget, deadlineText, dialDecision, filterCallbacks, formatWait } from "./model";

const base = Date.parse("2026-10-18T09:00:00Z");
function request(id: string, change: Partial<MobileCallbackRequest> = {}): MobileCallbackRequest {
  return { id, number: "+421905111222", name: null, status: "open", origin: "missed", originDetail: null, sourceLabel: "Zmeškaný hovor", lineLabel: null, partnerName: null,
    caseId: null, claimant: null, claimedAt: null, deadlineAt: "2026-10-18T09:30:00Z", createdAt: "2026-10-18T09:00:00Z", resolvedAt: null, notes: null, lastCalledAt: null,
    actions: { claim: true, takeover: false, call: true, resolve: true, blockedReason: null }, ...change };
}

describe("callback queue presentation", () => {
  it("filters only the loaded page by owner and origin", () => {
    const rows = [request("free"), request("mine", { claimant: { id: "me", name: "Ja", mine: true } }), request("other", { claimant: { id: "x", name: "Peter", mine: false } }),
      request("asked", { origin: "requested" })];
    expect(filterCallbacks(rows, "all").map(row => row.id)).toEqual(["free", "mine", "other", "asked"]);
    expect(filterCallbacks(rows, "unclaimed").map(row => row.id)).toEqual(["free", "asked"]);
    expect(filterCallbacks(rows, "mine").map(row => row.id)).toEqual(["mine"]);
    expect(filterCallbacks(rows, "requested").map(row => row.id)).toEqual(["asked"]);
  });
  it("uses the web thresholds: amber 15 minutes before the promise, red after it", () => {
    const row = request("a");
    expect(callbackUrgency(row, base + 14 * 60_000)).toBe("fresh");
    expect(callbackUrgency(row, base + 15 * 60_000)).toBe("due");
    expect(callbackUrgency(row, base + 30 * 60_000)).toBe("overdue");
    expect(callbackUrgency({ ...row, status: "done" }, base + 90 * 60_000)).toBe("fresh");
    expect(callbackUrgency({ ...row, deadlineAt: null }, base + 90 * 60_000)).toBe("fresh");
  });
  it("formats waiting in minutes and describes the deadline", () => {
    expect(formatWait("2026-10-18T09:00:00Z", base + 30_000)).toBe("< 1 min");
    expect(formatWait("2026-10-18T09:00:00Z", base + 7 * 60_000)).toBe("7 min");
    expect(formatWait("2026-10-18T09:00:00Z", base + 72 * 60_000)).toBe("1 h 12 min");
    expect(formatWait("2026-10-18T09:00:00Z", base + 120 * 60_000)).toBe("2 h");
    expect(deadlineText(request("a"), base + 12 * 60_000)).toBe("Zavolať do 18 min");
    expect(deadlineText(request("a"), base + 41 * 60_000)).toBe("Po termíne 11 min");
    expect(deadlineText(request("a", { status: "cancelled" }), base)).toBeNull();
  });
});

describe("dial target decision", () => {
  const target = { originalNumber: "+421232408700", sourceName: "Recepcia", targetName: "Ján Novák" };
  it("dials an unrestricted number directly", () => {
    expect(dialDecision({ ...target, status: "original", dialNumber: "+421232408700", verificationId: null })).toEqual({ kind: "dial", number: "+421232408700" });
  });
  it("asks before ringing a verified replacement and keeps the original in the explanation", () => {
    const decision = dialDecision({ ...target, status: "verified_alternative", dialNumber: "+421905444555", verificationId: "v1" });
    expect(decision).toMatchObject({ kind: "confirm", number: "+421905444555", verificationId: "v1", title: "Volať na overené číslo?" });
    expect(decision.kind === "confirm" && decision.message).toContain("+421 232 408 700 (Recepcia)");
    expect(decision.kind === "confirm" && decision.message).toContain("+421 905 444 555 (Ján Novák)");
  });
  it("blocks a no-callback number or an incomplete replacement", () => {
    expect(dialDecision({ ...target, status: "blocked", dialNumber: null, verificationId: null })).toMatchObject({ kind: "blocked", message: expect.stringContaining("nedá volať späť") });
    expect(dialDecision({ ...target, status: "verified_alternative", dialNumber: null, verificationId: "v1" }).kind).toBe("blocked");
  });
  it("ends the number check before the call is dialed, also when the check fails", async () => {
    const steps: string[] = [];
    const decision = await checkDialTarget(async () => { steps.push("read"); return { ...target, status: "original", dialNumber: "+421232408700", verificationId: null }; }, () => steps.push("checked"));
    steps.push("dial " + (decision.kind === "dial" ? decision.number : decision.kind));
    expect(steps).toEqual(["read", "checked", "dial +421232408700"]);
    let checked = false;
    await expect(checkDialTarget(() => Promise.reject(new Error("offline")), () => { checked = true; })).rejects.toThrow("offline");
    expect(checked).toBe(true);
  });
});

describe("waiting label", () => {
  it("uses Slovak plural forms", async () => {
    const { waitingLabel } = await import("./model");
    expect([1, 2, 4, 5, 11, 22].map(waitingLabel)).toEqual(["1 požiadavka čaká", "2 požiadavky čakajú", "4 požiadavky čakajú", "5 požiadaviek čaká", "11 požiadaviek čaká", "22 požiadaviek čaká"]);
  });
});
