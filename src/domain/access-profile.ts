export const DELETED_ACCESS_PROFILE_NAME = "Vymazaný používateľ";

type AccessProfileIdentity = {
  display_name: string;
  email: string | null;
  phone_extension: string | null;
  user_id: string | null;
  active: boolean;
  access_status: string;
};

/**
 * Deleted users with operational history remain as identity-free tombstones so
 * foreign-key cascades cannot erase attendance or historical call reporting.
 * Keep this predicate strict: an ordinary disabled profile must remain visible
 * to admins and be available for reactivation.
 */
export function isDeletedAccessProfile(profile: AccessProfileIdentity): boolean {
  return (
    profile.display_name === DELETED_ACCESS_PROFILE_NAME &&
    profile.email === null &&
    profile.phone_extension === null &&
    profile.user_id === null &&
    profile.active === false &&
    profile.access_status === "disabled"
  );
}
