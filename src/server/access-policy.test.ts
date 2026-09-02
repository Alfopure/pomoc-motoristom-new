import { describe, expect, it } from "vitest";
import { canAssignRole, canManageTargetRole, canManageUsers, isPrivilegedRole } from "./access-policy";

describe("access-policy", () => {
  it("allows only manager and admin to manage users", () => {
    expect(canManageUsers("dispatcher")).toBe(false);
    expect(canManageUsers("senior_dispatcher")).toBe(false);
    expect(canManageUsers("manager")).toBe(true);
    expect(canManageUsers("admin")).toBe(true);
  });

  it("limits managers to dispatcher roles", () => {
    expect(canManageTargetRole("manager", "dispatcher")).toBe(true);
    expect(canManageTargetRole("manager", "senior_dispatcher")).toBe(true);
    expect(canManageTargetRole("manager", "manager")).toBe(false);
    expect(canManageTargetRole("manager", "admin")).toBe(false);
  });

  it("lets admins manage and assign every role", () => {
    expect(canAssignRole("admin", "dispatcher")).toBe(true);
    expect(canAssignRole("admin", "senior_dispatcher")).toBe(true);
    expect(canAssignRole("admin", "manager")).toBe(true);
    expect(canAssignRole("admin", "admin")).toBe(true);
    expect(canManageTargetRole("admin", "admin")).toBe(true);
  });

  it("marks manager and admin as privileged", () => {
    expect(isPrivilegedRole("dispatcher")).toBe(false);
    expect(isPrivilegedRole("manager")).toBe(true);
    expect(isPrivilegedRole("admin")).toBe(true);
  });
});
