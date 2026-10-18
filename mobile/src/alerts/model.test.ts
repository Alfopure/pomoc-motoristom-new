import { describe, expect, it } from "vitest";
import type { MobileCaseSummary, MobileTask } from "../../../src/lib/mobile-api";
import type { MobileCallbackRequest } from "../../../src/lib/mobile-callbacks";
import { callbackAlerts, caseAlerts, dayKey, sortAlerts, taskAlerts } from "./model";

const now = Date.parse("2026-10-19T08:00:00Z"); // 10:00 in Bratislava
const minutes = (value: number) => new Date(now + value * 60_000).toISOString();
const actions = { claim: true, takeover: false, call: true, resolve: true, blockedReason: null };
function callback(id: string, deadline: string | null, patch: Partial<MobileCallbackRequest> = {}): MobileCallbackRequest {
  return { id, number: "+421905111222", name: null, status: "open", origin: "missed", originDetail: null, sourceLabel: "Zmeškaný hovor", lineLabel: "Allianz",
    partnerName: null, caseId: null, claimant: null, claimedAt: null, deadlineAt: deadline, createdAt: minutes(-40), resolvedAt: null, notes: null, lastCalledAt: null, actions, ...patch };
}
function task(id: string, dueAt: string | null, patch: Partial<MobileTask> = {}): MobileTask {
  return { id, title: "Úloha " + id, status: "open", priority: "normal", kind: "dispatch", revision: 1, workflowState: "todo", originLocked: false,
    assignedTo: { id: "p", name: "Jana" }, reviewer: null, dueAt, createdAt: minutes(-600), updatedAt: minutes(-60), createdByMe: true, reviewSubmission: null, reviewReturnReason: null, ...patch } as MobileTask;
}
function caseRow(id: string, priority: MobileCaseSummary["priority"], ownerId: string | null): MobileCaseSummary {
  return { id, caseNumber: "PM-" + id, status: "new", statusLabel: "Nový", priority, priorityLabel: priority === "urgent" ? "Horí" : "Bežná",
    owner: { id: ownerId, name: ownerId ? "Kolega" : null, mine: false }, contact: { name: "Ján", phone: null }, vehicle: { licensePlate: "BA123AB", description: null },
    pickupAddress: null, destinationAddress: null, summary: "", createdAt: minutes(-30), updatedAt: minutes(-10) };
}

describe("alerts", () => {
  it("keys days in Bratislava time", () => {
    expect(dayKey(Date.parse("2026-10-19T22:30:00Z"))).toBe("2026-10-20");
    expect(dayKey(now)).toBe("2026-10-19");
  });
  it("lists only due and overdue callbacks with their promise", () => {
    const items = callbackAlerts([
      callback("late", minutes(-20), { name: "Ján Novák" }), callback("soon", minutes(10)), callback("later", minutes(60)), callback("none", null),
      callback("mine", minutes(-5), { claimant: { id: "p", name: "Jana", mine: true } }),
    ], now);
    expect(items.map(item => item.id)).toEqual(["late", "soon", "mine"]);
    expect(items[0]).toMatchObject({ title: "Ján Novák", tone: "red", tag: "Po termíne 20 min" });
    expect(items[0].detail).toContain("nikto neprevzal");
    expect(items[1]).toMatchObject({ tone: "orange", tag: "Zavolať do 10 min" });
    expect(items[2].detail).toContain("prevzali ste");
  });
  it("lists own tasks that are late or due today", () => {
    const items = taskAlerts([
      task("late", minutes(-90)), task("today", minutes(180)), task("tomorrow", minutes(60 * 20)), task("old", "2026-10-15T08:00:00Z"),
      task("done", minutes(-30), { status: "done" }), task("nodate", null),
    ], now);
    expect(items.map(item => item.id)).toEqual(["late", "today", "old"]);
    expect(items[0]).toMatchObject({ tone: "red", tag: "Po termíne 08:30" });
    expect(items[1]).toMatchObject({ tone: "orange", tag: "Dnes 13:00" });
    expect(items[2].tag).toBe("Po termíne");
  });
  it("lists burning cases, unassigned ones first after sorting", () => {
    const items = sortAlerts([...caseAlerts([caseRow("a", "urgent", "x"), caseRow("b", "high", null), caseRow("c", "urgent", null)]),
      ...taskAlerts([task("late", minutes(-5))], now), ...callbackAlerts([callback("late", minutes(-1))], now)]);
    expect(items.map(item => item.key)).toEqual(["callback:late", "task:late", "case:c", "case:a"]);
    expect(items.find(item => item.id === "c")?.tag).toBe("Horí · bez dispečera");
  });
});
