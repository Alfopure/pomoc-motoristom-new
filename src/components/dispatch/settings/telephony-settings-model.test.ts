import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  MAX_ALLOWLIST_ENTRIES as SERVER_MAX_ALLOWLIST_ENTRIES,
  MAX_CONCURRENT_LEGS_LIMIT as SERVER_MAX_CONCURRENT_LEGS_LIMIT,
  MAX_DAILY_LEG_SOFT_CAP as SERVER_MAX_DAILY_LEG_SOFT_CAP,
  MAX_PARK_MINUTES as SERVER_MAX_PARK_MINUTES,
  MAX_RING_FANOUT_LIMIT as SERVER_MAX_RING_FANOUT_LIMIT,
  MIN_CONCURRENT_LEGS as SERVER_MIN_CONCURRENT_LEGS,
  validateSettingsPatch,
} from "@/server/telephony/config-service";
import type { RingGroupDoc, RingPlanDoc, TelephonySettingsDoc } from "@/server/telephony/config-service";

import {
  ENV_GATE_NOTE,
  MAX_ALLOWLIST_ENTRIES,
  MAX_CONCURRENT_LEGS_LIMIT,
  MAX_DAILY_LEG_SOFT_CAP,
  MAX_PARK_MINUTES,
  MAX_RING_FANOUT_LIMIT,
  MIN_CONCURRENT_LEGS,
  describeAllowlist,
  describeKillSwitches,
  parseAllowlist,
  parseCount,
  settingsDirty,
  settingsDraftFromDocument,
  settingsPayload,
  settingsWarnings,
  storedDestinationsOutside,
  updateSettingsDraft,
  validateSettingsDraft,
} from "./telephony-settings-model";

function settings(overrides: Partial<TelephonySettingsDoc> = {}): TelephonySettingsDoc {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("settingsDraftFromDocument", () => {
  it("renders the numbers as text and the allowlist as a comma-separated list", () => {
    const draft = settingsDraftFromDocument(settings());
    expect(draft).toMatchObject({ liveCallsEnabled: false, smsLiveSends: false, parkMaxMinutes: "30", dailyLegSoftCap: "500" });
    expect(draft.destinationAllowlist).toBe("SK, CZ");
    expect(settingsDirty(draft, settings())).toBe(false);
  });

  it("reports dirty after any real change and ignores pure formatting", () => {
    const draft = settingsDraftFromDocument(settings());
    expect(settingsDirty(updateSettingsDraft(draft, { destinationAllowlist: "sk  cz" }), settings())).toBe(false);
    expect(settingsDirty(updateSettingsDraft(draft, { destinationAllowlist: "SK, CZ, AT" }), settings())).toBe(true);
    expect(settingsDirty(updateSettingsDraft(draft, { liveCallsEnabled: true }), settings())).toBe(true);
  });
});

describe("parsing", () => {
  it("accepts whole numbers only", () => {
    expect(parseCount(" 30 ")).toBe(30);
    expect(Number.isNaN(parseCount("30.5"))).toBe(true);
    expect(Number.isNaN(parseCount("-1"))).toBe(true);
    expect(Number.isNaN(parseCount(""))).toBe(true);
  });

  it("splits the allowlist on commas, semicolons and spaces and de-duplicates", () => {
    expect(parseAllowlist(" sk, cz; +43  SK ")).toEqual(["SK", "CZ", "+43"]);
    expect(parseAllowlist("")).toEqual([]);
    expect(parseAllowlist("*")).toEqual(["*"]);
  });

  it("builds the PATCH payload", () => {
    const draft = updateSettingsDraft(settingsDraftFromDocument(settings()), { parkMaxMinutes: "15", destinationAllowlist: "sk" });
    expect(settingsPayload(draft)).toEqual({
      liveCallsEnabled: false,
      smsLiveSends: false,
      dailyLegSoftCap: 500,
      parkMaxMinutes: 15,
      maxRingFanout: 8,
      maxConcurrentLegs: 9,
      destinationAllowlist: ["SK"],
    });
  });
});

describe("validateSettingsDraft", () => {
  const base = settingsDraftFromDocument(settings());

  it("accepts the defaults", () => {
    expect(validateSettingsDraft(base)).toEqual([]);
  });

  it("rejects a non-numeric, zero or oversized park limit", () => {
    expect(validateSettingsDraft(updateSettingsDraft(base, { parkMaxMinutes: "pol hodiny" }))[0].code).toBe("park_invalid");
    expect(validateSettingsDraft(updateSettingsDraft(base, { parkMaxMinutes: "0" }))[0].code).toBe("park_invalid");
    expect(validateSettingsDraft(updateSettingsDraft(base, { parkMaxMinutes: String(MAX_PARK_MINUTES + 1) }))[0].code).toBe("park_invalid");
    expect(validateSettingsDraft(updateSettingsDraft(base, { parkMaxMinutes: String(MAX_PARK_MINUTES) }))).toEqual([]);
  });

  it("rejects a non-positive daily cap and out-of-range capacity guards", () => {
    expect(validateSettingsDraft(updateSettingsDraft(base, { dailyLegSoftCap: "0" }))[0].code).toBe("cap_invalid");
    expect(validateSettingsDraft(updateSettingsDraft(base, { maxRingFanout: String(MAX_RING_FANOUT_LIMIT + 1) }))[0].code).toBe("fanout_invalid");
    expect(validateSettingsDraft(updateSettingsDraft(base, { maxConcurrentLegs: String(MAX_CONCURRENT_LEGS_LIMIT + 1) }))[0].code).toBe("legs_invalid");
  });

  it("refuses an empty allowlist and an entry that is neither a country nor a prefix", () => {
    expect(validateSettingsDraft(updateSettingsDraft(base, { destinationAllowlist: "   " }))[0].code).toBe("allowlist_empty");
    const issues = validateSettingsDraft(updateSettingsDraft(base, { destinationAllowlist: "SK, XX, 421" }));
    expect(issues.map((entry) => entry.code)).toEqual(["allowlist_entry_invalid", "allowlist_entry_invalid"]);
    expect(issues[0].message).toContain("XX");
    expect(validateSettingsDraft(updateSettingsDraft(base, { destinationAllowlist: "SK CZ +43 *" }))).toEqual([]);
  });

  it("refuses a fan-out the org-wide leg cap cannot carry", () => {
    // One leg is always the caller's own, so `maxConcurrentLegs: 1` means no
    // phone can ever ring and anything below `maxRingFanout + 1` truncates the
    // fan-out through the capacity guard instead of the intended limit.
    expect(validateSettingsDraft(updateSettingsDraft(base, { maxConcurrentLegs: "1" }))[0].code).toBe("legs_invalid");
    expect(validateSettingsDraft(updateSettingsDraft(base, { maxRingFanout: "8", maxConcurrentLegs: "8" }))[0].code).toBe("legs_below_fanout");
    expect(validateSettingsDraft(updateSettingsDraft(base, { maxRingFanout: "3", maxConcurrentLegs: "4" }))).toEqual([]);
    expect(MIN_CONCURRENT_LEGS).toBe(SERVER_MIN_CONCURRENT_LEGS);
  });

  it("agrees with the server validator, bounds included", () => {
    expect(MAX_PARK_MINUTES).toBe(SERVER_MAX_PARK_MINUTES);
    expect(MAX_DAILY_LEG_SOFT_CAP).toBe(SERVER_MAX_DAILY_LEG_SOFT_CAP);
    expect(MAX_ALLOWLIST_ENTRIES).toBe(SERVER_MAX_ALLOWLIST_ENTRIES);
    expect(MAX_RING_FANOUT_LIMIT).toBe(SERVER_MAX_RING_FANOUT_LIMIT);
    expect(MAX_CONCURRENT_LEGS_LIMIT).toBe(SERVER_MAX_CONCURRENT_LEGS_LIMIT);

    const drafts = [
      updateSettingsDraft(base, { parkMaxMinutes: "0", dailyLegSoftCap: "0", destinationAllowlist: "SK, XX", maxRingFanout: "99" }),
      // The two bounds the mirror used to miss: the button stayed enabled and
      // the server answered 400 into the generic error banner.
      updateSettingsDraft(base, { dailyLegSoftCap: String(MAX_DAILY_LEG_SOFT_CAP + 1) }),
      updateSettingsDraft(base, { destinationAllowlist: Array.from({ length: MAX_ALLOWLIST_ENTRIES + 1 }, (_, index) => `+${index + 1}`).join(", ") }),
      updateSettingsDraft(base, { maxRingFanout: "8", maxConcurrentLegs: "8" }),
      updateSettingsDraft(base, { maxConcurrentLegs: "1" }),
    ];
    for (const draft of drafts) {
      const local = validateSettingsDraft(draft).map((entry) => entry.code);
      const server = validateSettingsPatch(settingsPayload(draft)).map((entry) => entry.code);
      expect([...server].sort()).toEqual([...local].sort());
    }
  });
});

describe("settingsWarnings", () => {
  const base = settingsDraftFromDocument(settings());

  it("is silent when nothing dangerous changes", () => {
    expect(settingsWarnings(base, settings())).toEqual([]);
  });

  it("shouts when a kill switch is switched on", () => {
    const warnings = settingsWarnings(updateSettingsDraft(base, { liveCallsEnabled: true, smsLiveSends: true }), settings());
    expect(warnings.map((warning) => warning.tone)).toEqual(["error", "error"]);
    expect(warnings[0].text).toContain("skutočné čísla");
    expect(warnings[1].text).toContain("skutočným príjemcom");
  });

  it("explains switching a kill switch off without pretending inbound stops", () => {
    const live = settings({ liveCallsEnabled: true, smsLiveSends: true });
    const warnings = settingsWarnings(settingsDraftFromDocument(settings()), live);
    expect(warnings.map((warning) => warning.tone)).toEqual(["warning", "warning"]);
    expect(warnings[0].text).toContain("423");
    // `answer` is deliberately not gated: the caller is still answered and billed.
    expect(warnings[0].text).toContain("Prichádzajúce hovory sa ale naďalej prijmú");
  });

  it("says out loud that lowering the daily cap refuses outbound calls", () => {
    const warnings = settingsWarnings(updateSettingsDraft(base, { dailyLegSoftCap: "10" }), settings());
    expect(warnings).toHaveLength(1);
    expect(warnings[0].text).toContain("429");
    expect(warnings[0].text).toContain("Prichádzajúcich volajúcich limit neodmieta");
  });

  it("names the destinations that are about to be removed", () => {
    const warning = settingsWarnings(updateSettingsDraft(base, { destinationAllowlist: "SK" }), settings());
    expect(warning[0].text).toContain("CZ");
    expect(settingsWarnings(updateSettingsDraft(base, { destinationAllowlist: "SK, CZ, AT" }), settings())).toEqual([]);
  });

  it("warns about a wildcard allowlist", () => {
    const warnings = settingsWarnings(updateSettingsDraft(base, { destinationAllowlist: "SK, CZ, *" }), settings());
    expect(warnings).toHaveLength(1);
    expect(warnings[0].text).toContain("celého sveta");
  });
});

describe("wording", () => {
  it("describes both kill switches and the environment gate", () => {
    const base = settingsDraftFromDocument(settings());
    expect(describeKillSwitches(base)).toContain("bezpečnom režime");
    expect(describeKillSwitches(updateSettingsDraft(base, { liveCallsEnabled: true }))).toBe("Hovory sú ostré, SMS sa neodosielajú.");
    expect(describeKillSwitches(updateSettingsDraft(base, { smsLiveSends: true }))).toBe("SMS sú ostré, hovory sa neuskutočňujú.");
    expect(describeKillSwitches(updateSettingsDraft(base, { liveCallsEnabled: true, smsLiveSends: true }))).toBe("Hovory aj SMS sú ostré.");
    expect(ENV_GATE_NOTE).toContain("TELNYX_LIVE_CALLS_ENABLED");
  });

  it("spells out the allowlist with dial prefixes", () => {
    const base = settingsDraftFromDocument(settings());
    expect(describeAllowlist(base)).toBe("SK (+421), CZ (+420)");
    expect(describeAllowlist(updateSettingsDraft(base, { destinationAllowlist: "*, +43, XX" }))).toBe("všetky krajiny, +43, XX");
    expect(describeAllowlist(updateSettingsDraft(base, { destinationAllowlist: "" }))).toBe("Žiadny povolený cieľ.");
  });
});

describe("cross-checks against the stored configuration", () => {
  const base = settingsDraftFromDocument(settings());

  function group(members: number): RingGroupDoc {
    return {
      id: "group-a",
      name: "Dispečing",
      description: null,
      active: true,
      members: Array.from({ length: members }, (_, index) => ({
        id: `m${index}`,
        memberKind: "operator" as const,
        profileId: `p${index}`,
        externalNumber: null,
        position: index,
        ringSecs: null,
        lastOfferedAt: null,
        lastAnsweredAt: null,
      })),
    };
  }

  const austrian: RingGroupDoc = {
    ...group(1),
    members: [{ id: "mx", memberKind: "external_number", profileId: null, externalNumber: "+43664123456", position: 0, ringSecs: null, lastOfferedAt: null, lastAnsweredAt: null }],
  };

  const plan: RingPlanDoc = {
    id: "plan-1",
    name: "Denný",
    fallbackKind: "callback_prompt",
    fallbackNumber: null,
    active: true,
    steps: [{ id: "s1", stepIndex: 0, ringGroupId: "group-a", timeoutSecs: 20, strategy: "all" }],
  };

  it("lists the stored numbers a narrower allowlist would strand", () => {
    // The ring engine never consults the allowlist, so such a number keeps
    // being dialled; the server refuses the save and the panel says why.
    expect(storedDestinationsOutside(["SK"], { groups: [austrian], plans: [] })[0]).toContain("+43664123456");
    expect(storedDestinationsOutside(["SK", "AT"], { groups: [austrian], plans: [] })).toEqual([]);
    expect(
      storedDestinationsOutside(["SK"], { groups: [], plans: [{ ...plan, fallbackKind: "external_number", fallbackNumber: "+43664123456" }] })[0],
    ).toContain("Denný");

    const warnings = settingsWarnings(updateSettingsDraft(base, { destinationAllowlist: "SK" }), settings({ destinationAllowlist: ["SK", "AT"] }), {
      groups: [austrian],
      plans: [],
    });
    expect(warnings.some((warning) => warning.tone === "error" && warning.text.includes("+43664123456"))).toBe(true);
    // The honest wording about what removing a destination actually stops.
    expect(warnings.some((warning) => warning.text.includes("vytáčalo ďalej"))).toBe(true);
  });

  it("warns when the fan-out cap would truncate an `all` step", () => {
    const context = { groups: [group(12)], plans: [plan] };
    expect(settingsWarnings(updateSettingsDraft(base, { maxRingFanout: "3" }), settings(), context).some((warning) => warning.text.includes("Dispečing (12)"))).toBe(true);
    expect(settingsWarnings(updateSettingsDraft(base, { maxRingFanout: "20" }), settings(), context)).toEqual([]);
    // An `ordered` step dials one at a time, so the cap does not truncate it.
    const ordered = { groups: [group(12)], plans: [{ ...plan, steps: plan.steps.map((step) => ({ ...step, strategy: "ordered" as const })) }] };
    expect(settingsWarnings(updateSettingsDraft(base, { maxRingFanout: "3" }), settings(), ordered)).toEqual([]);
  });
});
