import type { AppRole } from "@/domain/types";

export const accessManagedRoles: AppRole[] = ["dispatcher", "senior_dispatcher", "manager", "admin"];

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === "string" && accessManagedRoles.includes(value as AppRole);
}

export function canManageUsers(actorRole: AppRole) {
  return actorRole === "manager" || actorRole === "admin";
}

export function canManageTargetRole(actorRole: AppRole, targetRole: AppRole) {
  if (actorRole === "admin") {
    return true;
  }

  return actorRole === "manager" && (targetRole === "dispatcher" || targetRole === "senior_dispatcher");
}

export function canAssignRole(actorRole: AppRole, nextRole: AppRole) {
  return canManageTargetRole(actorRole, nextRole);
}

export function isPrivilegedRole(role: AppRole) {
  return role === "manager" || role === "admin";
}

export function roleLabel(role: AppRole) {
  switch (role) {
    case "admin":
      return "Admin";
    case "manager":
      return "Manažér";
    case "senior_dispatcher":
      return "Senior dispečer";
    case "dispatcher":
      return "Dispečer";
  }
}
