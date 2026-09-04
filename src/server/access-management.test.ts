import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";

const ORG = "00000000-0000-4000-8000-000000000001";
const ADMIN = "00000000-0000-4000-8000-000000000103";
const TARGET = "00000000-0000-4000-8000-000000000101";

const deleteUser = vi.fn(async () => ({ data: null, error: null }));
const deleteTelephonyCredential = vi.fn(async () => {});
let fake: FakeSupabase;

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ ...fake.client, auth: { admin: { deleteUser: (...args: unknown[]) => deleteUser(...(args as [])) } } }),
}));

vi.mock("@/server/telephony/telnyx/env", () => ({
  getTelnyxConfig: () => ({ configured: true }),
}));

vi.mock("@/server/telephony/telnyx/client", () => ({
  createTelnyxClient: () => ({ deleteTelephonyCredential: (...args: unknown[]) => deleteTelephonyCredential(...(args as [])) }),
}));

import { deleteAccessUser } from "./access-management";

const actor = { profileId: ADMIN, organizationId: ORG, role: "admin" as const, displayName: "Admin", userId: "auth-admin" };

function seed(overrides: Record<string, unknown> = {}) {
  fake = createFakeSupabase();
  fake.db.seed("motorist_profiles", [
    { id: ADMIN, organization_id: ORG, display_name: "Admin", email: "admin@test.sk", role: "admin", active: true, access_status: "active", user_id: "auth-admin" },
    { id: TARGET, organization_id: ORG, display_name: "Natália", email: "natalia@test.sk", role: "dispatcher", active: true, access_status: "active", user_id: "auth-target", ...overrides },
  ]);
}

async function fails(promise: Promise<unknown>) {
  return promise.then(
    () => { throw new Error("expected a rejection"); },
    (error: { message: string; status?: number }) => ({ message: error.message, status: error.status }),
  );
}

describe("deleteAccessUser", () => {
  beforeEach(() => {
    seed();
    deleteUser.mockClear();
    deleteTelephonyCredential.mockClear();
  });

  it("removes the profile, the auth login and the Telnyx credential", async () => {
    fake.db.seed("motorist_operator_devices", [{ id: "dev-1", organization_id: ORG, profile_id: TARGET, telnyx_credential_id: "cred-9", sip_username: "gencred009" }]);

    const result = await deleteAccessUser(actor, TARGET);

    expect(result).toEqual({ deletedProfileId: TARGET });
    expect(fake.db.rows("motorist_profiles").map((row) => row.id)).toEqual([ADMIN]);
    // The login must go with the profile, or it would survive as an account
    // without a profile; the credential must go, or a browser still holding a
    // JWT could keep its SIP registration.
    expect(deleteUser).toHaveBeenCalledWith("auth-target");
    expect(deleteTelephonyCredential).toHaveBeenCalledWith("cred-9");
    // The audit row is written before the row disappears, and names who went.
    expect(fake.db.rows("motorist_audit_log")).toEqual([
      expect.objectContaining({
        action: "access.user.delete",
        actor_profile_id: ADMIN,
        entity_id: TARGET,
        before_payload: expect.objectContaining({ display_name: "Natália", role: "dispatcher" }),
      }),
    ]);
  });

  it("refuses to delete the account you are signed in with", async () => {
    expect(await fails(deleteAccessUser(actor, ADMIN))).toMatchObject({ status: 400, message: "Vlastný účet vymazať nemôžeš." });
    expect(fake.db.rows("motorist_profiles")).toHaveLength(2);
  });

  it("lets one admin delete another, but never lets a manager touch an admin", async () => {
    fake.db.update("motorist_profiles", { role: "admin" }, (row) => row.id === TARGET);
    await deleteAccessUser(actor, TARGET);
    expect(fake.db.rows("motorist_profiles").map((row) => row.id)).toEqual([ADMIN]);

    // The role gate is what actually protects the admins: a manager is refused
    // before the last-admin check is even reached. Together with the
    // self-delete guard, that is what keeps a way into the system.
    seed({ role: "admin" });
    expect(await fails(deleteAccessUser({ ...actor, role: "manager" as const }, TARGET))).toMatchObject({ status: 403 });
    expect(fake.db.rows("motorist_profiles")).toHaveLength(2);
  });

  it("refuses while the user is on a live call", async () => {
    fake.db.seed("motorist_call_legs", [{ id: "leg-1", session_id: "sess-1", profile_id: TARGET, ended_at: null, telnyx_call_control_id: "cc-1" }]);

    expect(await fails(deleteAccessUser(actor, TARGET))).toMatchObject({ status: 409 });
    expect(fake.db.rows("motorist_profiles")).toHaveLength(2);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("still deletes the profile when the user never had a login or a credential", async () => {
    seed({ user_id: null });

    await deleteAccessUser(actor, TARGET);
    expect(fake.db.rows("motorist_profiles").map((row) => row.id)).toEqual([ADMIN]);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(deleteTelephonyCredential).not.toHaveBeenCalled();
  });

  it("keeps the profile when the auth account cannot be removed", async () => {
    deleteUser.mockResolvedValueOnce({ data: null, error: { message: "boom" } } as never);

    expect(await fails(deleteAccessUser(actor, TARGET))).toMatchObject({ status: 500 });
    // Better a user who still exists than a login nobody can see or manage.
    expect(fake.db.rows("motorist_profiles")).toHaveLength(2);
  });
});
