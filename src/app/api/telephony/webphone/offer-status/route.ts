import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireDefaultMotoristActor } from "@/server/api-auth";
import { assertTelephonyDeployment, TELEPHONY_ROUTE_ROLES, telephonyEnvironment, telephonyErrorResponse } from "@/server/telephony/runtime";
import { getWebphoneOfferStatus, readWebphoneOfferStatusQuery } from "@/server/telephony/webphone-offer-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let response: Response;
  try {
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    assertTelephonyDeployment();
    const input = readWebphoneOfferStatusQuery(new URL(request.url).searchParams);
    const result = await getWebphoneOfferStatus({ admin: createSupabaseAdminClient(), organizationId: actor.organizationId,
      environment: telephonyEnvironment() }, actor.profileId, input);
    response = Response.json(result);
  } catch (error) {
    response = telephonyErrorResponse(error, "Stav telefónneho hovoru sa nepodarilo overiť.");
  }
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Vary", "Cookie");
  return response;
}
