import "server-only";

import { canOperateTelephony, resolveAppEnvironment } from "@/lib/app-environment";
import { isUuid } from "@/lib/telephony/uuid";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { getOperatorDevice } from "@/server/telephony/operator-devices";
import { createTelephonyDeps, type TelephonyRuntimeDeps } from "@/server/telephony/runtime";
import { readMeta, telnyxSipUri, type LegRow, type SessionRow } from "@/server/telephony/state/types";
import { nativeVoiceTestEnabled } from "@/lib/app-environment";

export class NativeLeaseError extends MutationError { readonly code = "native_lease_stale"; }
class NativeDisabledError extends MutationError { readonly code = "native_voice_disabled"; }
class NativeOfferPendingError extends MutationError { readonly code = "native_offer_pending"; }

/** Native pilot is separate from the released M1 and the browser/PWA phone.
 * Only the dedicated TEST can opt in; a Preview or production cannot do so. */
export async function nativeVoiceDeps(actor: MotoristActor, options: { cleanup?: boolean } = {}): Promise<TelephonyRuntimeDeps> {
  if (resolveAppEnvironment() !== "test" || !canOperateTelephony()
    || (!options.cleanup && !nativeVoiceTestEnabled())) {
    throw new NativeDisabledError("Mobilné telefonovanie ešte nie je aktivované.", 503);
  }
  return createTelephonyDeps({ organizationId: actor.organizationId, deviceKind: "mobile" });
}

export async function requireNativeLease(deps: TelephonyRuntimeDeps, actor: MotoristActor, value: unknown, options: { cleanup?: boolean; heartbeat?: boolean } = {}) {
  if (typeof value !== "string" || !isUuid(value)) throw new MutationError("Chýba relácia telefónu.", 400);
  const device = await getOperatorDevice({ ...deps, deviceKind: "mobile" }, { organizationId: actor.organizationId, profileId: actor.profileId });
  const metadata = device?.metadata && typeof device.metadata === "object" && !Array.isArray(device.metadata) ? device.metadata : {};
  const retryingRevocation = options.cleanup && device?.device_session_id?.startsWith("revoked:") && metadata.native_revocation_session_id === value;
  if (!device || (device.device_session_id !== value && !retryingRevocation) || (!options.cleanup && !options.heartbeat && ["unregistered", "error"].includes(device.registration_state))) {
    throw new NativeLeaseError("Telefón bol odpojený alebo prihlásený na inom zariadení.", 409);
  }
  return device;
}

/** Blind transfer keeps the original conversation's answer metadata. Only a
 * current, unaccepted transfer to this endpoint may outlive those closed legs. */
async function isPendingNativeTransfer(
  deps: TelephonyRuntimeDeps,
  actor: MotoristActor,
  session: SessionRow,
  leg: LegRow,
): Promise<boolean> {
  const metadata = readMeta(session);
  const transfer = metadata.transfer;
  const state = leg.client_state && typeof leg.client_state === "object" && !Array.isArray(leg.client_state) ? leg.client_state : {};
  if (session.direction !== "inbound" || session.state !== "ringing" || session.answered_by_profile_id
    || session.ended_at || session.termination_requested_at || leg.ended_at || leg.answered_at
    || transfer?.kind !== "blind" || transfer.completed_at || transfer.target?.kind !== "operator"
    || transfer.target.profileId !== actor.profileId
    || typeof state.intent !== "string" || !["transfer", "transfer_safe", "transfer_recorded"].includes(state.intent)) return false;

  const globalWinner = metadata.answered_leg_call_control_id;
  const acceptedWinner = metadata.accepted_device_legs?.[actor.profileId];
  if (typeof globalWinner !== "string" || !globalWinner || globalWinner === leg.telnyx_call_control_id) return false;
  const { data: sessionLegs, error } = await deps.admin.from("motorist_call_legs").select("*")
    .eq("organization_id", actor.organizationId).eq("session_id", session.id);
  if (error) throw new MutationError("Účastníka hovoru sa nepodarilo overiť.", 503);
  if (!sessionLegs || sessionLegs.some(candidate => candidate.role !== "customer" && candidate.answered_at && !candidate.ended_at)) return false;
  const currentLeg = sessionLegs.find(candidate => candidate.id === leg.id);
  if (!currentLeg || currentLeg.role !== "operator" || currentLeg.profile_id !== actor.profileId
    || currentLeg.to_number !== leg.to_number || currentLeg.telnyx_call_control_id !== leg.telnyx_call_control_id
    || currentLeg.ended_at || currentLeg.answered_at) return false;
  const closedWinner = (controlId: string, profileId?: string) => sessionLegs.some(candidate =>
    candidate.telnyx_call_control_id === controlId && candidate.role === "operator"
    && (!profileId || candidate.profile_id === profileId) && candidate.answered_at && candidate.ended_at);
  return Boolean(closedWinner(globalWinner)
    && (!acceptedWinner || typeof acceptedWinner === "string" && acceptedWinner !== leg.telnyx_call_control_id && closedWinner(acceptedWinner, actor.profileId)));
}

/** Resolve only a current leg addressed to this operator's mobile identity.
 * Push metadata alone, a copied session ID or another operator never grants an answer. */
export async function authorizeNativeOffer(deps: TelephonyRuntimeDeps, actor: MotoristActor, body: Record<string, unknown>) {
  const device = await requireNativeLease(deps, actor, body.deviceSessionId);
  const controlId = typeof body.callControlId === "string" && body.callControlId.length <= 2048 ? body.callControlId : null;
  const legId = typeof body.providerLegId === "string" && isUuid(body.providerLegId) ? body.providerLegId : null;
  if ((!controlId && !legId) || (controlId && legId)) throw new MutationError("Chýba identita ponuky hovoru.", 400);
  let query = deps.admin.from("motorist_call_legs").select("*").eq("organization_id", actor.organizationId)
    .eq("profile_id", actor.profileId).is("ended_at", null);
  query = controlId ? query.eq("telnyx_call_control_id", controlId) : query.eq("telnyx_call_leg_id", legId!);
  const { data: leg, error } = await query.maybeSingle();
  if (error) throw new MutationError("Ponuku hovoru sa nepodarilo overiť.", 503);
  // The SDK invite can arrive before the provider dial response is persisted.
  // A bounded client retry still has to pass every ownership check below.
  if (!leg) throw new NativeOfferPendingError("Ponuka hovoru sa ešte overuje.", 409);
  // Outbound operator legs target this exact SIP user; ring legs also carry
  // the frozen mobile endpoint marker. Neither authorizes a web leg.
  const targetsThisDevice = Boolean(device.sip_username && leg?.to_number === telnyxSipUri(device.sip_username));
  if (leg.role !== "operator" || !targetsThisDevice) {
    throw new MutationError("Táto ponuka hovoru už nie je dostupná.", 409);
  }
  const { data: session, error: sessionError } = await deps.admin.from("motorist_call_sessions")
    .select("*").eq("organization_id", actor.organizationId).eq("id", leg.session_id).contains("metadata", { environment: deps.environment }).maybeSingle();
  if (sessionError) throw new MutationError("Hovor sa nepodarilo overiť.", 503);
  if (!session || session.ended_at || session.termination_requested_at || ["completed", "failed"].includes(session.state)) throw new MutationError("Hovor už bol ukončený.", 409);
  const clientState = leg.client_state && typeof leg.client_state === "object" && !Array.isArray(leg.client_state) ? leg.client_state : {};
  if (clientState.offerToken) {
    const { data: presence, error: presenceError } = await deps.admin.from("motorist_operator_presence").select("*")
      .eq("organization_id", actor.organizationId).eq("profile_id", actor.profileId).maybeSingle();
    if (presenceError) throw new MutationError("Rezerváciu sa nepodarilo overiť.", 503);
    if (!presence || presence.current_session_id !== session.id || presence.offer_token !== clientState.offerToken
      || !["ringing", "on_call"].includes(presence.status)) throw new MutationError("Ponuka hovoru už neplatí.", 409);
  }
  const { data: attempts, error: attemptError } = await deps.admin.from("motorist_ring_attempts").select("result, ended_at")
    .eq("organization_id", actor.organizationId).eq("session_id", session.id).eq("leg_id", leg.id);
  if (attemptError) throw new MutationError("Ponuku sa nepodarilo overiť.", 503);
  if (attempts?.some(attempt => attempt.ended_at || !["pending", "offered", "answered"].includes(attempt.result))) throw new MutationError("Ponuka hovoru už neplatí.", 409);
  const sessionMetadata = session.metadata && typeof session.metadata === "object" && !Array.isArray(session.metadata) ? session.metadata : {};
  const accepted = sessionMetadata.accepted_device_legs && typeof sessionMetadata.accepted_device_legs === "object" && !Array.isArray(sessionMetadata.accepted_device_legs) ? sessionMetadata.accepted_device_legs : {};
  const pendingTransfer = await isPendingNativeTransfer(deps, actor, session, leg);
  if (!pendingTransfer && accepted[actor.profileId] && accepted[actor.profileId] !== leg.telnyx_call_control_id) throw new MutationError("Hovor už prijal iný telefón.", 409);
  if (!pendingTransfer && session.answered_at && session.direction !== "internal" && sessionMetadata.answered_leg_call_control_id
    && sessionMetadata.answered_leg_call_control_id !== leg.telnyx_call_control_id) throw new MutationError("Hovor už prijal iný telefón.", 409);
  return { sessionId: session.id, callControlId: leg.telnyx_call_control_id, direction: session.direction,
    number: session.direction === "outbound" ? session.called_number : session.caller_number };
}

/** Native hangup controls only the operator's own connected/started session. */
export async function requireNativeSession(deps: TelephonyRuntimeDeps, actor: MotoristActor, sessionId: string, options: { readOffer?: boolean } = {}) {
  if (!isUuid(sessionId)) throw new MutationError("Hovor sa nenašiel.", 404);
  const { data, error } = await deps.admin.from("motorist_call_sessions").select("*")
    .eq("organization_id", actor.organizationId).contains("metadata", { environment: deps.environment }).eq("id", sessionId).maybeSingle();
  if (error) throw new MutationError("Hovor sa nepodarilo overiť.", 503);
  if (!data) throw new MutationError("Hovor nepatrí vášmu telefónu.", 403);
  // Profile ownership alone also matches this operator's browser. Always
  // resolve the mobile endpoint, including for the caller of an outbound call.
  const device = await getOperatorDevice({ ...deps, deviceKind: "mobile" }, { organizationId: actor.organizationId, profileId: actor.profileId });
  if (!device?.sip_username) throw new MutationError("Hovor nepatrí vášmu telefónu.", 403);
  const { data: legs, error: legError } = await deps.admin.from("motorist_call_legs").select("*")
    .eq("organization_id", actor.organizationId).eq("session_id", data.id).eq("profile_id", actor.profileId)
    .eq("role", "operator").eq("to_number", telnyxSipUri(device.sip_username));
  if (legError) throw new MutationError("Účastníka hovoru sa nepodarilo overiť.", 503);
  if (!legs?.length) throw new MutationError("Hovor nepatrí vášmu telefónu.", 403);

  const metadata = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata) ? data.metadata : {};
  const internal = metadata.internal && typeof metadata.internal === "object" && !Array.isArray(metadata.internal) ? metadata.internal : {};
  const accepted = metadata.accepted_device_legs && typeof metadata.accepted_device_legs === "object" && !Array.isArray(metadata.accepted_device_legs) ? metadata.accepted_device_legs : {};
  const acceptedId = accepted[actor.profileId] ?? (data.direction === "inbound" ? metadata.answered_leg_call_control_id : null);
  const participant = data.answered_by_profile_id === actor.profileId || data.direction === "internal" && internal.target_profile_id === actor.profileId;
  const ownLegs = legs.filter(leg => !acceptedId || leg.telnyx_call_control_id === acceptedId);
  const openLeg = ownLegs.find(leg => !leg.ended_at);
  // A provider hangup can close our leg before the other legs/session finish.
  // The accepted endpoint (or originating caller) retains cleanup authority.
  const ownsCleanup = Boolean(acceptedId || data.direction !== "inbound" && data.answered_by_profile_id === actor.profileId);
  if (!options.readOffer && (!participant || !ownLegs.length || !data.ended_at && !openLeg && !ownsCleanup)) {
    throw new MutationError("Hovor nepatrí vášmu telefónu.", 403);
  }
  const pendingLeg = options.readOffer && legs.find(leg => !leg.ended_at && !leg.answered_at);
  const pendingTransfer = Boolean(pendingLeg && await isPendingNativeTransfer(deps, actor, data, pendingLeg));
  return { ...data,
    nativeConnected: Boolean(participant && openLeg?.answered_at),
    nativeEnded: !pendingTransfer && Boolean(data.ended_at || !openLeg || data.answered_at && !participant),
  };
}
