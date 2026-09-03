import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import { toJson } from "./state/types";

/**
 * One writer for every telephony audit row (design §4 Phase 4: "every
 * supervision writes an audit row naming the supervisor, the call and the
 * mode").
 *
 * It lives in its own module because three different layers have to write the
 * same kind of row and none of them may import the others: the operator
 * actions (`call-actions.ts`), the callback queue (`callbacks.ts`) and the
 * session runner, which is the only place that learns that a supervision ended
 * for a reason nobody clicked — the supervisor's browser leg dropped, the call
 * ended under them, or the conference join was refused.
 *
 * Writing an audit row never fails the action it describes: by the time it
 * runs the command has already reached Telnyx, so a failing insert is logged
 * loudly rather than reported as a failed call.
 */

export type CallAuditDeps = {
  admin: SupabaseClient<Database>;
  organizationId: string;
  logger?: (entry: Record<string, unknown>) => void;
};

export type CallAuditInput = {
  action: string;
  /** Null only for a system-observed event (a leg that dropped on its own). */
  actorProfileId: string | null;
  entityId: string;
  /** `telephony_call` unless the row is about something else (a callback request). */
  entityType?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** `dispatch_console` for an operator action, `telephony` for the pipeline. */
  source?: string;
};

export async function writeCallAudit(deps: CallAuditDeps, input: CallAuditInput): Promise<void> {
  const { error } = await deps.admin.from("motorist_audit_log").insert({
    organization_id: deps.organizationId,
    actor_profile_id: input.actorProfileId,
    action: input.action,
    entity_type: input.entityType ?? "telephony_call",
    entity_id: input.entityId,
    source: input.source ?? "dispatch_console",
    before_payload: input.before ? toJson(input.before) : null,
    after_payload: input.after ? toJson(input.after) : null,
  });
  if (error) {
    deps.logger?.({ level: "error", scope: "telephony-audit", message: "audit insert failed", action: input.action, entityId: input.entityId, error: error.message });
  }
}
