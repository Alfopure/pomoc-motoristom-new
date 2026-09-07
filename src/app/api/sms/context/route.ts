import { motoristAccessGuard, requireDefaultMotoristActor } from "@/server/api-auth";
import { SMS_ROLES } from "@/server/sms-workflow";
import { smsErrorResponse } from "@/server/sms-http";
import { loadSmsOptions } from "@/server/sms-repository";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const denied = await motoristAccessGuard({ request, roles: [...SMS_ROLES] });
  if (denied) return denied;
  try {
    const actor = await requireDefaultMotoristActor([...SMS_ROLES]);
    return Response.json(await loadSmsOptions(actor.organizationId), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return smsErrorResponse(error); }
}
