import type { TowingMember } from "./types";

/** Navigation reflects towing membership; a dispatch role alone grants no towing access. */
export function towingModuleAccess(
  actor: TowingMember | null,
  dispatchIdentity: { userId: string; organizationId: string } | null,
): { office: boolean; driver: boolean } {
  if (!actor?.active || !dispatchIdentity || actor.userId !== dispatchIdentity.userId || actor.organizationId !== dispatchIdentity.organizationId) {
    return { office: false, driver: false };
  }
  return {
    office: actor.capabilities.some(capability => capability !== "drive" && capability !== "deliver"),
    driver: actor.capabilities.includes("drive"),
  };
}
