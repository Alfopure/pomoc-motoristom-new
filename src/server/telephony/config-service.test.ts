import { describe, expect, it } from "vitest";

import { createTelephonyHarness, GROUPS, LINES, NUMBERS, ORG, PLAN_ID, PROFILES } from "@/test/telephony-harness";

import {
  assertOperatorNotOnCall,
  compactDiff,
  contextFromDocument,
  DEFAULT_SETTINGS,
  destinationsOutsideAllowlist,
  getRoutingDocument,
  parseBusinessHours,
  parseLinePatch,
  parseOperatorSettingsPatch,
  parsePauseReasons,
  parseRingGroups,
  parseRingPlans,
  parseSettingsPatch,
  requireOperatorOfOrganization,
  replaceBusinessHours,
  replaceIvrMenus,
  replacePauseReasons,
  replaceRingGroups,
  replaceRingPlans,
  updateOperatorTelephonySettings,
  updateTelephonyLine,
  updateTelephonySettings,
  MAX_PAUSE_MINUTES,
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
    ivrMenusInUse: new Set<string>(),
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

  it("names the row when a member or a step id is repeated anywhere in the payload", () => {
    // Postgres answers a repeated id inside one upsert set with
    // "ON CONFLICT DO UPDATE command cannot affect row a second time" (or a PK
    // violation across two groups), which maps to no RPC message and comes back
    // as an opaque 500/409 naming nothing.
    const MEMBER = "00000000-0000-4000-8000-00000000a001";
    const STEP = "00000000-0000-4000-8000-00000000a002";
    const member = (position: number) => ({ id: MEMBER, memberKind: "operator" as const, profileId: PROFILES.o1, externalNumber: null, position, ringSecs: null });
    const twiceInOneGroup = validateRoutingReplace({ groups: [group({ members: [member(0), { ...member(1), profileId: PROFILES.o2 }] })] }, context());
    expect(codes(twiceInOneGroup)).toContain("duplicate_id");
    expect(twiceInOneGroup.find((issue) => issue.code === "duplicate_id")?.path).toBe("groups[0].members[1]");

    const acrossGroups = validateRoutingReplace(
      { groups: [group({ members: [member(0)] }), group({ id: GROUP_B, name: "Dispečing B", members: [member(0)] })] },
      context(),
    );
    expect(codes(acrossGroups)).toContain("duplicate_id");

    const steps = validateRoutingReplace(
      {
        plans: [
          plan({
            steps: [
              { id: STEP, stepIndex: 0, ringGroupId: GROUP_A, timeoutSecs: 20, strategy: "all" },
              { id: STEP, stepIndex: 1, ringGroupId: GROUP_A, timeoutSecs: 20, strategy: "all" },
            ],
          }),
        ],
      },
      context(),
    );
    expect(codes(steps)).toContain("duplicate_id");
    expect(steps.find((issue) => issue.code === "duplicate_id")?.path).toBe("plans[0].steps[1]");
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

  it("refuses an open exception without intervals (it would mean open around the clock)", () => {
    const hours = (exception: { closed?: boolean; intervals?: Array<{ opens: string; closes: string }> }) => [
      {
        id: null,
        name: "Pracovný čas",
        timezone: "Europe/Bratislava",
        active: true,
        intervals: [{ weekday: 1, opens: "07:00", closes: "19:00" }],
        exceptions: [{ date: "2026-12-24", ...exception }],
      },
    ];
    expect(codes(validateBusinessHours(hours({ closed: false, intervals: [] }), context()))).toContain("exception_intervals_required");
    expect(validateBusinessHours(hours({ closed: false, intervals: [{ opens: "09:00", closes: "12:00" }] }), context())).toEqual([]);
    expect(validateBusinessHours(hours({ closed: true, intervals: [] }), context())).toEqual([]);
  });

  it("refuses a business-hours or pause-reason id that appears twice", () => {
    const HOURS = "00000000-0000-4000-8000-00000000b001";
    const REASON = "00000000-0000-4000-8000-00000000b002";
    const schedule = (id: string) => ({ id, name: `Rozvrh ${id.slice(-1)}`, timezone: "Europe/Bratislava", active: true, intervals: [], exceptions: [] });
    const hours = validateBusinessHours([schedule(HOURS), { ...schedule(HOURS), name: "Rozvrh 2" }], context());
    expect(codes(hours)).toContain("duplicate_id");
    expect(hours.find((issue) => issue.code === "duplicate_id")?.path).toBe("businessHours[1]");

    const reasons = validatePauseReasons([
      { id: REASON, code: "obed", label: "Obed", maxMinutes: null, sortOrder: 0, active: true },
      { id: REASON, code: "porada", label: "Porada", maxMinutes: null, sortOrder: 10, active: true },
    ]);
    expect(codes(reasons)).toContain("duplicate_id");
    expect(reasons.find((issue) => issue.code === "duplicate_id")?.path).toBe("pauseReasons[1]");
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

  it("caps the pause length at a shift", () => {
    const reason = (maxMinutes: number) => [{ id: null, code: "obed", label: "Obed", maxMinutes, sortOrder: 0, active: true }];
    expect(codes(validatePauseReasons(reason(MAX_PAUSE_MINUTES + 1)))).toContain("max_minutes_too_high");
    expect(validatePauseReasons(reason(MAX_PAUSE_MINUTES))).toEqual([]);
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

  it("keeps the concurrency guards above the caller's own leg", () => {
    // `loadRoutingContext` counts the customer leg too, so `maxConcurrentLegs: 1`
    // leaves `planRingStep` zero capacity: every member is skipped, the step
    // waits 30 s and the call drops to the fallback — for every call.
    expect(codes(validateSettingsPatch({ maxConcurrentLegs: 1 }))).toContain("legs_invalid");
    expect(codes(validateSettingsPatch({ maxRingFanout: 20, maxConcurrentLegs: 5 }))).toContain("legs_below_fanout");
    expect(validateSettingsPatch({ maxRingFanout: 8, maxConcurrentLegs: 9 })).toEqual([]);
    expect(validateSettingsPatch({ maxRingFanout: 4, maxConcurrentLegs: 5 })).toEqual([]);
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
    const document = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: false, includeLimits: false });
    expect(document.settings).toBeNull();
    expect(document.limits).toBeNull();
  });

  it("keeps the routing limits available to a manager without the kill switches", async () => {
    const { deps } = harnessDeps();
    const document = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: false, includeLimits: true });
    expect(document.settings).toBeNull();
    expect(document.limits).toEqual({ destinationAllowlist: ["SK", "CZ"], maxRingFanout: 8, maxConcurrentLegs: 9 });
  });

  it("gives a member-level reader only their own device and settings", async () => {
    const { deps } = harnessDeps();
    const document = await getRoutingDocument(deps, {
      organizationId: ORG,
      includeSettings: false,
      includeLimits: false,
      includeOperatorDetails: false,
      viewerProfileId: PROFILES.o1,
    });

    // A dispatcher opening "Môj telefón" has no use for a colleague's Telnyx
    // credential id or SIP username.
    expect(document.operators.find((operator) => operator.profileId === PROFILES.o1)?.device?.sipUsername).toBeTruthy();
    for (const operator of document.operators.filter((entry) => entry.profileId !== PROFILES.o1)) {
      expect(operator.device).toBeNull();
      expect(operator.settings).toBeNull();
    }
    // The manager-level read still carries everybody's row.
    const full = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });
    expect(full.operators.filter((operator) => operator.device !== null).length).toBeGreaterThan(1);
  });

  it("carries the ring plans every IVR option targets", async () => {
    const { deps } = harnessDeps();
    const document = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });
    expect(document.ivrMenus[0].ringPlanIds).toEqual([PLAN_ID]);
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

describe("replaceIvrMenus", () => {
  it("swaps the digit options of a menu and audits the change once", async () => {
    const { harness, deps } = harnessDeps();
    const before = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });
    const menu = before.ivrMenus[0];

    const { document, diff } = await replaceIvrMenus(deps, {
      organizationId: ORG,
      actor: ACTOR,
      expectedVersion: before.routingVersion,
      ivrMenus: [
        {
          ...menu,
          options: [
            // Digit 1 keeps its plan, digit 2 becomes a closing message and a new
            // digit 3 waits in the čakáreň: all three shapes in one save.
            { ...menu.options[0] },
            { ...menu.options[1], action: "hangup", targetRingPlanId: null, promptMediaUrl: "after-hours.mp3", label: "Odkaz" },
            { id: null, digit: "3", action: "waiting_room", targetRingPlanId: null, targetNumber: null, label: "Počkám", promptMediaUrl: null, ttsText: null },
          ],
        },
      ],
    });

    const saved = document.ivrMenus[0];
    expect(saved.options.map((option) => [option.digit, option.action])).toEqual([
      ["1", "ring_plan"],
      ["2", "hangup"],
      ["3", "waiting_room"],
    ]);
    expect(saved.ringPlanIds).toEqual([PLAN_ID]);
    expect(harness.rows("motorist_ivr_options")).toHaveLength(3);
    expect(diff.changed.map((entry) => entry.label)).toEqual(["Hlavné menu"]);
    expect(auditRows(harness).map((row) => row.action)).toEqual(["telephony.ivr_menus.replace"]);
  });

  it("refuses to delete a menu the neutral line still plays", async () => {
    const { harness, deps } = harnessDeps();
    const before = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });

    await expect(replaceIvrMenus(deps, { organizationId: ORG, actor: ACTOR, ivrMenus: [], expectedVersion: before.routingVersion })).rejects.toMatchObject({
      status: 400,
      code: "config_invalid",
    });
    // Straight at the RPC (a second writer that validated against an older
    // world): the transaction refuses it too and nothing is lost.
    const result = await harness.admin.rpc("motorist_replace_ring_plan", { p_organization_id: ORG, p_document: { ivr_menus: [] } as never });
    expect(result.error?.message).toMatch(/ivr_menu_in_use/);
    expect(harness.rows("motorist_ivr_menus")).toHaveLength(1);
    expect(harness.rows("motorist_ivr_options")).toHaveLength(2);
  });

  it("refuses to report success when the database is still on the Phase 3 function", async () => {
    const { harness, deps } = harnessDeps();
    const before = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });
    // The old function ignores the unknown `ivr_menus` key and answers with the
    // sections it does know, so the save would look like it landed.
    harness.db.registerRpc("motorist_replace_ring_plan", () => ({ routing_version: before.routingVersion + 1 }));

    await expect(
      replaceIvrMenus(deps, { organizationId: ORG, actor: ACTOR, ivrMenus: [before.ivrMenus[0]], expectedVersion: before.routingVersion }),
    ).rejects.toMatchObject({ status: 503, code: "config_migration_missing" });
  });

  it("refuses an option that points at a plan of another organisation", async () => {
    const { deps } = harnessDeps();
    const before = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });
    const menu = before.ivrMenus[0];

    await expect(
      replaceIvrMenus(deps, {
        organizationId: ORG,
        actor: ACTOR,
        expectedVersion: before.routingVersion,
        ivrMenus: [{ ...menu, options: [{ ...menu.options[0], targetRingPlanId: "00000000-0000-4000-8000-0000000029ff" }, menu.options[1]] }],
      }),
    ).rejects.toMatchObject({ status: 400, code: "config_invalid" });
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
    const { settings } = await updateTelephonySettings(deps, { organizationId: ORG, actor: ACTOR, patch: { liveCallsEnabled: false, destinationAllowlist: ["sk"], parkMaxMinutes: 15 } });

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

  it("counts a plan only an IVR option points at as in use", async () => {
    const { harness, deps } = harnessDeps();
    const OTHER_PLAN = "00000000-0000-4000-8000-00000000c001";
    harness.db.seed("motorist_ring_plans", [
      { id: OTHER_PLAN, organization_id: ORG, name: "Odťahovka", fallback_kind: "callback_prompt", fallback_number: null, active: true },
    ]);
    harness.db.update("motorist_ivr_options", { target_ring_plan_id: OTHER_PLAN }, (row) => row.digit === "1");

    const document = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });
    const derived = contextFromDocument(document);

    // The RPC raises `ring_plan_in_use` for it, so the validator has to refuse
    // the deletion first — with a message that names something.
    expect([...derived.ringPlansInUse].sort()).toEqual([OTHER_PLAN, PLAN_ID].sort());
    expect(codes(validateRoutingReplace({ plans: document.plans.filter((plan) => plan.id === PLAN_ID).map((plan) => ({ ...plan, steps: plan.steps })) }, derived))).toContain(
      "plan_in_use",
    );
  });
});

// ---------------------------------------------------------------------------
// Mirror parity with `motorist_replace_ring_plan`
// ---------------------------------------------------------------------------

/**
 * `src/test/fake-supabase.ts` re-implements the RPC in JavaScript; the SQL runs
 * nowhere in this suite. These cases feed the mirror the hostile documents the
 * SQL is written to refuse and pin the exact error codes, so a divergence shows
 * up here instead of the first time the migration meets a real database
 * (`tests/telnyx-migration-shape.test.mjs` pins the same codes in the SQL text).
 */
describe("replace RPC guards (fake mirror parity)", () => {
  const PAUSE_REASON = "00000000-0000-4000-8000-000000002501";

  async function callRpc(harness: ReturnType<typeof createTelephonyHarness>, document: Record<string, unknown>, expectedVersion?: number | null) {
    return harness.admin.rpc("motorist_replace_ring_plan", {
      p_organization_id: ORG,
      p_document: document as never,
      ...(expectedVersion === undefined ? {} : { p_expected_version: expectedVersion }),
    });
  }

  it("says so when the database has no such function (the migration is not applied)", async () => {
    const { harness, deps } = harnessDeps();
    const before = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });
    // PostgREST answers PGRST202 while `motorist_replace_ring_plan(uuid, jsonb,
    // integer)` is missing; a generic 500 would send the manager hunting for a
    // bug in their draft instead of at the deployment.
    harness.db.failNext(
      "motorist_replace_ring_plan",
      "rpc",
      "Could not find the function public.motorist_replace_ring_plan(p_document, p_expected_version, p_organization_id) in the schema cache",
    );

    await expect(
      replaceRingGroups(deps, { organizationId: ORG, actor: ACTOR, groups: before.groups, expectedVersion: before.routingVersion }),
    ).rejects.toMatchObject({ status: 503, code: "config_migration_missing" });
  });

  it("bumps the routing version and refuses a stale one", async () => {
    const { harness, deps } = harnessDeps();
    const before = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });

    const first = await replaceRingGroups(deps, { organizationId: ORG, actor: ACTOR, groups: before.groups, expectedVersion: before.routingVersion });
    expect(first.document.routingVersion).toBe(before.routingVersion + 1);

    // A second editor still holding the old document must not silently win.
    await expect(
      replaceRingGroups(deps, { organizationId: ORG, actor: ACTOR, groups: before.groups, expectedVersion: before.routingVersion }),
    ).rejects.toMatchObject({ status: 409, code: "stale_document" });
    expect(harness.rows("motorist_ring_groups")).toHaveLength(2);
  });

  it("refuses to delete a pause reason an operator is paused under", async () => {
    const { harness, deps } = harnessDeps();
    harness.db.update("motorist_operator_presence", { status: "paused", pause_reason_id: PAUSE_REASON }, (row) => row.profile_id === PROFILES.o1);

    await expect(replacePauseReasons(deps, { organizationId: ORG, actor: ACTOR, pauseReasons: [], expectedVersion: null })).rejects.toMatchObject({
      status: 409,
      code: "pause_reason_in_use",
    });
    expect(harness.rows("motorist_pause_reasons")).toHaveLength(1);
  });

  it("re-asserts the structural invariants inside the transaction", async () => {
    const { harness, deps } = harnessDeps();
    const before = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });
    const usedGroup = before.plans[0].steps[0].ringGroupId;

    // Emptying a group a step uses bypasses `validateRoutingReplace` only if the
    // caller goes straight to the RPC — which is exactly what a second writer
    // does when it validated against a world that still had members.
    const emptied = await callRpc(harness, {
      groups: before.groups.map((group) => ({ id: group.id, name: group.name, active: group.active, members: group.id === usedGroup ? [] : group.members.map((member, index) => ({ id: member.id, member_kind: member.memberKind, profile_id: member.profileId, external_number: member.externalNumber, position: index, ring_secs: member.ringSecs })) })),
    });
    expect(emptied.error?.message).toMatch(/ring_group_empty/);
    expect(harness.rows("motorist_ring_group_members").filter((row) => row.ring_group_id === usedGroup).length).toBeGreaterThan(0);

    const gapped = await callRpc(harness, {
      plans: before.plans.map((plan) => ({
        id: plan.id,
        name: plan.name,
        fallback_kind: plan.fallbackKind,
        active: plan.active,
        steps: plan.steps.map((step, index) => ({ id: step.id, step_index: index + 1, ring_group_id: step.ringGroupId, timeout_secs: step.timeoutSecs, strategy: step.strategy })),
      })),
    });
    expect(gapped.error?.message).toMatch(/position_gap/);
  });

  it("refuses a row without an id (a null in the id array would match nothing)", async () => {
    const { harness } = harnessDeps();
    const result = await callRpc(harness, { groups: [{ id: null, name: "Bez id", active: true, members: [] }] });
    expect(result.error?.message).toMatch(/group_id_required/);
    expect(harness.rows("motorist_ring_groups")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Payload parsing: a malformed field is a 400, never a guessed value
// ---------------------------------------------------------------------------

describe("payload parsing rejects instead of guessing", () => {
  it("tells a detach (null) apart from a malformed id", () => {
    expect(parseLinePatch({ ringPlanId: null })).toEqual({ ringPlanId: null });
    // A typo used to be saved as "detach" with 200 OK, silently unrouting a DID.
    expect(() => parseLinePatch({ ringPlanId: "abc" })).toThrowError(/identifikátor/);
    expect(() => parseLinePatch({ businessHoursId: 42 })).toThrowError(/identifikátor/);
    expect(() => parseOperatorSettingsPatch({ defaultFromLineId: "nope" })).toThrowError(/identifikátor/);
  });

  it("refuses a wrong-typed boolean instead of coercing it to `true`", () => {
    expect(() => parseLinePatch({ active: "false" })).toThrowError(/true alebo false/);
    expect(() => parseOperatorSettingsPatch({ autoAnswerOutbound: "no" })).toThrowError(/true alebo false/);
    expect(() => parseSettingsPatch({ liveCallsEnabled: 1 })).toThrowError(/true alebo false/);
    expect(() => parseRingGroups([{ name: "A", active: "yes", members: [] }])).toThrowError(/true alebo false/);
    expect(parseLinePatch({ active: false })).toEqual({ active: false });
  });

  it("caps the size of every section before it materialises the payload", () => {
    const many = Array.from({ length: 201 }, (_, index) => ({ name: `Skupina ${index}`, members: [] }));
    expect(() => parseRingGroups(many)).toThrowError(/najviac 200/);
    expect(() => parseRingGroups([{ name: "A", members: Array.from({ length: 51 }, () => ({ memberKind: "operator" })) }])).toThrowError(/najviac 50 členov/);
    expect(() => parseRingPlans([{ name: "P", steps: Array.from({ length: 21 }, () => ({})) }])).toThrowError(/najviac 20 krokov/);
    expect(() => parseBusinessHours([{ name: "R", intervals: Array.from({ length: 101 }, () => ({})), exceptions: [] }])).toThrowError(/najviac 100 intervalov/);
    expect(() => parseBusinessHours([{ name: "R", intervals: [], exceptions: Array.from({ length: 201 }, () => ({})) }])).toThrowError(/najviac 200 výnimiek/);
    // The intervals of one exception day used to be silently truncated.
    expect(() =>
      parseBusinessHours([{ name: "R", intervals: [], exceptions: [{ date: "2026-12-24", closed: false, intervals: Array.from({ length: 101 }, () => ({})) }] }]),
    ).toThrowError(/Výnimka môže mať najviac 100 intervalov/);

    // The cap is refused on the first line, not after the whole array has been
    // mapped into member objects: a mapped row would have to touch `memberKind`.
    let touched = 0;
    const hostile = Array.from({ length: 201 }, () => ({
      name: "Skupina",
      get members() {
        touched += 1;
        return [];
      },
    }));
    expect(() => parseRingGroups(hostile)).toThrowError(/najviac 200/);
    expect(touched).toBe(0);
  });

  it("refuses an out-of-range sort order and daily cap", () => {
    expect(codes(validatePauseReasons(parsePauseReasons([{ code: "obed", label: "Obed", sortOrder: 99_999_999_999 }])))).toContain("sort_order_invalid");
    expect(codes(validateSettingsPatch({ dailyLegSoftCap: 99_999_999_999 }))).toContain("cap_invalid");
  });

  it("accepts 24:00 as a closing time so a line can be open around the clock", () => {
    const parsed = parseBusinessHours([
      { id: null, name: "Nonstop", intervals: [{ weekday: 6, opens: "00:00", closes: "24:00" }], exceptions: [] },
    ]);
    expect(parsed[0].intervals[0].closes).toBe("24:00");
    expect(validateBusinessHours(parsed, context())).toEqual([]);
    // 24:00 stays a *closing* time only.
    expect(codes(validateBusinessHours(parseBusinessHours([{ name: "X", intervals: [{ weekday: 1, opens: "24:00", closes: "24:00" }], exceptions: [] }]), context()))).toContain("time_invalid");
  });
});

// ---------------------------------------------------------------------------
// Settings, audit and the operator guards
// ---------------------------------------------------------------------------

describe("settings, audit and operator guards", () => {
  it("refuses to narrow the allowlist while a stored number would fall outside it", async () => {
    const { harness, deps } = harnessDeps();
    const before = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });
    const target = before.groups[0];
    await replaceRingGroups(deps, {
      organizationId: ORG,
      actor: ACTOR,
      expectedVersion: before.routingVersion,
      groups: before.groups.map((group) =>
        group.id === target.id
          ? { ...group, members: [...group.members, { id: null, memberKind: "external_number" as const, profileId: null, externalNumber: "+420720123456", position: group.members.length, ringSecs: null, lastOfferedAt: null, lastAnsweredAt: null }] }
          : group,
      ),
    });

    // The ring engine never consults the allowlist, so the Czech number would
    // keep being dialled — and billed — after "CZ" disappeared from it.
    await expect(updateTelephonySettings(deps, { organizationId: ORG, actor: ACTOR, patch: { destinationAllowlist: ["SK"] } })).rejects.toMatchObject({
      status: 409,
      code: "destination_in_use",
    });
    expect(harness.db.find("motorist_telephony_settings", () => true)?.destination_allowlist).not.toEqual(["SK"]);

    const document = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });
    expect(destinationsOutsideAllowlist(document, ["SK"]).map((entry) => entry.number)).toContain("+420720123456");
    expect(destinationsOutsideAllowlist(document, ["SK", "CZ"])).toEqual([]);
  });

  it("writes no audit row for a save that changed nothing", async () => {
    const { harness, deps } = harnessDeps();
    const before = await getRoutingDocument(deps, { organizationId: ORG, includeSettings: true });

    const { diff } = await replaceRingGroups(deps, { organizationId: ORG, actor: ACTOR, groups: before.groups, expectedVersion: before.routingVersion });

    expect(diff).toEqual({ added: [], removed: [], changed: [] });
    expect(auditRows(harness)).toHaveLength(0);
  });

  it("only accepts an active profile of the caller's own organisation", async () => {
    const { harness, deps } = harnessDeps();

    await expect(requireOperatorOfOrganization(deps, { organizationId: ORG, profileId: "not-a-uuid" })).rejects.toMatchObject({ status: 400 });
    await expect(requireOperatorOfOrganization(deps, { organizationId: ORG, profileId: FOREIGN })).rejects.toMatchObject({ status: 404, code: "operator_not_found" });
    await expect(requireOperatorOfOrganization(deps, { organizationId: ORG, profileId: PROFILES.o1 })).resolves.toMatchObject({ profileId: PROFILES.o1 });

    harness.db.update("motorist_profiles", { active: false }, (row) => row.id === PROFILES.o1);
    await expect(requireOperatorOfOrganization(deps, { organizationId: ORG, profileId: PROFILES.o1 })).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a device action while the operator is on a call unless it is a takeover", async () => {
    const { harness, deps } = harnessDeps();
    harness.db.update("motorist_operator_presence", { status: "on_call" }, (row) => row.profile_id === PROFILES.o1);

    await expect(assertOperatorNotOnCall(deps, { organizationId: ORG, profileId: PROFILES.o1 })).rejects.toMatchObject({ status: 409, code: "operator_on_call" });
    await expect(assertOperatorNotOnCall(deps, { organizationId: ORG, profileId: PROFILES.o1, takeover: true })).resolves.toBeUndefined();
    await expect(assertOperatorNotOnCall(deps, { organizationId: ORG, profileId: PROFILES.o2 })).resolves.toBeUndefined();
  });
});
