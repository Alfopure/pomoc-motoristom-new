import type { MobileWorkConflict } from "@/lib/mobile-api";
import { MutationError } from "@/server/mutation-error";

/** Only verified own-work projections may supply a blocker. */
export class FieldWorkConflictError extends MutationError {
  constructor(message: string, readonly conflict: MobileWorkConflict, readonly resolvePhysical = conflict.kind === "physical") { super(message, 409, "work_refused"); }
}
