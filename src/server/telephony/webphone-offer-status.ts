import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/telephony/uuid";
import { CallActionError } from "./service-errors";
import { readMeta, telnyxSipUri, type TelephonyEnvironment } from "./state/types";

type Input = { deviceSessionId: string; callControlId: string };
export type WebphoneOfferStatus = {
  callControlId: string;
  sessionId: string | null;
  status: "pending" | "ringing" | "connected" | "superseded" | "ended";
};

export function readWebphoneOfferStatusQuery(params: URLSearchParams): Input {
  const deviceSessionId = params.get("deviceSessionId"), callControlId = params.get("callControlId");
  if ([...params.keys()].some(key => key !== "deviceSessionId" && key !== "callControlId") ||
      params.getAll("deviceSessionId").length !== 1 || params.getAll("callControlId").length !== 1 ||
      !deviceSessionId || !isUuid(deviceSessionId) || !callControlId || callControlId.length > 2048 || /[\s\x00-\x1f\x7f]/.test(callControlId)) {
    throw new CallActionError("Neplatná identita telefónneho hovoru.", 400, "invalid_offer_identity");
  }
  return { deviceSessionId, callControlId };
}

/** Observation only: no provider client, presence repair or call mutation. */
export async function getWebphoneOfferStatus(
  deps: { admin: SupabaseClient<Database>; organizationId: string; environment: TelephonyEnvironment },
  profileId: string,
  input: Input,
): Promise<WebphoneOfferStatus> {
  const { admin, organizationId, environment } = deps;
  const device = await admin.from("motorist_operator_devices").select("device_session_id,sip_username")
    .eq("organization_id", organizationId).eq("profile_id", profileId).eq("environment", environment).maybeSingle();
  if (device.error) throw new CallActionError("Zariadenie sa nepodarilo overiť.", 503);
  if (!device.data?.sip_username || device.data.device_session_id !== input.deviceSessionId) {
    throw new CallActionError("Telefón bol prihlásený v inom okne.", 409, "webphone_lease_stale");
  }
  const result: WebphoneOfferStatus = { callControlId: input.callControlId, sessionId: null, status: "pending" };
  const leg = await admin.from("motorist_call_legs").select("*").eq("organization_id", organizationId)
    .eq("profile_id", profileId).eq("telnyx_call_control_id", input.callControlId).maybeSingle();
  if (leg.error) throw new CallActionError("Hovor sa nepodarilo overiť.", 503);
  // A provider INVITE may arrive before the dial response is persisted.
  if (!leg.data) return result;
  if (leg.data.role !== "operator" || leg.data.to_number !== telnyxSipUri(device.data.sip_username)) {
    throw new CallActionError("Hovor nepatrí tomuto telefónu.", 403);
  }
  const session = await admin.from("motorist_call_sessions").select("*").eq("organization_id", organizationId)
    .eq("id", leg.data.session_id).maybeSingle();
  if (session.error) throw new CallActionError("Hovor sa nepodarilo overiť.", 503);
  if (!session.data || readMeta(session.data).environment !== environment) throw new CallActionError("Hovor nie je dostupný.", 403);
  result.sessionId = session.data.id;
  if (leg.data.ended_at || session.data.ended_at || session.data.termination_requested_at || ["ended", "failed"].includes(session.data.state)) {
    return { ...result, status: "ended" };
  }
  const meta = readMeta(session.data);
  const clientState = leg.data.client_state;
  const intent = clientState && typeof clientState === "object" && !Array.isArray(clientState) ? clientState.intent : null;
  const accepted = meta.accepted_device_legs?.[profileId];
  // Inbound answered-leg is the customer-facing winner, not an invited party
  // or consultant. A shared profile alone is never endpoint ownership.
  const customerInvitation = (value: unknown) => value === "ring" || value === "pickup" || !value;
  const ordinaryInbound = session.data.direction === "inbound" && customerInvitation(intent);
  const candidates = [
    { winner: accepted, profileScoped: true },
    { winner: ordinaryInbound ? meta.answered_leg_call_control_id : null, profileScoped: false },
  ];
  for (const { winner, profileScoped } of candidates) {
    if (typeof winner !== "string" || !winner) continue;
    const winning = winner === input.callControlId ? { data: leg.data, error: null }
      : await admin.from("motorist_call_legs").select("*").eq("organization_id", organizationId)
        .eq("session_id", session.data.id).eq("telnyx_call_control_id", winner).maybeSingle();
    if (winning.error) throw new CallActionError("Víťazný telefón sa nepodarilo overiť.", 503);
    const row = winning.data;
    const state = row?.client_state;
    const winningIntent = state && typeof state === "object" && !Array.isArray(state) ? state.intent : null;
    const explicitMobileTransfer = intent === "transfer" && winningIntent === "transfer_recorded" &&
      meta.mobile_offers?.[profileId]?.source === input.callControlId;
    const sameInvitation = profileScoped
      ? row?.profile_id === profileId && row.role === leg.data.role &&
        (winningIntent === intent || (ordinaryInbound && customerInvitation(winningIntent)) || explicitMobileTransfer)
      : row && ["operator", "external"].includes(row.role) && customerInvitation(winningIntent);
    if (row?.answered_at && !row.ended_at && sameInvitation) {
      return { ...result, status: winner === input.callControlId ? "connected" : "superseded" };
    }
  }
  const ownCaller = session.data.answered_by_profile_id === profileId && leg.data.answered_at &&
    ((session.data.direction === "internal" && intent === "internal_caller") || (session.data.direction === "outbound" && intent === "outbound"));
  return { ...result, status: ownCaller ? "connected" : "ringing" };
}
