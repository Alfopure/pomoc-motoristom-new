import { motoristAccessGuard, requireDefaultMotoristActor } from "@/server/api-auth";
import { SMS_ROLES } from "@/server/sms-workflow";
import { smsErrorResponse } from "@/server/sms-http";
import { loadSmsHistory } from "@/server/sms-repository";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const denied = await motoristAccessGuard({ request, roles: [...SMS_ROLES] });
  if (denied) return denied;
  try {
    const actor = await requireDefaultMotoristActor([...SMS_ROLES]);
    const params = new URL(request.url).searchParams;
    const offset = Math.max(0, Math.floor(Number(params.get("offset")) || 0));
    return Response.json(await loadSmsHistory(actor.organizationId, params.get("caseId"), offset), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return smsErrorResponse(error); }
}
