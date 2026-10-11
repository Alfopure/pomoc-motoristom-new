import "server-only";

import { canOperateTelephony, resolveAppEnvironment } from "@/lib/app-environment";
import { isUuid } from "@/lib/telephony/uuid";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { getOperatorDevice } from "@/server/telephony/operator-devices";
import { createTelephonyDeps, type TelephonyRuntimeDeps } from "@/server/telephony/runtime";
import { telnyxSipUri } from "@/server/telephony/state/types";
import { nativeVoiceTestEnabled } from "@/lib/app-environment";

export class NativeLeaseError extends MutationError { readonly code = "native_lease_stale"; }
class NativeDisabledError extends MutationError { readonly code = "native_voice_disabled"; }

/** Native pilot is separate from the released M1 and the browser/PWA phone.
 * Only the dedicated TEST can opt in; a Preview or production cannot do so. */
export async function nativeVoiceDeps(actor: MotoristActor, options: { cleanup?: boolean } = {}): Promise<TelephonyRuntimeDeps> {
  if (resolveAppEnvironment() !== "test" || !canOperateTelephony()
    || (!options.cleanup && !nativeVoiceTestEnabled())) {
    throw new NativeDisabledError("Mobilné telefonovanie ešte nie je aktivované.", 503);
  }
  return createTelephonyDeps({ organizationId: actor.organizationId, deviceKind: "mobile" });
}

export async function requireNativeLease(deps: TelephonyRuntimeDeps, actor: MotoristActor, value: unknown, options: { cleanup?: boolean } = {}) {
  if (typeof value !== "string" || !isUuid(value)) throw new MutationError("Chýba relácia telefónu.", 400);
  const device = await getOperatorDevice({ ...deps, deviceKind: "mobile" }, { organizationId: actor.organizationId, profileId: actor.profileId });
  const metadata = device?.metadata && typeof device.metadata === "object" && !Array.isArray(device.metadata) ? device.metadata : {};
  const retryingRevocation = options.cleanup && device?.device_session_id?.startsWith("revoked:") && metadata.native_revocation_session_id === value;
  if (!device || (device.device_session_id !== value && !retryingRevocation) || (!options.cleanup && ["unregistered", "error"].includes(device.registration_state))) {
    throw new NativeLeaseError("Telefón bol odpojený alebo prihlásený na inom zariadení.", 409);
  }
  return device;
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
  // Outbound operator legs target this exact SIP user; ring legs also carry
  // the frozen mobile endpoint marker. Neither authorizes a web leg.
  const targetsThisDevice = Boolean(device.sip_username && leg?.to_number === telnyxSipUri(device.sip_username));
  if (!leg || leg.role !== "operator" || !targetsThisDevice) {
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
  if (session.answered_at && session.direction !== "internal" && sessionMetadata.answered_leg_call_control_id
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
  if (data.answered_by_profile_id !== actor.profileId) {
    // Both parties may end an internal call, but a losing customer-call offer
    // never authorizes ending the winner's session.
    const metadata = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata) ? data.metadata : {};
    const internal = metadata.internal && typeof metadata.internal === "object" && !Array.isArray(metadata.internal) ? metadata.internal : {};
    if (!options.readOffer && (data.direction !== "internal" || internal.target_profile_id !== actor.profileId)) throw new MutationError("Hovor nepatrí vášmu telefónu.", 403);
    const device = await getOperatorDevice({ ...deps, deviceKind: "mobile" }, { organizationId: actor.organizationId, profileId: actor.profileId });
    const { data: legs, error: legError } = await deps.admin.from("motorist_call_legs").select("id")
      .eq("organization_id", actor.organizationId).eq("session_id", data.id).eq("profile_id", actor.profileId)
      .eq("role", "operator").eq("to_number", device?.sip_username ? telnyxSipUri(device.sip_username) : "");
    if (legError) throw new MutationError("Účastníka hovoru sa nepodarilo overiť.", 503);
    if (!legs?.length) throw new MutationError("Hovor nepatrí vášmu telefónu.", 403);
  }
  return data;
}
