import { describe, expect, it } from "vitest";
import { delivery } from "./fixtures";
import { agoLabel, deliveryPlace, deliveryPoints, deliveryTitle, isOpen, nextStep, positionUrl, replacementCar, sharesPosition, sortDeliveries } from "./model";

const NOW = Date.parse("2026-10-22T10:00:00Z");

describe("delivery steps", () => {
  it("leads through accept, set off, arrive and hand over, one step at a time", () => {
    expect(nextStep(delivery(), NOW)).toEqual({ action: "accept", label: "Prijať pristavenie", confirm: null });
    expect(nextStep(delivery({ status: "accepted" }), NOW)?.action).toBe("en_route");
    expect(nextStep(delivery({ status: "en_route" }), NOW)?.action).toBe("arrived");
    expect(nextStep(delivery({ status: "arrived" }), NOW)).toMatchObject({ action: "complete", label: "Auto odovzdané" });
    expect(nextStep(delivery({ status: "arrived" }), NOW)?.confirm).toBeTruthy();
    for (const status of ["completed", "rejected", "cancelled", "expired"] as const) expect(nextStep(delivery({ status }), NOW)).toBeNull();
    expect(nextStep(delivery({ expiresAt: "2026-10-22T09:59:00Z" }), NOW)).toBeNull();
  });

  it("shares position only for a delivery this pristavovač took, until it closes", () => {
    expect(sharesPosition(delivery({ tracking: true }), NOW)).toBe(false);
    for (const status of ["accepted", "en_route", "arrived"] as const) {
      expect(sharesPosition(delivery({ status, tracking: true }), NOW)).toBe(true);
      // Accepted through the link by someone else: not this phone's position.
      expect(sharesPosition(delivery({ status, tracking: false }), NOW)).toBe(false);
    }
    expect(sharesPosition(delivery({ status: "completed", tracking: true }), NOW)).toBe(false);
    expect(sharesPosition(delivery({ status: "accepted", tracking: true, expiresAt: "2026-10-22T09:00:00Z" }), NOW)).toBe(false);
    expect(isOpen(delivery({ status: "rejected" }), NOW)).toBe(false);
  });
});

describe("what the pristavovač reads", () => {
  it("names the car to take and the place to bring it", () => {
    expect(replacementCar(delivery())).toBe("VW Golf · ZA999AB");
    expect(deliveryTitle(delivery())).toBe("VW Golf · ZA999AB");
    expect(deliveryPlace(delivery())).toBe("Hlavná 1, Žilina");
  });

  it("falls back to the case action and the client's place", () => {
    const base = delivery(), card = { ...base.card!, replacement: { ...base.card!.replacement!, deliveryPlace: " ", vehicle: null } };
    expect(replacementCar({ card })).toBeNull();
    expect(deliveryTitle({ card, caseNumber: "MOCK-42" })).toBe("Odťah");
    expect(deliveryPlace({ card })).toBe("MOCK miesto");
    expect(deliveryTitle({ card: null, caseNumber: "MOCK-42" })).toBe("Pristavenie");
    expect(deliveryPlace({ card: null })).toBeNull();
  });

  it("pins the car by GPS and the places that have coordinates", () => {
    const base = delivery({ replacementPosition: { lat: 49.2, lng: 18.7, recordedAt: "2026-10-22T09:58:00Z" } });
    const card = { ...base.card!, destination: { address: "Servis", lat: 49.1, lng: 18.6 }, pickup: { address: "Klient", lat: null, lng: 18 } };
    expect(deliveryPoints({ ...base, card }).map(point => point.key)).toEqual(["car", "destination"]);
    expect(deliveryPoints({ ...base, card })[0]).toMatchObject({ label: "Náhradné auto", title: "VW Golf · ZA999AB", lat: 49.2, lng: 18.7 });
    expect(deliveryPoints({ card: null, replacementPosition: null })).toEqual([]);
  });

  it("says how long ago and links a point, not a route", () => {
    expect(agoLabel("2026-10-22T09:59:40Z", NOW)).toBe("pred chvíľou");
    expect(agoLabel("2026-10-22T09:55:00Z", NOW)).toBe("pred 5 min");
    expect(agoLabel("2026-10-22T07:30:00Z", NOW)).toBe("pred 2 h");
    expect(agoLabel("bad", NOW)).toBe("");
    expect(positionUrl({ lat: 49.2231, lng: 18.73944 })).toBe("https://www.google.com/maps/search/?api=1&query=49.223100%2C18.739440");
  });

  it("lists open deliveries first, newest on top", () => {
    const old = delivery({ id: "a", createdAt: "2026-10-22T08:00:00Z" }), recent = delivery({ id: "b", createdAt: "2026-10-22T09:30:00Z" });
    const done = delivery({ id: "c", status: "completed", createdAt: "2026-10-22T09:50:00Z" });
    expect(sortDeliveries([done, old, recent], NOW).map(item => item.id)).toEqual(["b", "a", "c"]);
  });
});
