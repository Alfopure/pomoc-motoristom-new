import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const updateUserById = vi.fn(async () => ({ data: null, error: null as { message: string } | null }));
const disconnectDevice = vi.fn<(deps: unknown, input: unknown) => Promise<unknown>>();
const createTelephonyDeps = vi.fn(async (options: unknown) => ({ telephonyDeps: options }));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ ...fake.client, auth: { admin: { deleteUser: (...args: unknown[]) => deleteUser(...(args as [string])), updateUserById } } }),
}));

vi.mock("@/server/telephony/runtime", () => ({ createTelephonyDeps: (options: unknown) => createTelephonyDeps(options), telephonyEnvironment: () => "development" }));
vi.mock("@/server/telephony/operator-devices", () => ({ disconnectDevice: (deps: unknown, input: unknown) => disconnectDevice(deps, input) }));

vi.mock("@/server/telephony/telnyx/env", () => ({
  getTelnyxConfig: () => ({ configured: true }),
}));

vi.mock("@/server/telephony/telnyx/client", () => ({
  createTelnyxClient: () => ({ deleteTelephonyCredential: (...args: unknown[]) => deleteTelephonyCredential(...(args as [string])) }),
}));

import { deleteAccessUser, markPasswordCompleted, updateAccessUser } from "./access-management";
import { clearLatencyFlagsCache } from "./telephony/latency-flags";

const actor = { profileId: ADMIN, organizationId: ORG, role: "admin" as const, displayName: "Admin", userId: "auth-admin" };

function seed(overrides: Record<string, unknown> = {}) {
  fake = createFakeSupabase();
  fake.db.registerRpc("motorist_access_profile_has_task_workflow_history", (args, db) =>
    db.rows("motorist_task_workflow_commands").some(
      (row) => row.organization_id === args.p_organization_id && row.actor_profile_id === args.p_profile_id,
    ),
  );
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
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    seed();
    deleteUser.mockReset();
    deleteUser.mockResolvedValue({ data: null, error: null });
    deleteTelephonyCredential.mockReset();
    deleteTelephonyCredential.mockResolvedValue();
  });

  it("refuses Preview deletion or availability changes before partial Auth, profile or phone writes", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    fake.db.seed("motorist_operator_devices", [{ id: "device-1", profile_id: TARGET, telnyx_credential_id: "test-credential" }]);
    fake.db.seed("motorist_operator_presence", [{ id: "presence-1", profile_id: TARGET }]);
    fake.db.seed("motorist_ring_group_members", [{ id: "member-1", profile_id: TARGET }]);
    expect(await fails(deleteAccessUser(actor, TARGET))).toMatchObject({ status: 503 });
    expect(await fails(markPasswordCompleted())).toMatchObject({ status: 503 });
    expect(await fails(updateAccessUser(actor, TARGET, { active: false }))).toMatchObject({ status: 503 });
    expect(await fails(updateAccessUser(actor, TARGET, { role: "manager" }))).toMatchObject({ status: 503 });
    expect(fake.db.rows("motorist_profiles").find(row => row.id === TARGET)).toMatchObject({ active: true, access_status: "active" });
    for (const table of ["motorist_operator_devices", "motorist_operator_presence", "motorist_ring_group_members"]) {
      expect(fake.db.rows(table)).toHaveLength(1);
    }
    expect(fake.db.rows("motorist_audit_log")).toHaveLength(0);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(deleteTelephonyCredential).not.toHaveBeenCalled();
  });

  it("refuses a reserved operator before the first provider leg without changing the account", async () => {
    fake.db.seed("motorist_operator_presence", [{ id: "presence-1", organization_id: ORG, profile_id: TARGET, current_session_id: "reserved-session" }]);
    expect(await fails(deleteAccessUser(actor, TARGET))).toMatchObject({ status: 409 });
    expect(fake.db.rows("motorist_profiles").find(row => row.id === TARGET)).toMatchObject({ active: true, access_status: "active" });
    expect(fake.db.rows("motorist_audit_log")).toHaveLength(0);
    expect(deleteUser).not.toHaveBeenCalled();
    expect(deleteTelephonyCredential).not.toHaveBeenCalled();
  });

  it("removes an unused profile, its login, every phone credential of this environment and ring-group membership", async () => {
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
    // A row copied from production never deletes a production credential from this deployment.
    expect(deleteTelephonyCredential.mock.calls.map(([id]) => id)).toEqual(["cred-10"]);
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

  it.each(["assigned_to", "reviewer_profile_id", "review_requested_by"])(
    "refuses deletion while an open task still references the user through %s",
    async (column) => {
      fake.db.seed("motorist_case_tasks", [{ id: `task-${column}`, organization_id: ORG, status: "open", [column]: TARGET }]);

      expect(await fails(deleteAccessUser(actor, TARGET))).toMatchObject({
        status: 409,
        message: expect.stringContaining("otvorenú pridelenú úlohu alebo kontrolu"),
      });
      expect(fake.db.find("motorist_profiles", (row) => row.id === TARGET)).toMatchObject({
        display_name: "Natália",
        active: true,
        user_id: "auth-target",
      });
      expect(fake.db.rows("motorist_audit_log")).toHaveLength(0);
      expect(deleteUser).not.toHaveBeenCalled();
      expect(deleteTelephonyCredential).not.toHaveBeenCalled();
    },
  );

  it.each(["assigned_to", "created_by", "completed_by", "reviewer_profile_id", "review_requested_by", "reviewed_by"])(
    "anonymises a profile referenced by completed task column %s",
    async (column) => {
      fake.db.seed("motorist_case_tasks", [{ id: `task-${column}`, organization_id: ORG, status: "done", [column]: TARGET }]);

      const result = await deleteAccessUser(actor, TARGET);

      expect(result.mode).toBe("anonymised");
      expect(fake.db.find("motorist_profiles", (row) => row.id === TARGET)).toMatchObject({
        display_name: "Vymazaný používateľ",
        active: false,
        user_id: null,
      });
      expect(fake.db.rows("motorist_case_tasks")).toHaveLength(1);
      expect(deleteUser).toHaveBeenCalledWith("auth-target");
    },
  );

  it.each([
    ["motorist_task_messages", "author_profile_id"],
    ["motorist_task_workflow_commands", "actor_profile_id"],
  ] as const)("anonymises a profile referenced by %s", async (table, column) => {
    fake.db.seed(table, [{ id: `history-${table}`, task_id: "task-1", organization_id: ORG, [column]: TARGET }]);

    const result = await deleteAccessUser(actor, TARGET);

    expect(result.mode).toBe("anonymised");
    expect(fake.db.find("motorist_profiles", (row) => row.id === TARGET)).toMatchObject({
      display_name: "Vymazaný používateľ",
      active: false,
      user_id: null,
    });
    expect(fake.db.rows(table)).toHaveLength(1);
  });

  it("anonymises conservatively when private workflow history cannot be checked", async () => {
    fake.db.failNext("motorist_access_profile_has_task_workflow_history", "rpc", "workflow history unavailable");

    const result = await deleteAccessUser(actor, TARGET);

    expect(result.mode).toBe("anonymised");
    expect(fake.db.find("motorist_profiles", (row) => row.id === TARGET)).toMatchObject({
      display_name: "Vymazaný používateľ",
      active: false,
      user_id: null,
    });
  });

  it("fails closed before auditing when active task responsibilities cannot be checked", async () => {
    fake.db.failNext("motorist_case_tasks", "select", "task lookup unavailable");

    expect(await fails(deleteAccessUser(actor, TARGET))).toMatchObject({ status: 500, message: "Pracovné úlohy používateľa sa nepodarilo overiť." });
    expect(fake.db.find("motorist_profiles", (row) => row.id === TARGET)).toMatchObject({ active: true, user_id: "auth-target" });
    expect(fake.db.rows("motorist_audit_log")).toHaveLength(0);
    expect(deleteUser).not.toHaveBeenCalled();
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

describe("the iPhone credential on deactivation and removal (call-speed S8.1)", () => {
  const rotation = () => vi.stubEnv("TELEPHONY_LATENCY_FLAGS", JSON.stringify({ mobile_rotate_on_deactivation: true }));
  const mobileDevice = { id: "mobile-1", organization_id: ORG, profile_id: TARGET, environment: "development", telnyx_credential_id: "mobile-cred", sip_username: "mobile-sip" };
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  beforeEach(() => {
    seed(); clearLatencyFlagsCache();
    for (const mock of [deleteUser, deleteTelephonyCredential, updateUserById, disconnectDevice, createTelephonyDeps]) mock.mockClear();
    deleteUser.mockResolvedValue({ data: null, error: null }); deleteTelephonyCredential.mockResolvedValue(); disconnectDevice.mockResolvedValue(null);
  });

  it("revokes the iPhone lease and credential after the profile is inactive, only with the switch", async () => {
    await updateAccessUser(actor, TARGET, { active: false });
    expect(disconnectDevice).not.toHaveBeenCalled(); expect(createTelephonyDeps).not.toHaveBeenCalled();
    rotation(); clearLatencyFlagsCache();
    disconnectDevice.mockImplementation(async () => {
      // The phone cannot enroll a new credential in between: its profile is already off.
      expect(fake.db.find("motorist_profiles", row => row.id === TARGET)).toMatchObject({ active: false, access_status: "disabled" });
      return null;
    });
    await updateAccessUser(actor, TARGET, { active: false });
    expect(createTelephonyDeps).toHaveBeenCalledWith({ organizationId: ORG, deviceKind: "mobile" });
    expect(disconnectDevice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ deviceKind: "mobile" }), { organizationId: ORG, profileId: TARGET });
    await updateAccessUser(actor, TARGET, { displayName: "Natália N." });
    expect(disconnectDevice).toHaveBeenCalledOnce();
  });
  it("revokes fail-closed with the switch off while a JWT issued for caching may still be in use", async () => {
    const open = { token_cache_until: new Date(Date.now() + 3_600_000).toISOString() };
    fake.db.seed("motorist_operator_mobile_devices", [{ ...mobileDevice, metadata: { token_cache_until: new Date(Date.now() - 1).toISOString() } }]);
    await updateAccessUser(actor, TARGET, { active: false });
    expect(disconnectDevice).not.toHaveBeenCalled();
    fake.db.update("motorist_operator_mobile_devices", { metadata: open }, () => true);
    await updateAccessUser(actor, TARGET, { active: false });
    expect(disconnectDevice).toHaveBeenCalledOnce();
  });
  it("repeats a deactivation without rewriting who disabled the user and when, and says whether the phone lost anything", async () => {
    const first = await updateAccessUser(actor, TARGET, { active: false });
    expect("phoneRevoked" in first).toBe(false);
    fake.db.update("motorist_profiles", { access_disabled_at: "2026-10-01T08:00:00.000Z", access_disabled_by: TARGET }, row => row.id === TARGET);
    disconnectDevice.mockResolvedValueOnce({ device: {}, deletedCredentialId: "mobile-cred", revoked: true }).mockResolvedValueOnce(null);
    // An explicit repeat always revokes, switches on or off.
    expect(await updateAccessUser(actor, TARGET, { active: false })).toMatchObject({ phoneRevoked: true });
    expect(await updateAccessUser(actor, TARGET, { active: false })).toMatchObject({ phoneRevoked: false });
    expect(disconnectDevice).toHaveBeenCalledTimes(2);
    expect(fake.db.find("motorist_profiles", row => row.id === TARGET)).toMatchObject({ active: false, access_status: "disabled",
      access_disabled_at: "2026-10-01T08:00:00.000Z", access_disabled_by: TARGET });
  });
  it("says so when Telnyx keeps the iPhone credential, so the manager repeats the deactivation", async () => {
    rotation(); disconnectDevice.mockRejectedValue(new Error("provider down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await fails(updateAccessUser(actor, TARGET, { active: false }))).toMatchObject({ status: 502 });
    expect(fake.db.find("motorist_profiles", row => row.id === TARGET)).toMatchObject({ active: false });
  });
  it("revokes the iPhone credential before removing the account, whatever the switches", async () => {
    fake.db.seed("motorist_operator_mobile_devices", [{ ...mobileDevice, metadata: { pending_credential_deletions: ["pending-cred"] } },
      { ...mobileDevice, id: "mobile-2", environment: "production", telnyx_credential_id: "other-env-cred", metadata: { pending_credential_deletions: ["other-env-pending"] } }]);
    fake.db.seed("motorist_operator_devices", [{ id: "web-1", organization_id: ORG, profile_id: TARGET, environment: "development", telnyx_credential_id: "web-cred",
      metadata: { pending_credential_deletions: [{ id: "web-pending", failures: 2 }] } }]);
    disconnectDevice.mockImplementation(async () => {
      // Nothing irreversible yet: the profile and its login are still there.
      expect(fake.db.find("motorist_profiles", row => row.id === TARGET)).toBeTruthy(); expect(deleteUser).not.toHaveBeenCalled();
      fake.db.update("motorist_operator_mobile_devices", { telnyx_credential_id: null }, row => row.id === "mobile-1");
      return null;
    });
    await deleteAccessUser(actor, TARGET);
    expect(disconnectDevice).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ deviceKind: "mobile" }), { organizationId: ORG, profileId: TARGET });
    // This environment's still-pending IDs (browser and iPhone) go best-effort; another
    // environment's credentials and pending IDs are never deleted from this deployment.
    expect(deleteTelephonyCredential.mock.calls.map(([credential]) => credential)).toEqual(["web-cred", "web-pending", "pending-cred"]);
    expect(fake.db.rows("motorist_operator_mobile_devices")).toHaveLength(0);
  });
  it("keeps the account when Telnyx keeps the iPhone credential, so the removal can be repeated", async () => {
    fake.db.seed("motorist_operator_mobile_devices", [mobileDevice]);
    disconnectDevice.mockRejectedValue(new Error("provider down")); vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await fails(deleteAccessUser(actor, TARGET))).toMatchObject({ status: 502 });
    expect(fake.db.find("motorist_profiles", row => row.id === TARGET)).toMatchObject({ active: true });
    expect(fake.db.rows("motorist_audit_log")).toHaveLength(0); expect(deleteUser).not.toHaveBeenCalled();
    expect(fake.db.rows("motorist_operator_mobile_devices")).toHaveLength(1);
  });
  it("records every browser credential Telnyx did not delete at removal, with its ID, and keeps removal best-effort", async () => {
    fake.db.seed("motorist_operator_devices", [{ id: "web-1", organization_id: ORG, profile_id: TARGET, environment: "development", telnyx_credential_id: "web-cred",
      metadata: { pending_credential_deletions: ["web-pending", "web-gone"] } }]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    deleteTelephonyCredential.mockImplementation(async (id: string) => {
      if (id === "web-cred") throw new Error("provider down");
      if (id === "web-gone") throw Object.assign(new Error("not found"), { status: 404 });
    });
    await deleteAccessUser(actor, TARGET);
    expect(fake.db.rows("motorist_profiles").map(row => row.id)).toEqual([ADMIN]);
    expect(fake.db.rows("motorist_audit_log").filter(row => row.action === "telephony.credential_deletion_stuck"))
      .toEqual([expect.objectContaining({ entity_id: TARGET, after_payload: { credentialId: "web-cred", removal: true } })]);
    expect(logged.mock.calls.some(([line]) => String(line).includes("\"credentialId\":\"web-cred\""))).toBe(true);
  });
  it("needs no Telnyx round trip to remove an account without an iPhone", async () => {
    await deleteAccessUser(actor, TARGET);
    expect(createTelephonyDeps).not.toHaveBeenCalled(); expect(disconnectDevice).not.toHaveBeenCalled();
  });
});
