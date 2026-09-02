import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  existingCase: null as Record<string, unknown> | null,
  existingTask: null as Record<string, unknown> | null,
}));

const reminderMocks = vi.hoisted(() => ({
  cancelPendingTaskReminders: vi.fn(),
  createDefaultTaskReminder: vi.fn(),
  createTaskAssignmentNotification: vi.fn(),
  latestTaskReminderChannels: vi.fn(async (): Promise<Array<"in_app" | "email"> | null> => null),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/task-notifications", () => reminderMocks);
vi.mock("@/server/integrations/swhouse/occupancy-snapshot", () => ({
  deriveReplacementOccupancy: vi.fn(),
  isOccupiedAssignmentBlocked: vi.fn(() => false),
  isUnverifiedAssignmentBlocked: vi.fn(() => false),
  loadLatestOccupancySnapshot: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: (table: string) => makeQuery(table),
  }),
}));

function makeQuery(table: string) {
  let operation: "select" | "insert" | "update" = "select";
  let payload: Record<string, unknown> = {};
  const filters: Record<string, unknown> = {};

  const result = () => {
    if (table === "motorist_organizations") {
      return { data: { id: "org-1", slug: "pomoc-motoristom", name: "PM", active: true }, error: null };
    }
    if (table === "motorist_profiles") {
      // Echo the requested profile id so the acting profile stays distinguishable from the case owner.
      return { data: { id: (filters.id as string) ?? "owner-1", active: true }, error: null };
    }
    if (table === "motorist_cases" && operation === "select") {
      return { data: state.existingCase, error: null };
    }
    if (table === "motorist_case_tasks" && operation === "select") {
      return { data: state.existingTask, error: null };
    }
    return {
      data: {
        id: `${table}-1`,
        created_at: "2026-08-13T10:00:00.000Z",
        updated_at: "2026-08-13T10:00:00.000Z",
        ...payload,
      },
      error: null,
    };
  };

  const query = {
    select: () => query,
    eq: (column: string, value: unknown) => {
      filters[column] = value;
      return query;
    },
    in: () => query,
    like: () => query,
    ilike: () => query,
    order: () => query,
    limit: () => query,
    insert: (nextPayload: Record<string, unknown>) => {
      operation = "insert";
      payload = nextPayload;
      state.inserts.push({ table, payload: nextPayload });
      return query;
    },
    update: (nextPayload: Record<string, unknown>) => {
      operation = "update";
      payload = nextPayload;
      state.updates.push({ table, payload: nextPayload });
      return query;
    },
    single: async () => result(),
    maybeSingle: async () => result(),
    then: (resolve: (value: ReturnType<typeof result>) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject),
  };

  return query;
}

import { runCaseAction, updateCase } from "./motorist-mutations";

function existingCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "case-1",
    organization_id: "org-1",
    case_number: "PM-2026-0001",
    status: "new",
    priority: "urgent",
    source_type: null,
    case_type: null,
    owner_id: "owner-1",
    contact_id: null,
    vehicle_id: null,
    pickup_location_id: null,
    destination_location_id: null,
    selected_asset_id: null,
    summary: null,
    main_note: null,
    customer_details: {},
    vehicle_details: {},
    incident_details: {},
    location_details: {},
    replacement_vehicle_details: {},
    payment_details: {},
    closure_details: {},
    attachments_metadata: [],
    created_at: "2026-07-20T10:00:00.000Z",
    updated_at: "2026-07-20T10:00:00.000Z",
    closed_at: null,
  ...overrides,
  };
}

function existingTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    organization_id: "org-1",
    case_id: "case-1",
    title: "Zavolať zákazníkovi",
    assigned_to: "owner-1",
    due_at: "2026-08-13T10:00:00.000Z",
    status: "open",
    priority: "normal",
    kind: "callback",
    created_by: "owner-1",
    completed_by: null,
    completed_at: null,
    created_at: "2026-08-13T09:00:00.000Z",
    updated_at: "2026-08-13T09:00:00.000Z",
    ...overrides,
  };
}

function futureIso(minutes: number) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

describe("runCaseAction task actor attribution (U-09)", () => {
  beforeEach(() => {
    state.inserts.length = 0;
    state.updates.length = 0;
    state.existingCase = existingCase();
    state.existingTask = existingTask();
    reminderMocks.cancelPendingTaskReminders.mockClear();
    reminderMocks.createDefaultTaskReminder.mockClear();
    reminderMocks.createTaskAssignmentNotification.mockClear();
    reminderMocks.latestTaskReminderChannels.mockClear();
    reminderMocks.latestTaskReminderChannels.mockResolvedValue(null);
  });

  it("records the acting profile, not the case owner, when creating a task", async () => {
    await runCaseAction(
      "case-1",
      { action: "create_task", taskTitle: "Zavolať klientovi", taskKind: "callback", taskPriority: "low", assignedTo: "unassigned", taskDueAt: futureIso(60) },
      "actor-9",
    );

    const taskInsert = state.inserts.find((entry) => entry.table === "motorist_case_tasks");
    expect(taskInsert?.payload).toMatchObject({ created_by: "actor-9", assigned_to: null, priority: "low" });

    const eventInsert = state.inserts.find((entry) => entry.table === "motorist_case_events");
    expect(eventInsert?.payload).toMatchObject({ actor_profile_id: "actor-9" });

    const auditInsert = state.inserts.find((entry) => entry.table === "motorist_audit_log");
    expect(auditInsert?.payload).toMatchObject({ actor_profile_id: "actor-9" });
  });

  it("keeps the case owner as actor fallback when no acting profile is provided", async () => {
    await runCaseAction("case-1", { action: "create_task", taskTitle: "Bez aktéra", taskKind: "other", assignedTo: "unassigned", taskDueAt: futureIso(60) });

    const taskInsert = state.inserts.find((entry) => entry.table === "motorist_case_tasks");
    expect(taskInsert?.payload).toMatchObject({ created_by: "owner-1" });
  });

  it("defaults a new task to normal priority even on an urgent case (U-10)", async () => {
    await runCaseAction("case-1", { action: "create_task", taskTitle: "Bez priority", taskKind: "documents", assignedTo: "unassigned", taskDueAt: futureIso(60) }, "actor-9");

    const taskInsert = state.inserts.find((entry) => entry.table === "motorist_case_tasks");
    expect(taskInsert?.payload).toMatchObject({ priority: "normal" });
  });

  it("creates immediate attention for the operator receiving a task", async () => {
    await runCaseAction(
      "case-1",
      { action: "create_task", taskTitle: "Nová pridelená úloha", taskKind: "other", assignedTo: "operator-2", taskDueAt: futureIso(60) },
      "actor-9",
    );

    expect(reminderMocks.createTaskAssignmentNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: "org-1", caseId: "case-1" }),
    );
  });

  it("records the acting profile as completer for complete_task", async () => {
    await runCaseAction("case-1", { action: "complete_task", taskId: "task-1" }, "actor-9");

    const taskUpdate = state.updates.find((entry) => entry.table === "motorist_case_tasks");
    expect(taskUpdate?.payload).toMatchObject({ status: "done", completed_by: "actor-9" });
    expect(taskUpdate?.payload.completed_at).toBeTruthy();

    const eventInsert = state.inserts.find((entry) => entry.table === "motorist_case_events");
    expect(eventInsert?.payload).toMatchObject({ actor_profile_id: "actor-9", event_type: "task_done" });
  });

  it("records the acting profile as completer when update_task marks the task done", async () => {
    await runCaseAction("case-1", { action: "update_task", taskId: "task-1", taskStatus: "done" }, "actor-9");

    const taskUpdate = state.updates.find((entry) => entry.table === "motorist_case_tasks");
    expect(taskUpdate?.payload).toMatchObject({ status: "done", completed_by: "actor-9" });
  });

  it("preserves the previous email reminder channel when the deadline changes (U-03)", async () => {
    reminderMocks.latestTaskReminderChannels.mockResolvedValue(["in_app", "email"]);

    await runCaseAction("case-1", { action: "update_task", taskId: "task-1", taskDueAt: futureIso(120) }, "actor-9");

    expect(reminderMocks.latestTaskReminderChannels).toHaveBeenCalledTimes(1);
    expect(reminderMocks.createDefaultTaskReminder).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        createdBy: "actor-9",
        channels: expect.arrayContaining(["in_app", "email"]),
      }),
    );
  });

  it("records a case note with the acting profile (P-02)", async () => {
    await runCaseAction("case-1", { action: "add_note", note: "Klient volal, auto je pri kostole." }, "actor-9");

    const eventInsert = state.inserts.find((entry) => entry.table === "motorist_case_events");
    expect(eventInsert?.payload).toMatchObject({
      actor_profile_id: "actor-9",
      event_type: "note_added",
      body: "Klient volal, auto je pri kostole.",
    });
  });

  it("rejects an empty case note", async () => {
    await expect(runCaseAction("case-1", { action: "add_note", note: "   " }, "actor-9")).rejects.toMatchObject({ status: 400 });
  });
});

describe("updateCase activity history (P-01)", () => {
  beforeEach(() => {
    state.inserts.length = 0;
    state.updates.length = 0;
    state.existingCase = existingCase();
    state.existingTask = existingTask();
  });

  it("records a status change attributed to the acting profile", async () => {
    await updateCase("case-1", { status: "cancelled" }, "actor-9");

    const caseUpdate = state.updates.find((entry) => entry.table === "motorist_cases");
    expect(caseUpdate?.payload).toMatchObject({ status: "cancelled" });

    const eventInsert = state.inserts.find((entry) => entry.table === "motorist_case_events");
    expect(eventInsert?.payload).toMatchObject({
      actor_profile_id: "actor-9",
      event_type: "status_changed",
    });
    expect(String(eventInsert?.payload.body)).toContain("Zrušené");
  });

  it("can reopen a cancelled case back into work", async () => {
    state.existingCase = existingCase({ status: "cancelled" });

    await updateCase("case-1", { status: "open" }, "actor-9");

    expect(state.updates.find((entry) => entry.table === "motorist_cases")?.payload).toMatchObject({ status: "open" });
    expect(String(state.inserts.find((entry) => entry.table === "motorist_case_events")?.payload.body)).toContain("Otvorený");
  });

  it("does not write any activity event when nothing changed", async () => {
    await updateCase("case-1", {}, "actor-9");

    expect(state.inserts.some((entry) => entry.table === "motorist_case_events")).toBe(false);
  });

  it("describes which field groups changed", async () => {
    await updateCase("case-1", { caseType: "Odťah" }, "actor-9");

    const eventInsert = state.inserts.find((entry) => entry.table === "motorist_case_events");
    expect(eventInsert?.payload).toMatchObject({ event_type: "case_updated" });
    expect(String(eventInsert?.payload.body)).toContain("typ zásahu");
  });
});
