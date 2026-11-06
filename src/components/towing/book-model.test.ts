import { describe, expect, it } from "vitest";
import { bookNet, bookRequester, bookStage } from "./book-model";
import type { TowingOrder } from "@/domain/towing/types";

describe("book phase", () => {
  it.each(["assigned", "in_progress"] as const)("keeps paid %s work active", workStatus => {
    expect(bookStage({ fields: {} as TowingOrder["fields"], workStatus, billingStatus: "invoiced", paymentStatus: "paid" })).toBe("active");
  });
  it("keeps cancellations and returned work explicit even after payment", () => {
    expect(bookStage({ fields: {} as TowingOrder["fields"], workStatus: "cancelled", billingStatus: "invoiced", paymentStatus: "paid" })).toBe("cancelled");
    expect(bookStage({ fields: {} as TowingOrder["fields"], workStatus: "needs_changes", billingStatus: "invoiced", paymentStatus: "paid" })).toBe("needs_changes");
  });
  it.each([["not_ready", "paid", "review"], ["ready", "paid", "ready"], ["invoiced", "partial", "invoiced"], ["invoiced", "paid", "paid"], ["not_required", "paid", "paid"]] as const)("maps submitted %s/%s to %s", (billingStatus, paymentStatus, expected) => {
    expect(bookStage({ fields: {} as TowingOrder["fields"], workStatus: "submitted", billingStatus, paymentStatus })).toBe(expected);
  });
});
it("does not invent missing net values or requester classification", () => {
  expect(bookNet({})).toBeNull();
  expect(bookRequester({ fields: { serviceType: "tow", subjectType: "vehicle", subjectDescription: "", pickup: "" } })).toBe("Neurčený objednávateľ");
  const lines = [{ id: "a", description: "Odťah", quantity: "2", unit: "km", unitPrice: "10.005", taxRate: "20" }] as NonNullable<TowingOrder["lines"]>;
  expect(bookNet({ lines })).toBe(2001);
});
