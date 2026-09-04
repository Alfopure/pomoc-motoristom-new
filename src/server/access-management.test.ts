import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, type FakeSupabase } from "@/test/fake-supabase";

const ORG = "00000000-0000-4000-8000-000000000001";
const ADMIN = "00000000-0000-4000-8000-000000000103";
const TARGET = "00000000-0000-4000-8000-000000000101";

const deleteUser = vi.fn<(userId: string) => Promise<{ data: null; error: { message: string } | null }>>();
const deleteTelephonyCredential = vi.fn<(credentialId: string) => Promise<void>>();
let fake: FakeSupabase;

const HISTORY_TABLES = [
  "motorist_attendance_employee_settings",
  "motorist_attendance_sessions",
  "motorist_attendance_shifts",
  "motorist_attendance_time_off_balances",
  "motorist_attendance_unavailability_requests",
  "motorist_operator_statuses",
  "motorist_ring_attempts",
] as const;

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ ...fake.client, auth: { admin: { deleteUser: (...args: unknown[]) => deleteUser(...(args as [string])) } } }),
}));

vi.mock("@/server/telephony/telnyx/env", () => ({
  getTelnyxConfig: () => ({ configured: true }),
}));

vi.mock("@/server/telephony/telnyx/client", () => ({
  createTelnyxClient: () => ({ deleteTelephonyCredential: (...args: unknown[]) => deleteTelephonyCredential(...(args as [string])) }),
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
    deleteUser.mockReset();
    deleteUser.mockResolvedValue({ data: null, error: null });
    deleteTelephonyCredential.mockReset();
    deleteTelephonyCredential.mockResolvedValue();
  });

  it("removes an unused profile, its login, every phone credential and ring-group membership", async () => {
    fake.db.seed("motorist_operator_devices", [
      { id: "dev-1", organization_id: ORG, profile_id: TARGET, environment: "production", telnyx_credential_id: "cred-9", sip_username: "gencred009" },
      { id: "dev-2", organization_id: ORG, profile_id: TARGET, environment: "development", telnyx_credential_id: "cred-10", sip_username: "gencred010" },
    ]);
    fake.db.seed("motorist_operator_presence", [{ id: "presence-1", organization_id: ORG, profile_id: TARGET }]);
    fake.db.seed("motorist_ring_group_members", [
      { id: "member-1", organization_id: ORG, ring_group_id: "group-1", member_kind: "operator", profile_id: TARGET, external_number: null, position: 0 },
      { id: "member-2", organization_id: ORG, ring_group_id: "group-2", member_kind: "operator", profile_id: TARGET, external_number: null, position: 0 },
    ]);

    const result = await deleteAccessUser(actor, TARGET);

    expect(result).toEqual({
      mode: "deleted",
      profileId: TARGET,
      displayName: "Natália",
      removedFromRingGroups: 2,
      authWarning: null,
    });
    expect(fake.db.rows("motorist_profiles").map((row) => row.id)).toEqual([ADMIN]);
    expect(deleteUser).toHaveBeenCalledWith("auth-target");
    expect(deleteTelephonyCredential.mock.calls.map(([id]) => id)).toEqual(["cred-9", "cred-10"]);
    expect(fake.db.rows("motorist_operator_devices")).toHaveLength(0);
    expect(fake.db.rows("motorist_operator_presence")).toHaveLength(0);
    expect(fake.db.rows("motorist_ring_group_members")).toHaveLength(0);
    expect(fake.db.rows("motorist_audit_log")).toEqual([
      expect.objectContaining({
        action: "access.user.delete",
        actor_profile_id: ADMIN,
        entity_id: TARGET,
        before_payload: expect.objectContaining({ display_name: "Natália", role: "dispatcher" }),
        after_payload: { mode: "deleted" },
      }),
    ]);
  });

  it.each(HISTORY_TABLES)("anonymises instead of deleting when %s contains a record", async (table) => {
    fake.db.seed(table, [{ id: `history-${table}`, organization_id: ORG, profile_id: TARGET }]);

    const result = await deleteAccessUser(actor, TARGET);

    expect(result.mode).toBe("anonymised");
    expect(fake.db.find("motorist_profiles", (row) => row.id === TARGET)).toMatchObject({
      display_name: "Vymazaný používateľ",
      email: null,
      phone_extension: null,
      user_id: null,
      active: false,
      access_status: "disabled",
      access_disabled_by: ADMIN,
    });
    expect(fake.db.rows(table)).toHaveLength(1);
    expect(deleteUser).toHaveBeenCalledWith("auth-target");
  });

  it("anonymises conservatively when history cannot be checked", async () => {
    fake.db.failNext("motorist_attendance_employee_settings", "select", "history unavailable");

    const result = await deleteAccessUser(actor, TARGET);

    expect(result.mode).toBe("anonymised");
    expect(fake.db.find("motorist_profiles", (row) => row.id === TARGET)).toMatchObject({
      display_name: "Vymazaný používateľ",
      active: false,
    });
  });

  it("does not change access when the audit entry cannot be written", async () => {
    fake.db.failNext("motorist_audit_log", "insert", "audit unavailable");

    expect(await fails(deleteAccessUser(actor, TARGET))).toMatchObject({ status: 500 });
    expect(fake.db.find("motorist_profiles", (row) => row.id === TARGET)).toMatchObject({
      display_name: "Natália",
      active: true,
      user_id: "auth-target",
    });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(deleteTelephonyCredential).not.toHaveBeenCalled();
  });

  it("does not remove Auth or Telnyx access when the profile cannot be deleted", async () => {
    fake.db.seed("motorist_operator_devices", [
      { id: "dev-1", organization_id: ORG, profile_id: TARGET, environment: "production", telnyx_credential_id: "cred-9" },
    ]);
    fake.db.failNext("motorist_profiles", "delete", "profile unavailable");

    expect(await fails(deleteAccessUser(actor, TARGET))).toMatchObject({ status: 500 });
    expect(fake.db.find("motorist_profiles", (row) => row.id === TARGET)).toMatchObject({
      display_name: "Natália",
      active: true,
      user_id: "auth-target",
    });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(deleteTelephonyCredential).not.toHaveBeenCalled();
  });

  it("does not remove Auth when a history-bearing profile cannot be anonymised", async () => {
    fake.db.seed("motorist_attendance_shifts", [{ id: "shift-1", organization_id: ORG, profile_id: TARGET }]);
    fake.db.failNext("motorist_profiles", "update", "profile unavailable");

    expect(await fails(deleteAccessUser(actor, TARGET))).toMatchObject({ status: 500 });
    expect(fake.db.find("motorist_profiles", (row) => row.id === TARGET)).toMatchObject({
      display_name: "Natália",
      active: true,
      user_id: "auth-target",
    });
    expect(deleteUser).not.toHaveBeenCalled();
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

  it("revokes the application account and reports a warning when Auth cleanup fails", async () => {
    deleteUser.mockResolvedValueOnce({ data: null, error: { message: "boom" } });

    const result = await deleteAccessUser(actor, TARGET);

    expect(result).toMatchObject({ mode: "deleted", authWarning: expect.stringContaining("boom") });
    // The orphaned Auth login no longer resolves to an application profile, so
    // it cannot sign in to the dispatch app while an admin cleans it up.
    expect(fake.db.rows("motorist_profiles").map((row) => row.id)).toEqual([ADMIN]);
  });
});
