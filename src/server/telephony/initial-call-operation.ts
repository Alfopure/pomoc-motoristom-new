import type { CallActor, CallActionDeps, StartOutboundResult } from "./call-actions";
import { payloadFingerprint } from "./provider-journal";
import { ownershipRpc, sessionOwnership } from "./ownership";
import { CallActionError } from "./service-errors";
import type { SessionRow } from "./state/types";

export type InitialCallPlan = {
  id: string;
  actorId: string;
  fingerprint: string;
  to: string;
  from: string;
  sipUri: string;
  fromDisplayName?: string;
  callbackRequestId?: string;
  request?: Record<string, unknown>;
};
export class InitialOperationExistsError extends Error {
  constructor(readonly session: SessionRow) { super("Initial call operation already exists"); }
}
export function initialOperationIdentity(actor: CallActor, kind: "outbound" | "internal", input: { requestId?: string }): Pick<InitialCallPlan, "id" | "actorId" | "fingerprint"> | null {
  if (!input.requestId) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) throw new CallActionError("Neplatná identita volania.", 400, "invalid_request_id");
  return { id: input.requestId, actorId: actor.profileId, fingerprint: payloadFingerprint({ kind, input: { ...input, requestId: undefined } }) };
}
export function readInitialCallPlan(session: SessionRow): InitialCallPlan | null {
  return (session.metadata as { initial_operation?: InitialCallPlan } | null)?.initial_operation ?? null;
}
export async function findInitialCallByRequest(deps: CallActionDeps, actorId: string, requestId: string): Promise<SessionRow | null> {
  const found = await deps.admin.from("motorist_call_sessions").select("*").eq("organization_id", deps.organizationId)
    .contains("metadata", { initial_operation: { id: requestId, actorId } }).maybeSingle();
  if (found.error) throw new CallActionError("Stav vytáčania sa nepodarilo overiť.", 503, "initial_call_lookup_unavailable");
  return found.data;
}
export async function findInitialCall(deps: CallActionDeps, identity: Pick<InitialCallPlan, "id" | "actorId" | "fingerprint"> | null): Promise<SessionRow | null> {
  if (!identity) return null;
  const found = await findInitialCallByRequest(deps, identity.actorId, identity.id);
  if (found && readInitialCallPlan(found)?.fingerprint !== identity.fingerprint) throw new CallActionError("Identita volania už patrí inému cieľu.", 409, "request_id_conflict");
  return found;
}

export async function recoverInitialDial(deps: CallActionDeps, session: SessionRow, dialCommandId: string, plan: Pick<InitialCallPlan, "to" | "from">): Promise<StartOutboundResult | null> {
  if (session.ended_at || ["ended", "failed"].includes(session.state)) throw new CallActionError("Pôvodný hovor už skončil.", 409, "initial_call_ended");
  if (sessionOwnership.getStore()?.contract !== 2) return null;
  const record = await ownershipRpc<{ outcome: string; result?: { data?: { call_control_id?: string; call_session_id?: string } } } | null>(deps.admin,
    "motorist_provider_command_lookup_v2", { p_session_id: session.id, p_command_id: dialCommandId });
  if (record?.outcome === "rate_limited") return null; // prepare enforces the full persisted Retry-After before any resend.
  if (!record) return null; // The durable journal proves no provider dispatch was admitted.
  const leg = record.result?.data?.call_control_id;
  if (record.outcome === "accepted" && leg) return { sessionId: session.id, operatorLegCallControlId: leg,
    telnyxSessionId: record.result?.data?.call_session_id ?? null, to: plan.to, from: plan.from };
  if (record.outcome === "rejected") throw new CallActionError("Pôvodné vytáčanie bolo odmietnuté.", 409, "initial_call_rejected");
  throw new CallActionError("Výsledok pôvodného vytáčania sa overuje. Nový hovor nebol vytvorený.", 503, "provider_outcome_unknown");
}
