import { describe, expect, it } from "vitest";
import { towingModuleAccess } from "./module-access";
import type { TowingMember } from "./types";

const identity = { userId: "user", organizationId: "organization" };
const member: TowingMember = { ...identity, id: "member", displayName: "Vodič", roles: ["driver"], capabilities: ["drive"], active: true, version: 1 };

describe("towing module navigation access", () => {
  it("uses the member's office and driving permissions independently", () => {
    expect(towingModuleAccess(member, identity)).toEqual({ office: false, driver: true });
    expect(towingModuleAccess({ ...member, capabilities: ["operate", "drive"] }, identity)).toEqual({ office: true, driver: true });
    expect(towingModuleAccess({ ...member, capabilities: ["bill"] }, identity)).toEqual({ office: true, driver: false });
    expect(towingModuleAccess({ ...member, capabilities: ["deliver"] }, identity)).toEqual({ office: false, driver: false });
  });

  it("does not borrow another user's or organization's membership", () => {
    expect(towingModuleAccess(null, identity)).toEqual({ office: false, driver: false });
    expect(towingModuleAccess(member, null)).toEqual({ office: false, driver: false });
    expect(towingModuleAccess({ ...member, active: false }, identity)).toEqual({ office: false, driver: false });
    expect(towingModuleAccess(member, { ...identity, userId: "other" })).toEqual({ office: false, driver: false });
    expect(towingModuleAccess(member, { ...identity, organizationId: "other" })).toEqual({ office: false, driver: false });
  });
});
