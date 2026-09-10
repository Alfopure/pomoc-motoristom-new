import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { MutationError } from "./mutation-error";
type Settings = { enabled: boolean; writer_inventory_verified_at: string | null; writer_inventory_note: string | null };
type SettingsClient = { from(table: "motorist_task_workspace_settings"): { select(columns: string): { eq(column: string, value: string): { maybeSingle(): PromiseLike<{ data: Settings | null; error: { code?: string } | null }> } } } };
/** System workers have no session actor. This reads only the server-owned
 * rollout setting using their existing service client; errors never fall back
 * to legacy writes after partial workflow effects. */
export async function taskWorkspaceSystemEnabled(client: SupabaseClient<Database>, organizationId: string): Promise<boolean> {
  const { data, error } = await (client as unknown as SettingsClient).from("motorist_task_workspace_settings").select("enabled, writer_inventory_verified_at, writer_inventory_note").eq("organization_id", organizationId).maybeSingle();
  if (error?.code === "42P01" || error?.code === "PGRST205") return false;
  if (error) throw new MutationError("Kompatibilitu systémových úloh sa nepodarilo overiť.", 503);
  if (!data?.enabled) return false;
  if (!data.writer_inventory_verified_at || !data.writer_inventory_note?.trim()) throw new MutationError("Aktivácia systémových úloh nemá overený zoznam zapisujúcich verzií.", 503);
  return true;
}
