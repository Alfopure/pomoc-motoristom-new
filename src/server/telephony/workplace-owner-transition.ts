import "server-only";

import { MutationError } from "@/server/motorist-mutations";

export const WORKPLACE_OWNER_TRANSITION_KEY = "workplaceOwnerTransition";

/** Any active marker is a fail-closed lock, even when the rest is malformed. */
export function assertNoActiveWorkplaceOwnerTransition(metadata: unknown) {
  const root = jsonRecord(metadata);
  const transition = jsonRecord(root[WORKPLACE_OWNER_TRANSITION_KEY]);
  if (transition.active === true) {
    throw new MutationError(
      "Vlastník jedného z pracovísk sa práve bezpečne mení. Poradie uprav až po dokončení prevzatia.",
      409,
    );
  }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
