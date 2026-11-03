import { describe, expect, it } from "vitest";
import type { MobileOperation, MobileTowingOrder } from "../../../src/lib/mobile-api";
import { awaitsMember, emptyEvidence, evidencePayload, evidenceProblem, nextOperationStep, nextTowingStep, parseOdometer, sharesOperationPosition, towingMissing, towingMultipart, trackedOperation, workItems } from "./model";

const id = (n: number) => `95000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (hour: number) => `2026-10-28T${String(hour).padStart(2, "0")}:00:00Z`;
function operation(n: number, patch: Partial<MobileOperation> = {}): MobileOperation {
  return { id: id(n), kind: "transfer", status: "assigned", revision: 1, caseNumber: null, vehicle: "Golf", from: "A", to: "B", scheduledAt: null, plannedEndAt: null,
    startedAt: null, updatedAt: at(8), customer: null, instructions: null, vehicleConfirmed: true, evidenceState: "pending", evidence: [], ...patch };
}
function order(n: number, patch: Partial<MobileTowingOrder> = {}, fields: Partial<MobileTowingOrder["fields"]> = {}): MobileTowingOrder {
  return { id: id(n), number: "OT-" + n, revision: 3, assignmentGeneration: 1, workStatus: "in_progress", updatedAt: at(8), attachments: [], ...patch,
    fields: { serviceType: "tow", subjectType: "vehicle", subjectDescription: "Octavia", pickup: "D1", destination: "Servis", plate: null, vin: null, contact: null, noContactReason: null,
      plannedAt: null, startedAt: at(9), finishedAt: at(10), startSource: "manual", driverNotes: null, performedQuantity: null, photoException: null, assistanceReference: null,
      assistancePartnerName: null, parkingName: null, parkingAddress: null, customer: null, ...fields } };
}

describe("Moja práca model", () => {
  it("sorts jazdy and odťahy by term, work without a term last", () => {
    const list = { operations: [operation(1), operation(2, { scheduledAt: at(14) })], towing: [order(3, {}, { plannedAt: at(11) })], unavailable: [] };
    expect(workItems(list).map(item => item.key)).toEqual(["towing:" + id(3), "operation:" + id(2), "operation:" + id(1)]);
    expect(workItems(null)).toEqual([]);
  });
  it("offers one step at a time, with collection taking the vehicle first", () => {
    expect(["assigned", "accepted", "en_route", "arrived", "collected", "completed"].map(status => nextOperationStep({ kind: "collection", status: status as MobileOperation["status"] })?.action))
      .toEqual(["accept", "start", "arrive", "collect", "complete", undefined]);
    expect(nextOperationStep({ kind: "delivery", status: "arrived" })).toMatchObject({ action: "complete", confirm: expect.any(String) });
  });
  it("follows the position only of accepted open work, the earliest one", () => {
    expect(sharesOperationPosition({ status: "assigned" })).toBe(false);
    expect(sharesOperationPosition({ status: "collected" })).toBe(true);
    const list = { operations: [operation(1, { status: "en_route", scheduledAt: at(15) }), operation(2, { status: "accepted", scheduledAt: at(12) }), operation(3, { scheduledAt: at(9) })], towing: null, unavailable: [] };
    expect(trackedOperation(list)).toBe(id(2));
    expect(trackedOperation({ operations: [operation(4)], towing: null, unavailable: [] })).toBeNull();
  });
  it("counts for the bar badge only what waits for the member", () => {
    const list = { operations: [operation(1), operation(2, { status: "accepted" }), operation(3, { status: "en_route" })],
      towing: [order(4, { workStatus: "assigned" }), order(5), order(6, { workStatus: "needs_changes" })], unavailable: [] };
    expect(workItems(list).filter(awaitsMember).map(item => item.key).sort()).toEqual(["operation:" + id(1), "towing:" + id(4), "towing:" + id(6)].sort());
  });
  it("says what an odťah still needs before Odovzdať", () => {
    expect(nextTowingStep({ workStatus: "assigned" }).type).toBe("start");
    expect(nextTowingStep({ workStatus: "needs_changes" }).type).toBe("submit");
    expect(towingMissing(order(1))).toEqual(["fotka práce", "fotka odovzdania"]);
    const photos = [{ id: id(5), kind: "work" as const, name: "a.jpg", mimeType: "image/jpeg", status: "ready" as const, createdAt: at(9) },
      { id: id(6), kind: "handover" as const, name: "b.jpg", mimeType: "image/jpeg", status: "ready" as const, createdAt: at(9) }];
    expect(towingMissing(order(1, { attachments: photos }))).toEqual([]);
    expect(towingMissing(order(1, {}, { photoException: "Tma", startSource: "assignment", destination: null, finishedAt: null }))).toEqual(["skutočný začiatok práce", "koniec práce", "cieľ"]);
    expect(towingMissing(order(1, {}, { serviceType: "repair", destination: null, photoException: "x" }))).toEqual([]);
  });
  it("checks a doklad like the server and keeps only what was entered", () => {
    const draft = { ...emptyEvidence("handover"), person: "Ján", odometer: "12 500", fuel: "1/2" };
    expect(parseOdometer("12 500,5")).toBe(12500.5);
    expect(Number.isNaN(parseOdometer("veľa"))).toBe(true);
    expect(evidenceProblem(draft, false, true)).toContain("fotografiu");
    expect(evidenceProblem(draft, true, true)).toBeNull();
    expect(evidenceProblem({ ...draft, person: "" }, true, true)).toContain("Uveďte");
    expect(evidenceProblem({ ...draft, odometer: "", missingReason: "Tachometer nesvieti" }, true, true)).toBeNull();
    expect(evidenceProblem({ ...draft, stage: "damage", note: "Škrabanec" }, true, true)).toContain("vyrieši");
    expect(evidenceProblem({ ...draft, stage: "damage" }, true, false)).toContain("potvrdenom vozidle");
    expect(evidenceProblem({ ...draft, source: "exception" }, true, true)).toContain("výnimke");
    expect(evidencePayload(draft, at(9), "ref")).toEqual({ stage: "handover", source: "observed", observedAt: at(9), person: "Ján", note: "", photoReference: "ref", odometer: 12500, fuel: "1/2", missingReason: null });
    expect(evidencePayload({ ...draft, stage: "damage", note: " Škrabanec ", damageResolver: " Servis " }, at(9), null)).toMatchObject({ note: "Škrabanec", damageResolver: "Servis" });
  });
  it("builds the towing attachment form with its replay-safe ids", () => {
    const form = towingMultipart({ attachmentId: id(7), commandId: id(8), kind: "scan", expectedRevision: 3, assignmentGeneration: 2 },
      { bytes: new Uint8Array([1, 2, 3]), mimeType: "application/pdf", name: 'sken "1".pdf' }, "pmboundary");
    expect(form.contentType).toBe("multipart/form-data; boundary=pmboundary");
    const text = new TextDecoder().decode(form.bytes);
    for (const part of [`name="attachmentId"\r\n\r\n${id(7)}`, `name="commandId"\r\n\r\n${id(8)}`, 'name="kind"\r\n\r\nscan', 'name="expectedRevision"\r\n\r\n3', 'name="assignmentGeneration"\r\n\r\n2', 'filename="sken _1_.pdf"']) {
      expect(text).toContain(part);
    }
    expect(text.endsWith("\r\n--pmboundary--\r\n")).toBe(true);
    expect(() => towingMultipart({ attachmentId: id(7), commandId: id(8), kind: "work", expectedRevision: 1, assignmentGeneration: 1 }, { bytes: new Uint8Array(), mimeType: "image/jpeg", name: "a" }, "bad boundary")).toThrow();
  });
});
