import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { normalizeE164 } from "@/lib/telephony/normalize-e164";
import type { ContactProof } from "./contact-proof";
import { toJson, type CallbackPlan, type SessionRow } from "./state/types";

/** Retriable historical effect: atomic request, audit and exactly linked task. No live audio. */
export async function reconcileCallbackContact(
  deps: { admin: SupabaseClient<Database>; organizationId: string },
  session: SessionRow,
  proof: ContactProof,
): Promise<string[]> {
  if (session.organization_id !== deps.organizationId || proof.sessionId !== session.id) throw new Error("callback contact scope mismatch");
  // Pre-snapshot conference joins were candidates, never authoritative contact.
  if (proof.topology === "conference" && proof.conferenceSnapshot?.source !== "telnyx_conference_participants_v1") return [];
  const result = await deps.admin.rpc("motorist_reconcile_callback_contact_v1", {
    p_organization_id: deps.organizationId, p_session_id: session.id, p_proof: toJson(proof),
  });
  if (result.error) throw new Error(`callback contact reconciliation failed: ${result.error.message}`);
  return Array.isArray(result.data) ? result.data.filter((id): id is string => typeof id === "string") : [];
}

/** The requested task and request are committed together, so replay cannot lose either. */
export async function createCallbackObligation(
  deps: { admin: SupabaseClient<Database>; now: () => Date }, session: SessionRow, plan: CallbackPlan, occurredAt?: string,
): Promise<void> {
  const callerNumber = normalizeE164(plan.callerNumber || session.caller_number);
  if (!callerNumber) {
    if (plan.request) throw new Error("callback number unavailable");
    return;
  }
  const result = await deps.admin.rpc("motorist_create_callback_obligation_v1", {
    p_organization_id: session.organization_id, p_session_id: session.id, p_plan: toJson({ ...plan, callerNumber }), p_now: occurredAt ?? plan.request?.requested_at ?? session.ended_at ?? session.started_at,
  });
  if (result.error) throw new Error(`callback obligation failed: ${result.error.message}`);
  const row = result.data as Record<string, unknown> | null;
  if (!row || Array.isArray(row) || typeof row.id !== "string" || !row.id
    || row.organization_id !== session.organization_id || row.session_id !== session.id
    || normalizeE164(row.caller_number) !== callerNumber) throw new Error("callback obligation was not persisted");
  if (plan.request) {
    const metadata = row.metadata as { request?: CallbackPlan["request"] } | undefined;
    const saved = metadata?.request;
    if (!saved || saved.kind !== "requested" || saved.event_id !== plan.request.event_id
      || saved.digit !== plan.request.digit || saved.context !== plan.request.context
      || saved.requested_at !== plan.request.requested_at) throw new Error("callback choice was not persisted");
  }
}
