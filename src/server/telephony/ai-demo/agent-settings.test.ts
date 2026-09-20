import { describe, expect, it } from "vitest";

import {
  AI_DEMO_AGENT_DEFAULTS, AI_DEMO_DEFAULT_STANDING_RULES, AI_DEMO_INTRO_CUSTOM_MAX_CHARS,
  AI_DEMO_NAME_MAX_CHARS, AI_DEMO_STANDING_RULES_MAX_CHARS, toAgentSettings, validateAgentPatch,
} from "./agent-settings";
import { AI_DEMO_SCENARIOS, buildStartupInstructions } from "./prompts";

describe("what a deployment gets before anyone opens the panel", () => {
  it("cannot read a case, write one, or send a message", () => {
    const settings = toAgentSettings(null);
    expect(settings.readsCallerCases).toBe(false);
    expect(settings.createsDraftCases).toBe(false);
    expect(settings.addsCaseNotes).toBe(false);
    expect(settings.smsEnabled).toBe(false);
  });

  it("still asks for the plate, because the safe default is the strict one", () => {
    expect(AI_DEMO_AGENT_DEFAULTS.requiresPlateCheck).toBe(true);
  });
});

describe("the standing-rules budget is derived from the prompt, not chosen", () => {
  // The prompt tests cap one assembled prompt at 2 000 characters. The longest
  // scenario already uses 1 981 of them, so the rules field is not free space:
  // it is an explicit, bounded overdraft, and this test is what keeps it from
  // growing quietly.
  const longest = Math.max(
    ...AI_DEMO_SCENARIOS.flatMap((scenario) =>
      (["f", "m"] as const).map((gender) => buildStartupInstructions(scenario, null, gender).length),
    ),
  );

  it("leaves the base prompt inside the limit the live calls verified", () => {
    expect(longest).toBeLessThan(2_000);
  });

  it("keeps prompt plus rules inside the stated total of 2 350", () => {
    expect(longest + AI_DEMO_STANDING_RULES_MAX_CHARS).toBeLessThanOrEqual(2_350);
  });

  it("offers a default that actually fits the field it ships with", () => {
    expect(AI_DEMO_DEFAULT_STANDING_RULES.length).toBeLessThanOrEqual(AI_DEMO_STANDING_RULES_MAX_CHARS);
  });
});

describe("validateAgentPatch", () => {
  it("refuses a field nobody defined rather than ignoring it", () => {
    expect(() => validateAgentPatch({ smsEnabledd: true })).toThrow(/Neznáme nastavenie/);
  });

  it("holds the name to something a person would say on the phone", () => {
    expect(() => validateAgentPatch({ displayName: "V" })).toThrow(/Meno musí/);
    expect(() => validateAgentPatch({ displayName: "x".repeat(AI_DEMO_NAME_MAX_CHARS + 1) })).toThrow(/Meno musí/);
    expect(validateAgentPatch({ displayName: "  Katarína  " }).displayName).toBe("Katarína");
  });

  it("only accepts a voice the provider actually has", () => {
    expect(() => validateAgentPatch({ voice: "morgan-freeman" })).toThrow(/hlas nie je povolený/);
  });

  it("explains why long standing rules are refused", () => {
    expect(() => validateAgentPatch({ standingRules: "a".repeat(AI_DEMO_STANDING_RULES_MAX_CHARS + 1) }))
      .toThrow(/spomalil/);
    expect(validateAgentPatch({ standingRules: "a".repeat(AI_DEMO_STANDING_RULES_MAX_CHARS) }).standingRules)
      .toHaveLength(AI_DEMO_STANDING_RULES_MAX_CHARS);
  });

  it("treats an empty field as cleared, not as an empty string", () => {
    expect(validateAgentPatch({ standingRules: "   " }).standingRules).toBeNull();
  });

  it("will not accept a custom introduction with nothing in it", () => {
    expect(() => validateAgentPatch({ introStyle: "custom", introCustom: "  " }))
      .toThrow(/treba napísať/);
    expect(() => validateAgentPatch({ introStyle: "custom", introCustom: "x".repeat(AI_DEMO_INTRO_CUSTOM_MAX_CHARS + 1) }))
      .toThrow(/najviac/);
  });

  it("keeps the SMS ceiling inside what the table allows", () => {
    expect(() => validateAgentPatch({ smsMaxPerCall: 0 })).toThrow(/1 až 3/);
    expect(() => validateAgentPatch({ smsMaxPerCall: 4 })).toThrow(/1 až 3/);
    expect(() => validateAgentPatch({ smsMaxPerCall: 1.5 })).toThrow(/1 až 3/);
    expect(validateAgentPatch({ smsMaxPerCall: 3 }).smsMaxPerCall).toBe(3);
  });

  it("refuses a permission that is not a yes or a no", () => {
    expect(() => validateAgentPatch({ readsCallerCases: "true" })).toThrow(/áno alebo nie/);
  });
});

describe("the configured name reaches her instructions", () => {
  it("uses Veronika when nothing is set", () => {
    expect(buildStartupInstructions("repair_status", null)).toContain("Si Veronika,");
  });

  it("uses the configured name instead", () => {
    expect(buildStartupInstructions("repair_status", null, { name: "Katarína" })).toContain("Si Katarína,");
  });

  it("falls back when the name is blank rather than greeting nobody", () => {
    expect(buildStartupInstructions("repair_status", null, { name: "   " })).toContain("Si Veronika,");
  });

  it("still takes the gender of the address from the voice", () => {
    expect(buildStartupInstructions("repair_status", null, { gender: "m" })).toContain("odborný pomocník");
    expect(buildStartupInstructions("repair_status", null, { gender: "f" })).toContain("odborná pomocníčka");
  });

  it("accepts the older gender-only argument so call sites can move one at a time", () => {
    expect(buildStartupInstructions("repair_status", null, "m")).toContain("odborný pomocník");
  });

  it("appends the standing rules and nothing when there are none", () => {
    const rules = "Hovor stručne a nevysvetľuj, čo nie je treba.";
    expect(buildStartupInstructions("repair_status", null, { standingRules: rules })).toContain(rules);
    expect(buildStartupInstructions("repair_status", null, {})).not.toContain("\n\n\n");
  });

  it("stays inside the stated total even with a full rules field", () => {
    const full = "x".repeat(AI_DEMO_STANDING_RULES_MAX_CHARS);
    for (const scenario of AI_DEMO_SCENARIOS) {
      const text = buildStartupInstructions(scenario, null, { standingRules: full, gender: "f" });
      expect(text.length, scenario).toBeLessThanOrEqual(2_350);
    }
  });
});
