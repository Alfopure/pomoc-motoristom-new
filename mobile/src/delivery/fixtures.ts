import type { MobileDelivery } from "../../../src/lib/mobile-api";
import { context } from "../handoff/fixtures";

/** A delivery of a VW Golf to Žilina, as the server sends it. */
export function delivery(change: Partial<MobileDelivery> = {}): MobileDelivery {
  const card = context().preview;
  return {
    id: "55555555-5555-4555-8555-555555555555", status: "offered", revision: 1, publishedVersion: 1, caseNumber: "MOCK-42",
    expiresAt: "2026-10-23T10:00:00Z", createdAt: "2026-10-22T09:00:00Z", openedAt: null, eta: null, createdBy: "MOCK dispečer",
    card: { ...card, replacement: { ...card.replacement!, needed: true, status: "assigned", deliveryPlace: "Hlavná 1, Žilina", vehicle: { make: "VW", model: "Golf", plate: "ZA999AB" } } },
    events: [], replacementPosition: null, tracking: false, ...change,
  };
}
