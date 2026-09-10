import "server-only";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { unavailableWorkspaceCapabilities, type WorkspaceCapabilities } from "@/domain/workspace-capabilities";
import { MutationError } from "./mutation-error";

export async function loadWorkspaceCapabilities(actor: { organizationId: string; profileId: string }): Promise<WorkspaceCapabilities> {
  const { data, error } = await createSupabaseAdminClient().rpc("motorist_workspace_capabilities", { p_organization_id: actor.organizationId, p_actor_id: actor.profileId });
  // An old schema is a supported pre-activation state. Other failures must not
  // silently route writes back to an older mutation workflow.
  if (error?.code === "PGRST202" || error?.code === "42883") return { ...unavailableWorkspaceCapabilities };
  if (error) throw new MutationError("Dostupnosť pracovnej plochy sa nepodarilo overiť.", error.code === "42501" ? 403 : 503);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new MutationError("Dostupnosť pracovnej plochy sa nepodarilo overiť.", 503);
  const value = data as Record<string, unknown>;
  return { notes: value.notes === true, tasks: value.tasks === true, atomicCaseSave: value.atomicCaseSave === true, pdf: value.pdf === true };
}
