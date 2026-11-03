import "server-only";
import { requireMobileActor } from "./auth";
import { MutationError } from "@/server/mutation-error";

/** Tools are scoped to the account incarnation which explicitly opened the panel. */
export async function requireMobileToolsActor(request: Request) {
  const actor = await requireMobileActor(request);
  if (!request.headers.get("X-PM-Expected-Organization")) {
    throw new MutationError("Pred otvorením nástrojov overte organizáciu účtu.", 409, "expected_organization_mismatch");
  }
  return actor;
}
