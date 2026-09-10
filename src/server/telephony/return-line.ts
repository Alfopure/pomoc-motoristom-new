import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { returnLineId, returnLineProblem } from "@/lib/telephony/return-line";
import type { LineRow } from "./state/types";

export async function resolveInboundReturnLine(admin: SupabaseClient<Database>, organizationId: string, source: LineRow | null): Promise<LineRow | null> {
  const targetId = returnLineId(source?.metadata);
  if (!source || !targetId) return source;
  const target = await admin.from("motorist_telephony_lines").select("*").eq("organization_id", organizationId).eq("id", targetId).maybeSingle();
  if (target.error) throw new Error("Return line lookup failed");
  if (!target.data) throw new Error("Return line is unavailable");
  const [plan, steps, groups, members, profiles] = await Promise.all([
    admin.from("motorist_ring_plans").select("*").eq("organization_id", organizationId).eq("id", target.data.ring_plan_id ?? "00000000-0000-0000-0000-000000000000").maybeSingle(),
    admin.from("motorist_ring_plan_steps").select("*").eq("organization_id", organizationId).eq("ring_plan_id", target.data.ring_plan_id ?? "00000000-0000-0000-0000-000000000000"),
    admin.from("motorist_ring_groups").select("*").eq("organization_id", organizationId),
    admin.from("motorist_ring_group_members").select("*").eq("organization_id", organizationId),
    admin.from("motorist_profiles").select("id").eq("organization_id", organizationId).eq("active", true),
  ]);
  if (plan.error || steps.error || groups.error || members.error || profiles.error) throw new Error("Return line routing lookup failed");
  const line = (row: LineRow) => ({ id: row.id, active: row.active, environment: row.environment, ringPlanId: row.ring_plan_id, returnLineId: returnLineId(row.metadata) });
  const problem = returnLineProblem(line(source), [line(source), line(target.data)], plan.data ? [{ id: plan.data.id, active: plan.data.active, steps: (steps.data ?? []).map(step => ({ ringGroupId: step.ring_group_id })) }] : [], (groups.data ?? []).map(group => ({ id: group.id, active: group.active, members: (members.data ?? []).filter(member => member.ring_group_id === group.id).map(member => ({ profileId: member.profile_id, externalNumber: member.external_number })) })), new Set((profiles.data ?? []).map(profile => profile.id)));
  if (problem) throw new Error(`Invalid return line routing: ${problem}`);
  return target.data;
}
