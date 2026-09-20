import "server-only";

/**
 * Keeping the assistant out of the places that offer a colleague.
 *
 * She has a profile so her work has an author: her name renders on a case, in
 * an audit row, in a transcript. That is a lookup by id and she belongs in it.
 *
 * What she must never appear in is a list of people — assignees, notification
 * recipients, "hand this to someone". Those enumerate humans, and a row that
 * cannot log in is at best confusing and at worst a task nobody does.
 *
 * The distinction is therefore not "hide the AI" but: **enumerate humans,
 * resolve anyone.**
 */

/** Values of `motorist_profiles.kind`. */
export const PROFILE_KINDS = ["human", "ai"] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

type KindFilterable<T> = { neq(column: string, value: string): T };

/**
 * Narrows a profile query to people.
 *
 * Written as `neq('kind', 'ai')` rather than `eq('kind', 'human')` so a future
 * kind nobody has thought of yet still counts as a person by default — the
 * failure mode is a stranger in a list, not a colleague silently missing from
 * one.
 */
export function humansOnly<T>(query: KindFilterable<T>): T {
  return query.neq("kind", "ai");
}

/** The same rule for rows already in hand. */
export function isHumanProfile(profile: { kind?: string | null } | null | undefined): boolean {
  return !!profile && profile.kind !== "ai";
}
