import { motoristAccessGuard, requireDefaultMotoristActor } from "@/server/api-auth";
import { SMS_ROLES } from "@/server/sms-workflow";
import { smsErrorResponse } from "@/server/sms-http";
import { loadSmsInbox, loadSmsInboxSummary } from "@/server/sms-inbox";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const denied = await motoristAccessGuard({ request, roles: [...SMS_ROLES] });
  if (denied) return denied;
  try {
    const actor = await requireDefaultMotoristActor([...SMS_ROLES]);
    const params = new URL(request.url).searchParams;
    const filter = params.get("filter");
    const offset = Math.max(0, Math.min(1_000_000, Math.floor(Number(params.get("offset")) || 0)));
    const data = params.get("summary") === "true" ? await loadSmsInboxSummary(actor.organizationId)
      : await loadSmsInbox(actor.organizationId, filter === "unread" || filter === "unassigned" ? filter : "all", offset);
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return smsErrorResponse(error); }
}
