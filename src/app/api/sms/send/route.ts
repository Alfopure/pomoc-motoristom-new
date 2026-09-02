import { loadDispatchData } from "@/data/dispatch-repository";
import { motoristAccessGuard, requireDefaultMotoristActor } from "@/server/api-auth";
import { sendCustomSms, SmsWorkflowError } from "@/server/sms-workflow";

export const runtime = "nodejs";

const SMS_ROLES = ["dispatcher", "senior_dispatcher", "manager", "admin"] as const;

export async function POST(request: Request) {
  const denied = await motoristAccessGuard({ request, roles: [...SMS_ROLES] });
  if (denied) return denied;

  try {
    const actor = await requireDefaultMotoristActor([...SMS_ROLES]);
    const body = (await request.json().catch(() => ({}))) as {
      caseId?: unknown;
      message?: unknown;
      toNumber?: unknown;
    };
    const caseId = typeof body.caseId === "string" && body.caseId.trim() ? body.caseId.trim() : null;
    const result = await sendCustomSms({
      actorProfileId: actor.profileId,
      body: typeof body.message === "string" ? body.message : "",
      caseId,
      organizationId: actor.organizationId,
      toNumber: typeof body.toNumber === "string" ? body.toNumber : "",
    });

    return Response.json({
      ...(caseId ? { dispatchData: await loadDispatchData() } : {}),
      sms: result,
    });
  } catch (error) {
    if (error instanceof SmsWorkflowError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Custom SMS send failed:", error);
    return Response.json({ error: "SMS sa nepodarilo odoslať." }, { status: 500 });
  }
}
