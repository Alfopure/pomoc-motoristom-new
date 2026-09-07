import "server-only";
import type { SmsPreview } from "@/lib/sms/contracts";
import { motoristAccessGuard, requireDefaultMotoristActor } from "@/server/api-auth";
import { sendCaseSms, sendCustomSms, SMS_ROLES, SmsWorkflowError } from "@/server/sms-workflow";

export async function postSms(request: Request, caseId?: string) {
  const denied = await motoristAccessGuard({ request, roles: [...SMS_ROLES] });
  if (denied) return denied;
  try {
    const actor = await requireDefaultMotoristActor([...SMS_ROLES]);
    const body = await request.json().catch(() => null) as (SmsPreview & { message: string }) | null;
    if (!body?.draft || typeof body.message !== "string") throw new SmsWorkflowError("Najprv pripravte overený náhľad SMS.", 400);
    const input = { draft: body.draft, proof: body.proof, message: body.message, actorProfileId: actor.profileId, organizationId: actor.organizationId };
    const sms = caseId === undefined ? await sendCustomSms(input) : await sendCaseSms({ ...input, caseId });
    // Sending succeeded independently of unrelated dispatch-data refreshes.
    return Response.json({ sms }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return smsErrorResponse(error); }
}
export function smsErrorResponse(error: unknown) {
  if (error instanceof SmsWorkflowError) return Response.json({ error: error.message }, { status: error.status });
  console.error("SMS request failed", error instanceof Error ? error.message : "unknown error");
  return Response.json({ error: "SMS požiadavku sa nepodarilo dokončiť. Overte históriu a zopakujte tú istú požiadavku." }, { status: 500 });
}
export function smsPublicBaseUrl(request: Request) {
  // Use the reachable alias serving the editor, including before custom DNS exists.
  return new URL(request.url).origin;
}
