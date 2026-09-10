import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/** Returns false only for a pre-migration database. A missing proof is handled
 * successfully without completing any task; it must never use title matching. */
export async function completeTaskSourceIfSupported(client: SupabaseClient<Database>, organizationId: string, sourceType: "sms" | "location", sourceId: string, actorId?: string | null): Promise<boolean> {
  const { error } = await client.rpc("motorist_complete_task_source_v1", { p_organization_id: organizationId, p_source_type: sourceType, p_source_id: sourceId, p_actor_id: actorId ?? null });
  const missingSourceRpc = error && (error.code === "PGRST202" || error.code === "42883")
    && /(?:function (?:public\.)?motorist_complete_task_source_v1(?:\([^)]*\))? does not exist|Could not find the function public\.motorist_complete_task_source_v1\b)/i.test(error.message);
  if (missingSourceRpc) return false;
  if (error) throw new Error("Task source completion failed.");
  return true;
}
