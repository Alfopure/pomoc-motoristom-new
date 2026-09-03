import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, MAX_PARK_MINUTES as SERVER_MAX_PARK_MINUTES, validateSettingsPatch } from "@/server/telephony/config-service";
import type { TelephonySettingsDoc } from "@/server/telephony/config-service";

import {
  ENV_GATE_NOTE,
  MAX_CONCURRENT_LEGS_LIMIT,
  MAX_PARK_MINUTES,
  MAX_RING_FANOUT_LIMIT,
  describeAllowlist,
  describeKillSwitches,
  parseAllowlist,
  parseCount,
  settingsDirty,
  settingsDraftFromDocument,
  settingsPayload,
  settingsWarnings,
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

  it("agrees with the server validator, bounds included", () => {
    expect(MAX_PARK_MINUTES).toBe(SERVER_MAX_PARK_MINUTES);
    const draft = updateSettingsDraft(base, { parkMaxMinutes: "0", dailyLegSoftCap: "0", destinationAllowlist: "SK, XX", maxRingFanout: "99" });
    const local = validateSettingsDraft(draft).map((entry) => entry.code);
    const server = validateSettingsPatch(settingsPayload(draft)).map((entry) => entry.code);
    expect([...server].sort()).toEqual([...local].sort());
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

  it("explains switching a kill switch off", () => {
    const live = settings({ liveCallsEnabled: true, smsLiveSends: true });
    const warnings = settingsWarnings(settingsDraftFromDocument(settings()), live);
    expect(warnings.map((warning) => warning.tone)).toEqual(["warning", "warning"]);
    expect(warnings[0].text).toContain("423");
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
