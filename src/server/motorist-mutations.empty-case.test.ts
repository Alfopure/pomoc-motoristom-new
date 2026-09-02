import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  existingCase: null as Record<string, unknown> | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/task-notifications", () => ({
  cancelPendingTaskReminders: vi.fn(),
  createDefaultTaskReminder: vi.fn(),
  createTaskAssignmentNotification: vi.fn(),
  latestTaskReminderChannels: vi.fn(),
}));
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

  const result = () => {
    if (table === "motorist_organizations") {
      return { data: { id: "org-1", slug: "pomoc-motoristom", name: "PM", active: true }, error: null };
    }
    if (table === "motorist_profiles") {
      return { data: { id: "owner-1" }, error: null };
    }
    if (table === "motorist_cases" && operation === "select") {
      return { data: [], error: null };
    }
    if (table === "motorist_contacts" && operation === "select") {
      return { data: { id: "contact-old", organization_id: "org-1", name: "Old", phone: "+421900000000", email: null, notes: null }, error: null };
    }
    if (table === "motorist_vehicles" && operation === "select") {
      return {
        data: {
          id: "vehicle-old",
          organization_id: "org-1",
          license_plate: "OLD",
          vin: null,
          make: "Old make",
          model: "Old model",
          category: "car",
          transmission: null,
          production_year: null,
          color: null,
          drive_type: null,
          weight_kg: null,
          is_driveable: null,
          notes: null,
        },
        error: null,
      };
    }
    return {
      data: {
        id: `${table}-1`,
        created_at: "2026-07-20T10:00:00.000Z",
        updated_at: "2026-07-20T10:00:00.000Z",
        ...payload,
      },
      error: null,
    };
  };

  const query = {
    select: () => query,
    eq: () => query,
    like: () => query,
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
    maybeSingle: async () => (table === "motorist_cases" && state.existingCase ? { data: state.existingCase, error: null } : result()),
    then: (resolve: (value: ReturnType<typeof result>) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject),
  };

  return query;
}

import { assignCase, createCase, runCaseAction, updateCase } from "./motorist-mutations";

function existingCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "case-1",
    organization_id: "org-1",
    case_number: "PM-2026-0001",
    status: "new",
    priority: "normal",
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

describe("createCase empty draft", () => {
  beforeEach(() => {
    state.inserts.length = 0;
    state.updates.length = 0;
    state.existingCase = null;
  });

  it("creates only the case shell and does not create related entities or ETA tasks", async () => {
    const { caseRow, warnings } = await createCase({});
    const caseInsert = state.inserts.find((entry) => entry.table === "motorist_cases");

    expect(caseRow.id).toBe("motorist_cases-1");
    expect(warnings).toEqual([]);
    expect(caseInsert?.payload).toMatchObject({
      organization_id: "org-1",
      case_number: "PM-2026-0001",
      status: "new",
      priority: "normal",
      owner_id: "owner-1",
      contact_id: null,
      vehicle_id: null,
      pickup_location_id: null,
      destination_location_id: null,
      selected_asset_id: null,
      source_type: null,
      case_type: null,
    });
    expect(state.inserts.some((entry) => entry.table === "motorist_contacts")).toBe(false);
    expect(state.inserts.some((entry) => entry.table === "motorist_vehicles")).toBe(false);
    expect(state.inserts.some((entry) => entry.table === "motorist_locations")).toBe(false);
    expect(state.inserts.some((entry) => entry.table === "motorist_case_tasks")).toBe(false);
  });

  it("saves malformed draft values and reports them as warnings", async () => {
    const { warnings } = await createCase({ contactPhone: "123", vin: "short" });

    expect(warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(["invalid_phone", "invalid_vin"]));
  });

  it("stores partial secondary contacts instead of silently discarding them", async () => {
    const { warnings } = await createCase({
      contacts: [
        { name: "Ján Novák", phone: "+421900123456", isPrimary: true },
        { name: "Majiteľ vozidla", phone: "", role: "owner" },
        { email: "asistencia@example.com", phone: "", role: "assistance" },
      ],
    });
    const caseInsert = state.inserts.find((entry) => entry.table === "motorist_cases");
    const customerDetails = caseInsert?.payload.customer_details as { contacts?: Array<Record<string, unknown>> };

    expect(customerDetails.contacts).toEqual([
      expect.objectContaining({ name: "Ján Novák", phone: "+421900123456", isPrimary: true }),
      expect.objectContaining({ name: "Majiteľ vozidla", phone: "", role: "owner" }),
      expect.objectContaining({ email: "asistencia@example.com", phone: "", role: "assistance" }),
    ]);
    expect(warnings.filter((warning) => warning.code === "incomplete_contact")).toHaveLength(2);
  });

  it("persists the problem and vehicle note in separate stable channels", async () => {
    await createCase({ vehicleIssue: "Defekt predného kolesa", vehicleNote: "Disk je poškodený", vehicleMake: "Škoda" });

    expect(state.inserts.find((entry) => entry.table === "motorist_vehicles")?.payload).toMatchObject({
      notes: "Defekt predného kolesa",
    });
    expect(state.inserts.find((entry) => entry.table === "motorist_cases")?.payload).toMatchObject({
      vehicle_details: expect.objectContaining({ note: "Disk je poškodený" }),
      incident_details: expect.objectContaining({ description: "Defekt predného kolesa" }),
    });
  });
});

describe("updateCase optional relations", () => {
  beforeEach(() => {
    state.inserts.length = 0;
    state.updates.length = 0;
    state.existingCase = existingCase();
  });

  it("creates missing contact, vehicle and pickup when the draft is completed later", async () => {
    await updateCase("case-1", {
      contactName: "Ján Novák",
      contactPhone: "+421 900 123 456",
      licensePlate: "ba123xy",
      pickup: { label: "D1", address: "D1, Bratislava", lat: 48.1, lng: 17.1 },
    });

    expect(state.inserts.some((entry) => entry.table === "motorist_contacts")).toBe(true);
    expect(state.inserts.some((entry) => entry.table === "motorist_vehicles")).toBe(true);
    expect(state.inserts.some((entry) => entry.table === "motorist_locations")).toBe(true);
    expect(state.updates.find((entry) => entry.table === "motorist_cases")?.payload).toMatchObject({
      contact_id: "motorist_contacts-1",
      vehicle_id: "motorist_vehicles-1",
      pickup_location_id: "motorist_locations-1",
      destination_location_id: null,
    });
  });

  it("unlinks cleared relations without deleting shared records", async () => {
    state.existingCase = existingCase({
      contact_id: "contact-old",
      vehicle_id: "vehicle-old",
      pickup_location_id: "pickup-old",
      destination_location_id: "destination-old",
    });

    await updateCase("case-1", {
      contactName: "",
      contactPhone: "",
      contactEmail: "",
      contacts: [],
      licensePlate: "",
      vin: "",
      vehicleMake: "",
      vehicleModel: "",
      vehicleCategory: "",
      vehicleIssue: "",
      vehicleNote: "",
      productionYear: null,
      weightKg: null,
      pickup: null,
      destination: null,
    });

    expect(state.updates.find((entry) => entry.table === "motorist_cases")?.payload).toMatchObject({
      contact_id: null,
      vehicle_id: null,
      pickup_location_id: null,
      destination_location_id: null,
    });
    expect(state.updates.some((entry) => entry.table === "motorist_contacts" && entry.payload.deleted_at)).toBe(false);
    expect(state.updates.some((entry) => entry.table === "motorist_vehicles" && entry.payload.deleted_at)).toBe(false);
  });

  it("persists a manually entered location without fabricating coordinates", async () => {
    await updateCase("case-1", {
      manualPickupAddress: "R1, smer Nitra, približne pri 42. kilometri",
      pickup: null,
    });

    expect(state.inserts.some((entry) => entry.table === "motorist_locations")).toBe(false);
    expect(state.updates.find((entry) => entry.table === "motorist_cases")?.payload).toMatchObject({
      pickup_location_id: null,
      location_details: expect.objectContaining({
        manualPickupAddress: "R1, smer Nitra, približne pri 42. kilometri",
      }),
    });
  });

  it("allows cancelling an otherwise empty case", async () => {
    await updateCase("case-1", { status: "cancelled" });
    expect(state.updates.find((entry) => entry.table === "motorist_cases")?.payload).toMatchObject({ status: "cancelled" });
  });

  it("keeps the existing license plate in the summary when only the case type changes", async () => {
    state.existingCase = existingCase({ vehicle_id: "vehicle-old", case_type: "Pôvodný typ", summary: "Pôvodný typ · OLD" });

    await updateCase("case-1", { caseType: "Nový typ" });

    expect(state.updates.find((entry) => entry.table === "motorist_cases")?.payload).toMatchObject({
      case_type: "Nový typ",
      summary: "Nový typ · OLD",
    });
  });

  it("explicitly clears nullable selector values and job types", async () => {
    state.existingCase = existingCase({
      case_type: "Odťah",
      source_type: "client",
      vehicle_id: "vehicle-old",
      customer_details: { type: "private_person" },
      vehicle_details: { jobTypes: ["tow"], vehicleType: "passenger" },
      incident_details: { type: "breakdown" },
      location_details: { placeType: "road" },
      payment_details: { method: "cash", status: "unpaid" },
      closure_details: { type: "self_payer" },
    });

    await updateCase("case-1", {
      caseType: null,
      closureType: null,
      customerType: null,
      incidentType: null,
      jobTypes: [],
      paymentMethod: null,
      paymentStatus: null,
      placeType: null,
      sourceType: null,
      transmission: null,
      vehicleType: null,
    });

    const caseUpdate = state.updates.find((entry) => entry.table === "motorist_cases")?.payload;
    expect(caseUpdate).toMatchObject({
      case_type: null,
      source_type: null,
      summary: "OLD",
      customer_details: expect.objectContaining({ type: null }),
      vehicle_details: expect.objectContaining({ jobTypes: [], vehicleType: null }),
      incident_details: expect.objectContaining({ type: null }),
      location_details: expect.objectContaining({ placeType: null }),
      payment_details: expect.objectContaining({ method: null, status: null }),
      closure_details: expect.objectContaining({ type: null }),
    });
    expect(state.updates.find((entry) => entry.table === "motorist_vehicles")?.payload).toMatchObject({ transmission: null });
  });

  it("creates a minimal vehicle relation when only driveability is known", async () => {
    await updateCase("case-1", {
      vehicleDriveable: false,
      vehicleConditionFlags: ["immobile", "after_accident"],
    });

    expect(state.inserts.find((entry) => entry.table === "motorist_vehicles")?.payload).toMatchObject({ is_driveable: false });
    expect(state.updates.find((entry) => entry.table === "motorist_cases")?.payload).toMatchObject({
      vehicle_id: "motorist_vehicles-1",
      vehicle_details: expect.objectContaining({ conditionFlags: ["immobile", "after_accident"] }),
    });
  });

  it("does not grow the canonical problem text on repeated updates", async () => {
    state.existingCase = existingCase({ vehicle_id: "vehicle-old" });

    await updateCase("case-1", { vehicleIssue: "Defekt", incidentDescription: "Defekt", vehicleNote: "Poškodený disk" });
    await updateCase("case-1", { vehicleIssue: "Defekt", incidentDescription: "Defekt", vehicleNote: "Poškodený disk" });

    const vehicleUpdates = state.updates.filter((entry) => entry.table === "motorist_vehicles");
    expect(vehicleUpdates).toHaveLength(2);
    expect(vehicleUpdates.map((entry) => entry.payload.notes)).toEqual(["Defekt", "Defekt"]);
  });
});

describe("case action readiness", () => {
  beforeEach(() => {
    state.inserts.length = 0;
    state.updates.length = 0;
    state.existingCase = existingCase();
  });

  it("blocks assignment without a pickup", async () => {
    await expect(assignCase("case-1", { assetId: "asset-1" })).rejects.toMatchObject({
      status: 409,
      code: "CASE_PICKUP_REQUIRED",
    });
  });

  it("blocks a tow assignment without a destination", async () => {
    state.existingCase = existingCase({ pickup_location_id: "pickup-1", vehicle_details: { jobTypes: ["tow"] } });
    await expect(assignCase("case-1", { assetId: "asset-1" })).rejects.toMatchObject({
      status: 409,
      code: "CASE_DESTINATION_REQUIRED",
    });
  });

  it("blocks call workflow without a usable phone", async () => {
    await expect(runCaseAction("case-1", { action: "call_customer" })).rejects.toMatchObject({
      status: 409,
      code: "CASE_PHONE_REQUIRED",
    });
  });
});
