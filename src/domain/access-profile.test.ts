import { describe, expect, it } from "vitest";

import { DELETED_ACCESS_PROFILE_NAME, isDeletedAccessProfile } from "./access-profile";

const tombstone = {
  display_name: DELETED_ACCESS_PROFILE_NAME,
  email: null,
  phone_extension: null,
  user_id: null,
  active: false,
  access_status: "disabled",
};

describe("isDeletedAccessProfile", () => {
  it("recognises an identity-free deleted profile", () => {
    expect(isDeletedAccessProfile(tombstone)).toBe(true);
  });

  it("does not hide an ordinary disabled profile", () => {
    expect(isDeletedAccessProfile({ ...tombstone, display_name: "Natália" })).toBe(false);
    expect(isDeletedAccessProfile({ ...tombstone, email: "natalia@test.sk" })).toBe(false);
    expect(isDeletedAccessProfile({ ...tombstone, active: true })).toBe(false);
  });
});
