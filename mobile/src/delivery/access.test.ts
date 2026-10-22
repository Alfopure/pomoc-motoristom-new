import { describe, expect, it } from "vitest";
import type { MobileFieldMe } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import { DeliveryAccess, deliveryMember, deliverySharing } from "./access";
import { delivery } from "./fixtures";
import { newestDelivery } from "./model";

const MEMBER = "77777777-7777-4777-8777-777777777777", me = { memberId: MEMBER } as MobileFieldMe;
describe("delivery access and reconciliation", () => {
  it.each([401, 403, 502])("drops the cached identity and sharing after a %s identity or list failure", status => {
    const failure = new MobileApiError("denied", status);
    expect(deliveryMember(me, failure)).toBeNull(); expect(deliveryMember(me, null, failure)).toBeNull();
    expect(deliverySharing(null, [delivery({ status: "accepted", tracking: true })], null)).toBeNull();
  });
  it("distinguishes a disabled module from a temporary server failure", () => {
    expect(deliveryMember(me, new MobileApiError("offline", 0))).toBe(MEMBER);
    expect(deliveryMember(me, null, new MobileApiError("busy", 503))).toBe(MEMBER);
    expect(deliveryMember(me, null, new MobileApiError("off", 503, "delivery_unavailable"))).toBeNull();
  });
  it("waits for the first list, and stops on an empty or expired list", () => {
    const now = Date.parse("2026-10-22T10:00:00Z"), active = delivery({ status: "en_route", tracking: true });
    expect(deliverySharing(MEMBER, undefined, null, now)).toBeUndefined();
    expect(deliverySharing(MEMBER, [active], new MobileApiError("offline", 0), now)).toBe(active.id);
    expect(deliverySharing(MEMBER, [], null, now)).toBeNull();
    expect(deliverySharing(MEMBER, [active], null, Date.parse(active.expiresAt))).toBeNull();
  });
  it("does not roll back a confirmed step when an older read completes later", () => {
    const confirmed = delivery({ revision: 5, status: "arrived" });
    expect(newestDelivery(confirmed, delivery({ revision: 4, status: "en_route" }))).toBe(confirmed);
    const refreshed = delivery({ revision: 5, eta: "2026-10-22T11:00:00Z" });
    expect(newestDelivery(confirmed, refreshed)).toBe(refreshed);
  });

  it("does not revoke the whole account for an individual delivery's conflict, absence or network outage", () => {
    const access = new DeliveryAccess();
    for (const status of [0, 400, 404, 409, 429, 500, 502, 503, 504]) access.failed(new MobileApiError("temporary or delivery-specific", status));
    expect(access.snapshot()).toBeNull();
    access.failed(new MobileApiError("off", 503, "delivery_unavailable")); expect(access.snapshot()?.code).toBe("delivery_unavailable");
    access.verified(); expect(access.snapshot()).toBeNull();
  });

  it("a read started before a refusal cannot restore access when it finishes late", () => {
    const access = new DeliveryAccess(), before = access.ticket();
    access.failed(new MobileApiError("revoked", 403)); access.verified(before);
    expect(access.snapshot()?.status).toBe(403);
    access.verified(access.ticket()); expect(access.snapshot()).toBeNull();
  });
});
