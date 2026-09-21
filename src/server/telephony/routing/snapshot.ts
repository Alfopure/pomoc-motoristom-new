import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type Tables = Database["public"]["Tables"];

/** Raw rows from the existing read RPC, never the editor's redacted document. */
export type RuntimeRoutingSnapshot = {
  lines: Tables["motorist_telephony_lines"]["Row"][];
  plans: Tables["motorist_ring_plans"]["Row"][];
  steps: Tables["motorist_ring_plan_steps"]["Row"][];
  groups: Tables["motorist_ring_groups"]["Row"][];
  members: Tables["motorist_ring_group_members"]["Row"][];
  operatorSettings: Tables["motorist_operator_telephony_settings"]["Row"][];
  hours: Tables["motorist_business_hours"]["Row"][];
  intervals: Tables["motorist_business_hours_intervals"]["Row"][];
  exceptions: Tables["motorist_business_hours_exceptions"]["Row"][];
  settings: Tables["motorist_telephony_settings"]["Row"] | null;
};

export class RoutingSnapshotCompatibilityError extends Error {
  constructor(readonly reason: "missing" | "invalid") {
    super(`routing snapshot ${reason}`);
    this.name = "RoutingSnapshotCompatibilityError";
  }
}

type Check = (value: unknown) => boolean;
type Shape = Record<string, Check>;
const string: Check = (value) => typeof value === "string";
const number: Check = (value) => typeof value === "number" && Number.isFinite(value);
const boolean: Check = (value) => typeof value === "boolean";
const nullable = (check: Check): Check => (value) => value === null || check(value);
const optional = (check: Check): Check => (value) => value === undefined || check(value);
const oneOf = (...values: string[]): Check => (value) => typeof value === "string" && values.includes(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

// Validate the fields the call path consumes before trusting a JSON RPC result.
// Optional legacy columns keep their existing defaults; missing required fields
// trigger a complete legacy read, never an apparently valid empty ring plan.
const shapes: Record<Exclude<keyof RuntimeRoutingSnapshot, "settings">, Shape> = {
  lines: { id: string, phone_number: string, ring_plan_id: nullable(string), ivr_menu_id: nullable(string), business_hours_id: nullable(string), metadata: nullable(object) },
  plans: { id: string, name: string, active: boolean, fallback_kind: oneOf("external_number", "waiting_room", "callback_prompt", "hangup_message"), fallback_number: nullable(string) },
  steps: { id: string, ring_plan_id: string, step_index: number, ring_group_id: string, timeout_secs: number, strategy: oneOf("all", "ordered") },
  groups: { id: string, name: string, active: boolean },
  members: { id: string, ring_group_id: string, member_kind: oneOf("operator", "external_number"), profile_id: nullable(string), external_number: nullable(string), owner_profile_id: optional(nullable(string)), position: number, ring_secs: nullable(number) },
  operatorSettings: { profile_id: string, default_mobile_number: nullable(string), delivery_mode: optional(oneOf("web", "personal_mobile")), pause_routing_mode: oneOf("none", "default_mobile", "external_number", "operator"), pause_forward_profile_id: nullable(string), pause_forward_number: nullable(string) },
  hours: { id: string, timezone: string, active: boolean },
  intervals: { business_hours_id: string, weekday: number, opens: string, closes: string },
  exceptions: { business_hours_id: string, date: string, closed: boolean, intervals: (value) => value === null || Array.isArray(value) },
};
const settingsShape: Shape = {
  park_max_minutes: number, max_ring_fanout: number, max_concurrent_legs: number,
  queue_escalate_after_seconds: optional(number), destination_allowlist: (value) => Array.isArray(value) && value.every(string),
};

function validRow(value: unknown, organizationId: string, shape: Shape): boolean {
  return object(value) && value.organization_id === organizationId && Object.entries(shape).every(([key, check]) => check(value[key]));
}

export function parseRuntimeRoutingSnapshot(value: unknown, organizationId: string): RuntimeRoutingSnapshot {
  if (!object(value) || typeof value.snapshotId !== "string" || Object.entries(shapes).some(([key, shape]) =>
    !Array.isArray(value[key]) || !value[key].every((row: unknown) => validRow(row, organizationId, shape))) ||
    value.settings !== null && !validRow(value.settings, organizationId, settingsShape)) {
    throw new RoutingSnapshotCompatibilityError("invalid");
  }
  // Devices/presence from this RPC are deliberately not exposed: eligibility
  // needs a fresh, environment-scoped read, and RPC presence is only pause IDs.
  return Object.fromEntries([...Object.keys(shapes), "settings"].map((key) => [key, value[key]])) as RuntimeRoutingSnapshot;
}

/** One fresh read for this event. No TTL, memoization or snapshotId cache. */
export async function readRuntimeRoutingSnapshot(admin: SupabaseClient<Database>, organizationId: string): Promise<RuntimeRoutingSnapshot> {
  const { data, error } = await admin.rpc("motorist_routing_snapshot", { p_organization_id: organizationId });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") throw new RoutingSnapshotCompatibilityError("missing");
    // Authorization/connection failures remain retryable errors before effects.
    throw new Error(`routing snapshot load failed: ${error.message}`);
  }
  return parseRuntimeRoutingSnapshot(data, organizationId);
}
