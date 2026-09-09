import type { Scenario } from "./model";

export type ScenarioSet = "quick" | "basic" | "complete";

// References to the round's existing definitions, in the order of a short shift check.
// Keep the same IDs, assessments and audit records in every view.
export const quickScenarioIds = [
  "AUTH-01",
  "CALL-01",
  "CALL-05",
  "CALL-02",
  "CALL-03",
  "CB-01",
  "CB-03",
  "CB-02",
  "CALL-08",
  "CASE-03",
  "AUTH-02",
] as const;

export function scenariosForSet(scenarios: Scenario[], set: ScenarioSet) {
  if (set === "quick") {
    const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
    return quickScenarioIds.flatMap((id) => {
      const scenario = byId.get(id);
      return scenario ? [scenario] : [];
    });
  }
  return set === "complete"
    ? scenarios
    : scenarios.filter((scenario) => scenario.level === 1);
}
