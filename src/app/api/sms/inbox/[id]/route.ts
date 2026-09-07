import { motoristAccessGuard, requireDefaultMotoristActor } from "@/server/api-auth";
import { SMS_ROLES } from "@/server/sms-workflow";
import { smsErrorResponse } from "@/server/sms-http";
import { loadSmsConversation, updateSmsInboxMessage } from "@/server/sms-inbox";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const denied = await motoristAccessGuard({ request, roles: [...SMS_ROLES] });
  if (denied) return denied;
  try {
    const actor = await requireDefaultMotoristActor([...SMS_ROLES]);
    const { id } = await context.params;
    const offset = Math.max(0, Math.min(1_000_000, Math.floor(Number(new URL(request.url).searchParams.get("offset")) || 0)));
    return Response.json(await loadSmsConversation(actor.organizationId, id, offset), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return smsErrorResponse(error); }
}
export async function PATCH(request: Request, context: Context) {
  const denied = await motoristAccessGuard({ request, roles: [...SMS_ROLES] });
  if (denied) return denied;
  try {
    const actor = await requireDefaultMotoristActor([...SMS_ROLES]);
    const { id } = await context.params;
    const result = await updateSmsInboxMessage({ organizationId: actor.organizationId, actorProfileId: actor.profileId }, id, await request.json().catch(() => null));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return smsErrorResponse(error); }
}
