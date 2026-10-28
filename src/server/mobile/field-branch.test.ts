import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), rpc: vi.fn() }));
vi.mock("./auth", () => ({ mobileEnvironment: () => "test", verifyMobileUser: mocks.user, requireMobileActor: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/server/default-organization", () => ({ resolveDefaultOrganizationId: vi.fn() }));

const branch = await import("./field-branch");
const { GET: branchRoute } = await import("@/app/api/mobile/v1/field/branch/route");

const id = (n: number) => `94000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1), USER = id(2), MEMBER = id(3), GA = id(4), GB = id(5), R1 = id(6), R2 = id(7), CMD = id(8), EXEC = id(9), OP = id(10);
const at = "2026-10-28T08:00:00.000000+00:00";
const actor = { userId: USER, memberId: MEMBER, organizationId: ORG, displayName: "Lokálna", email: null, version: 1, capabilities: [], roles: ["branch"] };
const member = { id: MEMBER, userId: USER, organizationId: ORG, displayName: "Lokálna", email: null, active: true, version: 1, capabilities: [], roles: ["branch"] };
function request(overrides: Record<string, unknown> = {}) {
  return { id: R1, kind: "delivery", status: "claimed", revision: 3, groupId: GA, groupName: "Žilina", branchName: "Pobočka Žilina", caseId: id(20), caseNumber: "PM-1", caseType: "breakdown",
    customer: { name: "Klient", phone: "+421900000000" }, vehicle: "Golf", pickup: "A", destination: "B", dueAt: at, note: "Volať vopred", fleetAssetId: null, cycleId: null, routedAt: at,
    claimedBy: USER, claimedByName: "Lokálna", claimedAt: at, cancelReason: null, createdAt: at, updatedAt: at, execution: null, related: [{ id: id(30), kind: "tow", status: "queued", groupName: "Iná", executionStatus: null }], ...overrides };
}
function workspace(overrides: Record<string, unknown> = {}, actorPatch: Record<string, unknown> = {}) {
  return { actor: { userId: USER, organizationId: ORG, displayName: "Lokálna", memberId: MEMBER, version: 1, central: false, manage: false,
    leadGroups: [{ id: GA, name: "Žilina", role: "lead", receivesNew: true }], canDeliver: false, canOperateTowing: false, ...actorPatch },
    requests: [request(), request({ id: R2, groupId: GB, groupName: "Košice", claimedBy: id(99) })], totalCount: 2,
    groups: [{ id: GA, name: "Žilina", active: true, revision: 1, branchId: null, branchName: null, serviceKinds: ["delivery"], counts: { queued: 1, claimed: 1, active: 0, overdue: 0 },
      members: [{ id: EXEC, name: "Pristavovač", role: "member", receivesNew: false, active: true, canDeliver: true, canDrive: false }, { id: id(31), name: "Bývalý", role: "member", receivesNew: false, active: false, canDeliver: true, canDrive: false }] },
    { id: GB, name: "Košice", active: true, revision: 1, branchId: null, branchName: null, serviceKinds: ["delivery"], counts: { queued: 0, claimed: 0, active: 0, overdue: 0 }, members: [] }],
    branches: [], people: [{ id: id(40), name: "Niekto", email: "x@example.test", roles: [] }], cycles: [], fleet: [], ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MOBILE_DELIVERY_ENABLED", "true");
  mocks.user.mockResolvedValue({ userId: USER, email: undefined, organizationId: ORG, expectedOrganization: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("Pobočka in the app", () => {
  it("shows only the lead's own groups, active members and allowlisted fields", () => {
    const projected = branch.projectBranchWorkspace(workspace({}, { central: true }) as never, actor, "open");
    expect(projected.groups.map(group => group.id)).toEqual([GA]);
    expect(projected.groups[0]).toMatchObject({ receivesNew: true, members: [{ id: EXEC, name: "Pristavovač", role: "member", canDeliver: true, canDrive: false }] });
    expect(projected.requests.map(item => item.id)).toEqual([R1]);
    expect(projected.requests[0]).toMatchObject({ claimedByMe: true, claimedByName: "Lokálna", customer: { name: "Klient" } });
    const json = JSON.stringify(projected);
    for (const secret of [USER, "x@example.test", "Iná", "breakdown"]) expect(json).not.toContain(secret);
    expect(projected.totalCount).toBe(1);
  });
  it("reads each own group by itself for a member who is also central", async () => {
    const calls: Record<string, unknown>[] = [];
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "motorist_towing_actor") return { data: member, error: null };
      calls.push(args.p_filters as Record<string, unknown>);
      const groupId = (args.p_filters as { groupId?: string }).groupId;
      // The organization-wide first page holds only another group's work.
      return { data: workspace({ requests: groupId === GA ? [request()] : [request({ id: R2, groupId: GB, groupName: "Košice" })], totalCount: groupId ? 1 : 250 }, { central: true }), error: null };
    });
    const projected = await branch.loadFieldBranch(actor, new URL("https://app.test/api?view=queue"));
    expect(calls).toEqual([{ view: "queue", limit: 100 }, { view: "queue", limit: 100, groupId: GA }]);
    expect(projected.requests.map(item => item.id)).toEqual([R1]);
    expect(projected.totalCount).toBe(1);
    await expect(branch.loadFieldBranch(actor, new URL("https://app.test/api?groupId=" + GB))).rejects.toMatchObject({ status: 403 });
  });
  it("refuses a member without a lead seat", async () => {
    expect(() => branch.projectBranchWorkspace(workspace({}, { leadGroups: [] }) as never, actor, "open")).toThrow(expect.objectContaining({ status: 403, code: "mobile_no_branch_seat" }));
    mocks.rpc.mockImplementation(async (name: string) => name === "motorist_towing_actor" ? { data: member, error: null } : { data: null, error: { code: "42501", message: "Forbidden" } });
    const response = await branchRoute(new Request("https://app.test/api/mobile/v1/field/branch?view=queue", { headers: { authorization: "Bearer x" } }));
    expect(response.status).toBe(403);
  });
  it("accepts only the lead's own actions", () => {
    const base = { commandId: CMD, requestId: R1, expectedRevision: 3 };
    expect(branch.readBranchCommand({ ...base, action: "claim", payload: {} })).toEqual({ ...base, action: "claim", payload: {} });
    expect(branch.readBranchCommand({ ...base, action: "materialize", payload: { assigneeId: EXEC } }).payload).toEqual({ assigneeId: EXEC });
    expect(branch.readBranchCommand({ ...base, action: "operate", payload: { command: { action: "assign", expectedRevision: 2, payload: { assigneeId: EXEC } } } }).payload)
      .toEqual({ command: { action: "assign", expectedRevision: 2, payload: { assigneeId: EXEC } } });
    for (const bad of [{ action: "create" }, { action: "route" }, { action: "cancel" }, { action: "group_save" }, { requestId: undefined }, { expectedRevision: 0 },
      { action: "claim", payload: { groupId: GB } }, { action: "materialize", payload: { assigneeId: "x" } },
      { action: "operate", payload: { command: { action: "complete", expectedRevision: 2, payload: {} } } },
      { action: "operate", payload: { command: { action: "cancel", expectedRevision: 2, payload: {} } } },
      { action: "operate", payload: { command: { action: "reschedule", expectedRevision: 2, payload: { scheduledAt: "2026-10-28T10:00:00Z", plannedEndAt: "2026-10-28T09:00:00Z" } } } }]) {
      expect(() => branch.readBranchCommand({ ...base, action: "claim", payload: {}, ...bad })).toThrow();
    }
  });
  it("commands only requests of an own lead group", async () => {
    const receipt = { commandId: CMD, committedRevision: 4, request: request({ status: "assigned", revision: 4, execution: { operationId: OP, owner: "logistics", ownerId: OP, status: "assigned", revision: 2,
      assigneeId: EXEC, assignee: "Pristavovač", scheduledAt: at, plannedEndAt: null, confirmedAt: null, startedAt: null, finishedAt: null, done: false, cancelled: false } }) };
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "motorist_branch_workspace") return { data: workspace({ requests: (args.p_filters as { id: string }).id === R2 ? [request({ id: R2, groupId: GB })] : [request()] }), error: null };
      if (name === "motorist_branch_command") return { data: receipt, error: null };
      return { data: null, error: { code: "PGRST202" } };
    });
    const result = await branch.commandFieldBranch(actor, { commandId: CMD, requestId: R1, expectedRevision: 3, action: "materialize", payload: { assigneeId: EXEC } });
    expect(result).toMatchObject({ commandId: CMD, committedRevision: 4, request: { status: "assigned", execution: { assigneeId: EXEC, owner: "logistics" } } });
    expect(mocks.rpc).toHaveBeenCalledWith("motorist_branch_command", { p_user_id: USER, p_organization_id: ORG, p_command: { commandId: CMD, action: "materialize", requestId: R1, expectedRevision: 3, payload: { assigneeId: EXEC } } });
    await expect(branch.commandFieldBranch(actor, { commandId: CMD, requestId: R2, expectedRevision: 3, action: "claim", payload: {} })).rejects.toMatchObject({ status: 404 });
  });
});
