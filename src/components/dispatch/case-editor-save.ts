import type { UpdateCaseInput } from "@/data/case-inputs";

/** Diff serialized editor snapshots at execution time, after earlier saves settle. */
export function changedCaseFields(accepted: string, draft: string): UpdateCaseInput {
  const before = JSON.parse(accepted) as Record<string, unknown>;
  const after = JSON.parse(draft) as Record<string, unknown>;
  return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => key !== "expectedUpdatedAt" && JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map(key => [key, after[key] ?? null])) as UpdateCaseInput;
}
