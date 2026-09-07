import type { SmsPrepareInput } from "@/lib/sms/contracts";
import { motoristAccessGuard, requireDefaultMotoristActor } from "@/server/api-auth";
import { prepareSms, SMS_ROLES, SmsWorkflowError } from "@/server/sms-workflow";
import { smsErrorResponse, smsPublicBaseUrl } from "@/server/sms-http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const denied = await motoristAccessGuard({ request, roles: [...SMS_ROLES] });
  if (denied) return denied;
  try {
    const actor = await requireDefaultMotoristActor([...SMS_ROLES]);
    const body = await request.json().catch(() => null) as SmsPrepareInput | null;
    if (!body) throw new SmsWorkflowError("Skontrolujte údaje SMS.", 400);
    const preview = await prepareSms({ ...body, organizationId: actor.organizationId, actorProfileId: actor.profileId, publicBaseUrl: smsPublicBaseUrl(request) });
    return Response.json(preview, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return smsErrorResponse(error); }
}
