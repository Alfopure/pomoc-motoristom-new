import { requireTowingRequestActor } from "@/server/towing/auth";
import { loadFieldTowingOptions } from "@/server/mobile/field-work";
import { MutationError } from "@/server/mutation-error";
import { TowingError, towingErrorResponse, towingJson } from "@/server/towing/http";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireTowingRequestActor(request);
    return towingJson(await loadFieldTowingOptions({ userId: actor.userId, memberId: actor.id,
      organizationId: actor.organizationId, displayName: actor.displayName, email: actor.email ?? null,
      version: actor.version, roles: actor.roles, capabilities: actor.capabilities }));
  } catch (error) { return towingErrorResponse(error instanceof MutationError
    ? new TowingError(error.code ?? "unavailable", error.status, error.message) : error); }
}
