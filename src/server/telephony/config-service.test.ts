import { describe, expect, it } from "vitest";

import { createTelephonyHarness, GROUPS, LINES, NUMBERS, ORG, PLAN_ID, PROFILES } from "@/test/telephony-harness";

import {
  compactDiff,
  contextFromDocument,
  DEFAULT_SETTINGS,
  getRoutingDocument,
  parseRingGroups,
  parseRingPlans,
  replaceBusinessHours,
  replacePauseReasons,
  replaceRingGroups,
  replaceRingPlans,
  updateOperatorTelephonySettings,
  updateTelephonyLine,
  updateTelephonySettings,
  validateBusinessHours,
  validateLinePatch,
  validateOperatorSettingsPatch,
  validatePauseReasons,
  validateRoutingReplace,
  validateSettingsPatch,
  type ConfigActor,
  type RingGroupInput,
  type RingPlanInput,
  type ValidationContext,
} from "./config-service";

const ACTOR: ConfigActor = { profileId: PROFILES.o4, role: "manager", displayName: "Manažér" };
const GROUP_A = "00000000-0000-4000-8000-000000009001";
const GROUP_B = "00000000-0000-4000-8000-000000009002";
const PLAN_A = "00000000-0000-4000-8000-000000009101";
const FOREIGN = "00000000-0000-4000-8000-0000000099ff";

// ---------------------------------------------------------------------------
// Validation matrix (pure — no database)
// ---------------------------------------------------------------------------

function group(overrides: Partial<RingGroupInput> = {}): RingGroupInput {
  return {
    id: GROUP_A,
    name: "Dispečing A",
    description: null,
    active: true,
    members: [{ id: null, memberKind: "operator", profileId: PROFILES.o1, externalNumber: null, position: 0, ringSecs: null }],
    ...overrides,
  };
}

function plan(overrides: Partial<RingPlanInput> = {}): RingPlanInput {
  return {
    id: PLAN_A,
    name: "Denný",
    fallbackKind: "callback_prompt",
    fallbackNumber: null,
    active: true,
    steps: [{ id: null, stepIndex: 0, ringGroupId: GROUP_A, timeoutSecs: 20, strategy: "all" }],
    ...overrides,
  };
}

function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    organizationId: ORG,
    profileIds: new Set([PROFILES.o1, PROFILES.o2, PROFILES.o3]),
    lineIds: new Set([LINES.neutral]),
    ivrMenuIds: new Set<string>(),
    businessHoursIds: new Set<string>(),
    ringPlanIds: new Set([PLAN_A]),
    businessHoursInUse: new Set<string>(),
    ringPlansInUse: new Set<string>(),
    destinationAllowlist: ["SK", "CZ"],
    groups: [group()],
    plans: [plan()],
    ...overrides,
  };
}

function codes(issues: Array<{ code: string }>): string[] {
  return issues.map((issue) => issue.code);
}

describe("validateRoutingReplace", () => {
  it("accepts the seeded world unchanged", () => {
    expect(validateRoutingReplace({ groups: [group()], plans: [plan()] }, context())).toEqual([]);
  });

  it("refuses a plan without a single step", () => {
    const issues = validateRoutingReplace({ plans: [plan({ steps: [] })] }, context());
    expect(codes(issues)).toContain("plan_empty");
    expect(issues[0].message).toBe("Plán zvonenia potrebuje aspoň jeden krok.");
  });

  it("refuses step timeouts outside 5–120 s", () => {
    expect(codes(validateRoutingReplace({ plans: [plan({ steps: [{ id: null, stepIndex: 0, ringGroupId: GROUP_A, timeoutSecs: 4, strategy: "all" }] })] }, context()))).toContain("timeout_too_low");
    expect(codes(validateRoutingReplace({ plans: [plan({ steps: [{ id: null, stepIndex: 0, ringGroupId: GROUP_A, timeoutSecs: 121, strategy: "all" }] })] }, context()))).toContain("timeout_too_high");
  });

  it("refuses a member ring time below the 5 s floor and above 120 s", () => {
    const low = group({ members: [{ id: null, memberKind: "operator", profileId: PROFILES.o1, externalNumber: null, position: 0, ringSecs: 4 }] });
    const high = group({ members: [{ id: null, memberKind: "operator", profileId: PROFILES.o1, externalNumber: null, position: 0, ringSecs: 121 }] });
    expect(codes(validateRoutingReplace({ groups: [low] }, context()))).toContain("ring_secs_too_low");
    expect(codes(validateRoutingReplace({ groups: [high] }, context()))).toContain("ring_secs_too_high");
  });

  it("refuses an empty group that a step still uses", () => {
    const issues = validateRoutingReplace({ groups: [group({ members: [] })] }, context());
    expect(codes(issues)).toContain("group_empty");
  });

  it("refuses duplicate and non-contiguous positions in a group and in a plan", () => {
    const duplicated = group({
      members: [
        { id: null, memberKind: "operator", profileId: PROFILES.o1, externalNumber: null, position: 0, ringSecs: null },
        { id: null, memberKind: "operator", profileId: PROFILES.o2, externalNumber: null, position: 0, ringSecs: null },
      ],
    });
    expect(codes(validateRoutingReplace({ groups: [duplicated] }, context()))).toContain("duplicate_position");

    const gapped = group({
      members: [
        { id: null, memberKind: "operator", profileId: PROFILES.o1, externalNumber: null, position: 0, ringSecs: null },
        { id: null, memberKind: "operator", profileId: PROFILES.o2, externalNumber: null, position: 2, ringSecs: null },
      ],
    });
    expect(codes(validateRoutingReplace({ groups: [gapped] }, context()))).toContain("position_gap");

    const duplicatedSteps = plan({
      steps: [
        { id: null, stepIndex: 0, ringGroupId: GROUP_A, timeoutSecs: 20, strategy: "all" },
        { id: null, stepIndex: 0, ringGroupId: GROUP_A, timeoutSecs: 20, strategy: "ordered" },
      ],
    });
    expect(codes(validateRoutingReplace({ plans: [duplicatedSteps] }, context()))).toContain("duplicate_position");
  });

  it("refuses an external member that is not E.164", () => {
    const invalid = group({ members: [{ id: null, memberKind: "external_number", profileId: null, externalNumber: "klapka 12", position: 0, ringSecs: null }] });
    expect(codes(validateRoutingReplace({ groups: [invalid] }, context()))).toContain("number_invalid");
  });

  it("refuses an external member outside the destination allowlist", () => {
    const foreignNumber = group({ members: [{ id: null, memberKind: "external_number", profileId: null, externalNumber: "+15551234567", position: 0, ringSecs: null }] });
    const issues = validateRoutingReplace({ groups: [foreignNumber] }, context());
    expect(codes(issues)).toContain("number_not_allowed");
    expect(issues[0].message).toContain("+15551234567");
  });

  it("accepts a Czech external member because CZ is on the allowlist", () => {
    const czech = group({ members: [{ id: null, memberKind: "external_number", profileId: null, externalNumber: "+420601123456", position: 0, ringSecs: 15 }] });
    expect(validateRoutingReplace({ groups: [czech] }, context())).toEqual([]);
  });

  it("refuses a member profile and a step group from another organisation", () => {
    const foreignMember = group({ members: [{ id: null, memberKind: "operator", profileId: FOREIGN, externalNumber: null, position: 0, ringSecs: null }] });
    expect(codes(validateRoutingReplace({ groups: [foreignMember] }, context()))).toContain("profile_foreign");

    const foreignGroup = plan({ steps: [{ id: null, stepIndex: 0, ringGroupId: FOREIGN, timeoutSecs: 20, strategy: "all" }] });
    expect(codes(validateRoutingReplace({ plans: [foreignGroup] }, context()))).toContain("group_unknown");
  });

  it("refuses an operator member without a profile and an external member with one", () => {
    const noProfile = group({ members: [{ id: null, memberKind: "operator", profileId: null, externalNumber: null, position: 0, ringSecs: null }] });
    expect(codes(validateRoutingReplace({ groups: [noProfile] }, context()))).toContain("profile_required");

    const mixed = group({ members: [{ id: null, memberKind: "external_number", profileId: PROFILES.o1, externalNumber: "+421900000000", position: 0, ringSecs: null }] });
    expect(codes(validateRoutingReplace({ groups: [mixed] }, context()))).toContain("member_shape");
  });

  it("refuses the same operator twice in one group", () => {
    const twice = group({
      members: [
        { id: null, memberKind: "operator", profileId: PROFILES.o1, externalNumber: null, position: 0, ringSecs: null },
        { id: null, memberKind: "operator", profileId: PROFILES.o1, externalNumber: null, position: 1, ringSecs: null },
      ],
    });
    expect(codes(validateRoutingReplace({ groups: [twice] }, context()))).toContain("duplicate_member");
  });

  it("refuses duplicate group and plan names", () => {
    expect(codes(validateRoutingReplace({ groups: [group(), group({ id: GROUP_B })] }, context()))).toContain("duplicate_name");
    expect(codes(validateRoutingReplace({ plans: [plan(), plan({ id: "00000000-0000-4000-8000-000000009102" })] }, context()))).toContain("duplicate_name");
  });

  it("requires an allowlisted E.164 fallback for the external_number fallback", () => {
    expect(codes(validateRoutingReplace({ plans: [plan({ fallbackKind: "external_number", fallbackNumber: null })] }, context()))).toContain("fallback_number_invalid");
    expect(codes(validateRoutingReplace({ plans: [plan({ fallbackKind: "external_number", fallbackNumber: "+15551234567" })] }, context()))).toContain("fallback_number_not_allowed");
    expect(validateRoutingReplace({ plans: [plan({ fallbackKind: "external_number", fallbackNumber: "0900 000 000" })] }, context())).toEqual([]);
  });

  it("refuses removing a group a plan still uses and a plan a line still uses", () => {
    expect(codes(validateRoutingReplace({ groups: [] }, context()))).toContain("group_in_use");
    expect(codes(validateRoutingReplace({ plans: [] }, context({ ringPlansInUse: new Set([PLAN_A]) })))).toContain("plan_in_use");
  });
});

describe("validateBusinessHours / validatePauseReasons / patches", () => {
  it("validates weekdays, times and duplicate exception dates", () => {
    const issues = validateBusinessHours(
      [
        {
          id: null,
          name: "Pracovný čas",
          timezone: "Europe/Bratislava",
          active: true,
          intervals: [
            { weekday: 0, opens: "07:00", closes: "12:00" },
            { weekday: 1, opens: "19:00", closes: "07:00" },
            { weekday: 2, opens: "7:00", closes: "12:00" },
          ],
          exceptions: [
            { date: "2026-12-24", closed: true, intervals: [] },
            { date: "2026-12-24", closed: true, intervals: [] },
            { date: "24.12.2026", closed: true, intervals: [] },
          ],
        },
      ],
      context(),
    );
    expect(codes(issues)).toEqual(expect.arrayContaining(["weekday_invalid", "time_order", "time_invalid", "duplicate_date", "date_invalid"]));
  });

  it("refuses removing business hours a line still uses", () => {
    expect(codes(validateBusinessHours([], context({ businessHoursInUse: new Set(["hours-1"]) })))).toContain("business_hours_in_use");
  });

  it("validates pause reason codes", () => {
    const issues = validatePauseReasons([
      { id: null, code: "Obed!", label: "Obed", maxMinutes: 45, sortOrder: 0, active: true },
      { id: null, code: "porada", label: "", maxMinutes: 0, sortOrder: 10, active: true },
      { id: null, code: "porada", label: "Porada", maxMinutes: null, sortOrder: 20, active: true },
    ]);
    expect(codes(issues)).toEqual(expect.arrayContaining(["code_invalid", "label_required", "max_minutes_invalid", "duplicate_code"]));
  });

  it("keeps a line inside its own organisation", () => {
    expect(codes(validateLinePatch({ ringPlanId: FOREIGN }, context()))).toContain("plan_foreign");
    expect(codes(validateLinePatch({ ivrMenuId: FOREIGN }, context()))).toContain("ivr_foreign");
    expect(codes(validateLinePatch({ businessHoursId: FOREIGN }, context()))).toContain("hours_foreign");
    expect(validateLinePatch({ ringPlanId: PLAN_A, label: "Hlavná linka", active: true }, context())).toEqual([]);
  });

  it("validates the organisation settings patch", () => {
    expect(codes(validateSettingsPatch({ destinationAllowlist: [] }))).toContain("allowlist_empty");
    expect(codes(validateSettingsPatch({ destinationAllowlist: ["SK", "Mars"] }))).toContain("allowlist_entry_invalid");
    expect(codes(validateSettingsPatch({ parkMaxMinutes: 0 }))).toContain("park_invalid");
    expect(codes(validateSettingsPatch({ dailyLegSoftCap: -1 }))).toContain("cap_invalid");
    expect(validateSettingsPatch({ destinationAllowlist: ["SK", "+420"], parkMaxMinutes: 15, dailyLegSoftCap: 200 })).toEqual([]);
  });

  it("validates the per-operator settings patch", () => {
    expect(codes(validateOperatorSettingsPatch({ wrapUpSeconds: 601 }, context()))).toContain("wrap_up_invalid");
    expect(codes(validateOperatorSettingsPatch({ ringDeviceVolume: 101 }, context()))).toContain("volume_invalid");
    expect(codes(validateOperatorSettingsPatch({ defaultFromLineId: FOREIGN }, context()))).toContain("line_foreign");
    expect(validateOperatorSettingsPatch({ defaultFromLineId: LINES.neutral, wrapUpSeconds: 20 }, context())).toEqual([]);
  });
});

describe("payload parsing", () => {
  it("keeps only well-formed values and defaults positions to the array order", () => {
    const groups = parseRingGroups([
      { name: "  Dispečing A  ", members: [{ memberKind: "operator", profileId: PROFILES.o1 }, { memberKind: "external_number", externalNumber: " +421900000000 " }] },
    ]);
    expect(groups[0].name).toBe("Dispečing A");
    expect(groups[0].members.map((member) => member.position)).toEqual([0, 1]);
    expect(groups[0].members[1].externalNumber).toBe("+421900000000");
    expect(groups[0].id).toBeNull();
  });

  it("rejects a body that is not an array", () => {
    expect(() => parseRingPlans({ nope: true })).toThrow(/nie je pole/);
  });
});

// ---------------------------------------------------------------------------
// Transactional replace against the fake Supabase harness
// ---------------------------------------------------------------------------

function harnessDeps() {
  const harness = createTelephonyHarness();
  return { harness, deps: { admin: harness.admin } };
}

function auditRows(harness: ReturnType<typeof createTelephonyHarness>) {
  return harness.rows("motorist_audit_log");
}

describe("routing document read model", () => {
  it("returns groups with members, plans with steps, hours with intervals and exceptions", async () => {
    const { harness, deps } = harnessDeps();
    const document = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });

    expect(document.groups).toHaveLength(2);
    expect(document.groups.find((entry) => entry.id === GROUPS.a)?.members.map((member) => member.position)).toEqual([0, 1, 2]);
    expect(document.plans[0].steps.map((step) => step.stepIndex)).toEqual([0, 1]);
    expect(document.businessHours[0].intervals.length).toBeGreaterThan(0);
    expect(document.businessHours[0].exceptions[0].date).toBe("2026-12-24");
    expect(document.pauseReasons.map((reason) => reason.code)).toEqual(["obed"]);
    expect(document.lines.map((line) => line.phoneNumber)).toEqual([NUMBERS.neutral, NUMBERS.allianz]);
    expect(document.operators).toHaveLength(5);
    expect(document.settings?.destinationAllowlist).toEqual(["SK", "CZ"]);
    expect(harness.rows("motorist_ring_group_members")).toHaveLength(6);
  });

  it("hides the organisation settings from a member-level read", async () => {
    const { deps } = harnessDeps();
    const document = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: false });
    expect(document.settings).toBeNull();
  });

  it("falls back to the documented defaults when the settings row is missing", async () => {
    const { harness, deps } = harnessDeps();
    harness.db.delete("motorist_telephony_settings", () => true);
    const document = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });
    expect(document.settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe("replaceRingGroups", () => {
  it("reorders members, keeps their liveness stamps and writes one audit row", async () => {
    const { harness, deps } = harnessDeps();
    harness.db.update("motorist_ring_group_members", { last_offered_at: "2026-09-03T07:00:00.000Z" }, (row) => row.id === "00000000-0000-4000-8000-000000002222");

    const before = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });
    const groups = before.groups.map((entry) => {
      if (entry.id !== GROUPS.b) return { ...entry, members: entry.members.map((member) => ({ ...member })) };
      // Move the second operator to the front (drag and drop in the editor).
      const reordered = [entry.members[1], entry.members[0], entry.members[2]];
      return { ...entry, members: reordered.map((member, index) => ({ ...member, position: index })) };
    });

    const { document, diff } = await replaceRingGroups(deps, { organizationId: ORG, actor: ACTOR, groups });

    const groupB = document.groups.find((entry) => entry.id === GROUPS.b)!;
    expect(groupB.members.map((member) => member.profileId)).toEqual([PROFILES.o3, PROFILES.o4, null]);
    // The stamp travels with the member id, not with the position.
    expect(groupB.members[0].lastOfferedAt).toBe("2026-09-03T07:00:00.000Z");
    expect(groupB.members[1].lastOfferedAt).toBeNull();
    expect(diff.changed.map((entry) => entry.label)).toEqual(["Dispečing B"]);

    const audits = auditRows(harness);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ organization_id: ORG, actor_profile_id: ACTOR.profileId, action: "telephony.ring_groups.replace", entity_type: "telephony_config" });
  });

  it("adds a group with a client-generated id without touching the other groups", async () => {
    const { deps } = harnessDeps();
    const before = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });
    const groups = [
      ...before.groups,
      { id: GROUP_B, name: "Nočná služba", description: null, active: true, members: [{ id: null, memberKind: "operator" as const, profileId: PROFILES.o2, externalNumber: null, position: 0, ringSecs: 30, lastOfferedAt: null, lastAnsweredAt: null }] },
    ];

    const { document, diff } = await replaceRingGroups(deps, { organizationId: ORG, actor: ACTOR, groups });
    expect(diff.added).toEqual(["Nočná služba"]);
    expect(document.groups).toHaveLength(3);
    expect(document.groups.find((entry) => entry.id === GROUPS.a)?.members).toHaveLength(3);
  });

  it("refuses to delete a group a plan still uses (400, nothing written)", async () => {
    const { harness, deps } = harnessDeps();
    const before = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });

    await expect(replaceRingGroups(deps, { organizationId: ORG, actor: ACTOR, groups: before.groups.filter((entry) => entry.id !== GROUPS.b) })).rejects.toMatchObject({
      status: 400,
      code: "config_invalid",
    });
    expect(harness.rows("motorist_ring_groups")).toHaveLength(2);
    expect(auditRows(harness)).toHaveLength(0);
  });

  it("leaves the database untouched when the transaction fails inside the RPC", async () => {
    const { harness } = harnessDeps();
    const membersBefore = harness.rows("motorist_ring_group_members");

    // Two members on the same position: the unique index fires half way through
    // the insert; the RPC must roll the whole section back.
    const { error } = await harness.admin.rpc("motorist_replace_ring_plan", {
      p_organization_id: ORG,
      p_document: {
        groups: [
          {
            id: GROUPS.a,
            name: "Dispečing A",
            active: true,
            members: [
              { id: null, member_kind: "operator", profile_id: PROFILES.o1, external_number: null, position: 0, ring_secs: null },
              { id: null, member_kind: "operator", profile_id: PROFILES.o2, external_number: null, position: 0, ring_secs: null },
            ],
          },
          { id: GROUPS.b, name: "Dispečing B", active: true, members: [] },
        ],
      },
    });

    expect(error?.code).toBe("23505");
    expect(harness.rows("motorist_ring_group_members")).toEqual(membersBefore);
  });

  it("refuses a row that belongs to another organisation", async () => {
    const { harness } = harnessDeps();
    harness.db.seed("motorist_organizations", [{ id: FOREIGN, slug: "iny", name: "Iná organizácia", active: true }]);
    harness.db.seed("motorist_ring_groups", [{ id: GROUP_A, organization_id: FOREIGN, name: "Cudzia skupina", active: true }]);

    const { error } = await harness.admin.rpc("motorist_replace_ring_plan", {
      p_organization_id: ORG,
      p_document: { groups: [{ id: GROUP_A, name: "Ukradnutá", active: true, members: [] }] },
    });

    expect(error?.message).toMatch(/cross_organization/);
    expect(harness.db.find("motorist_ring_groups", (row) => row.id === GROUP_A)?.name).toBe("Cudzia skupina");
  });
});

describe("replaceRingPlans", () => {
  it("persists a new step timeout and orders the steps", async () => {
    const { harness, deps } = harnessDeps();
    const before = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });
    const plans = before.plans.map((entry) => ({
      ...entry,
      steps: entry.steps.map((step) => (step.stepIndex === 0 ? { ...step, timeoutSecs: 10 } : step)),
    }));

    const { document, diff } = await replaceRingPlans(deps, { organizationId: ORG, actor: ACTOR, plans });

    expect(document.plans[0].steps[0].timeoutSecs).toBe(10);
    expect(diff.changed[0].fields).toEqual(["steps"]);
    expect(harness.rows("motorist_ring_plan_steps")).toHaveLength(2);
    expect(auditRows(harness)[0].action).toBe("telephony.ring_plans.replace");
  });

  it("refuses to delete the plan the neutral line points at", async () => {
    const { harness, deps } = harnessDeps();
    await expect(replaceRingPlans(deps, { organizationId: ORG, actor: ACTOR, plans: [] })).rejects.toMatchObject({ status: 400 });
    expect(harness.rows("motorist_ring_plans")).toHaveLength(1);
  });

  it("keeps the plan of a call in progress frozen", async () => {
    const { harness, deps } = harnessDeps();
    const inbound = await harness.inbound();
    const frozenBefore = harness.session(inbound.sessionId).metadata;

    const before = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });
    await replaceRingPlans(deps, {
      organizationId: ORG,
      actor: ACTOR,
      plans: before.plans.map((entry) => ({ ...entry, steps: entry.steps.map((step) => ({ ...step, timeoutSecs: 60 })) })),
    });

    expect(harness.session(inbound.sessionId).metadata).toEqual(frozenBefore);
  });
});

describe("replaceBusinessHours and replacePauseReasons", () => {
  it("replaces intervals and exceptions in one call", async () => {
    const { harness, deps } = harnessDeps();
    const before = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });
    const businessHours = before.businessHours.map((hours) => ({
      ...hours,
      intervals: [{ weekday: 1, opens: "08:00", closes: "16:00" }],
      exceptions: [{ date: "2026-12-24", closed: true, intervals: [], label: "Štedrý deň" }],
    }));

    const { document } = await replaceBusinessHours(deps, { organizationId: ORG, actor: ACTOR, businessHours });

    expect(document.businessHours[0].intervals).toEqual([{ weekday: 1, opens: "08:00", closes: "16:00" }]);
    expect(harness.rows("motorist_business_hours_intervals")).toHaveLength(1);
    expect(auditRows(harness)[0].action).toBe("telephony.business_hours.replace");
  });

  it("adds and removes pause reasons", async () => {
    const { harness, deps } = harnessDeps();
    const { document, diff } = await replacePauseReasons(deps, {
      organizationId: ORG,
      actor: ACTOR,
      pauseReasons: [{ id: null, code: "porada", label: "Porada", maxMinutes: 60, sortOrder: 10, active: true }],
    });

    expect(document.pauseReasons.map((reason) => reason.code)).toEqual(["porada"]);
    expect(diff.removed).toEqual(["obed"]);
    expect(harness.rows("motorist_pause_reasons")).toHaveLength(1);
  });
});

describe("line, settings and operator patches", () => {
  it("updates a line and audits only the changed columns", async () => {
    const { harness, deps } = harnessDeps();
    const { line } = await updateTelephonyLine(deps, {
      organizationId: ORG,
      actor: ACTOR,
      lineId: LINES.allianz,
      patch: { label: "Allianz linka", partnerName: "Allianz", active: false },
    });

    expect(line.label).toBe("Allianz linka");
    expect(line.active).toBe(false);
    const audit = auditRows(harness)[0];
    expect(audit.action).toBe("telephony.line.update");
    expect(audit.entity_id).toBe(LINES.allianz);
    expect(audit.before_payload).toMatchObject({ label: "Allianz Assistance", active: true });
    expect(audit.after_payload).toMatchObject({ label: "Allianz linka", active: false });
  });

  it("refuses an unknown line and a foreign plan", async () => {
    const { deps } = harnessDeps();
    await expect(updateTelephonyLine(deps, { organizationId: ORG, actor: ACTOR, lineId: FOREIGN, patch: { label: "x" } })).rejects.toMatchObject({ status: 404 });
    await expect(updateTelephonyLine(deps, { organizationId: ORG, actor: ACTOR, lineId: LINES.neutral, patch: { ringPlanId: FOREIGN } })).rejects.toMatchObject({ status: 400 });
  });

  it("flips the kill switch and normalises the allowlist", async () => {
    const { harness, deps } = harnessDeps();
    const settings = await updateTelephonySettings(deps, { organizationId: ORG, actor: ACTOR, patch: { liveCallsEnabled: false, destinationAllowlist: ["sk"], parkMaxMinutes: 15 } });

    expect(settings).toMatchObject({ liveCallsEnabled: false, destinationAllowlist: ["SK"], parkMaxMinutes: 15 });
    expect(harness.db.find("motorist_telephony_settings", () => true)).toMatchObject({ live_calls_enabled: false, park_max_minutes: 15 });
    expect(auditRows(harness)[0].action).toBe("telephony.settings.update");
  });

  it("creates the per-operator settings row on first write", async () => {
    const { harness, deps } = harnessDeps();
    const settings = await updateOperatorTelephonySettings(deps, {
      organizationId: ORG,
      actor: ACTOR,
      profileId: PROFILES.o1,
      patch: { wrapUpSeconds: 45, autoAnswerOutbound: false, defaultFromLineId: LINES.allianz },
    });

    expect(settings).toEqual({ defaultFromLineId: LINES.allianz, wrapUpSeconds: 45, autoAnswerOutbound: false, ringDeviceVolume: 80 });
    expect(harness.rows("motorist_operator_telephony_settings")).toHaveLength(1);
    expect(auditRows(harness)[0]).toMatchObject({ action: "telephony.operator_settings.update", entity_id: PROFILES.o1 });
  });

  it("refuses settings for an operator of another organisation", async () => {
    const { deps } = harnessDeps();
    await expect(updateOperatorTelephonySettings(deps, { organizationId: ORG, actor: ACTOR, profileId: FOREIGN, patch: { wrapUpSeconds: 10 } })).rejects.toMatchObject({ status: 404 });
  });
});

describe("compactDiff", () => {
  it("reports additions, removals and changed fields only", () => {
    const diff = compactDiff(
      [
        { id: "a", name: "A", value: 1 },
        { id: "b", name: "B", value: 2 },
      ],
      [
        { id: "a", name: "A", value: 9 },
        { id: "c", name: "C", value: 3 },
      ],
      (row) => row.id,
      (row) => row.name,
      (row) => ({ name: row.name, value: row.value }),
    );

    expect(diff).toEqual({ added: ["C"], removed: ["B"], changed: [{ id: "a", label: "A", fields: ["value"] }] });
  });
});

describe("contextFromDocument", () => {
  it("derives the in-use sets from the lines", async () => {
    const { deps } = harnessDeps();
    const document = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });
    const derived = contextFromDocument(document);

    expect([...derived.ringPlansInUse]).toEqual([PLAN_ID]);
    expect(derived.profileIds.size).toBe(5);
    expect(derived.destinationAllowlist).toEqual(["SK", "CZ"]);
  });
});
