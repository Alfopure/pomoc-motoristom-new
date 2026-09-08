import { setCallOutcome, TelephonyWorkflowError } from "@/server/telephony-workflow";
import { motoristAccessGuard, requireDefaultMotoristActor } from "@/server/api-auth";
import { telephonyStabilityEnabled } from "@/server/telephony/stability";
import { TELEPHONY_ROUTE_ROLES } from "@/server/telephony/runtime";

export const runtime = "nodejs";

type OutcomeBody = {
  outcome?: unknown;
  note?: unknown;
  callbackMinutes?: unknown;
  callbackActionId?: unknown;
};

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await motoristAccessGuard({ request });
  if (denied) return denied;

  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as OutcomeBody | null;

    if (!body) {
      throw new TelephonyWorkflowError("Request body is required.", 400);
    }

    const actor = telephonyStabilityEnabled() ? await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES) : undefined;
    const dispatchData = await setCallOutcome(id, {
      outcome: body.outcome,
      note: body.note,
      callbackMinutes: body.callbackMinutes,
      callbackActionId: body.callbackActionId,
    }, actor);

    return Response.json({
      ok: true,
      callId: id,
      outcome: body.outcome,
      dispatchData,
    });
  } catch (error) {
    const status = error instanceof TelephonyWorkflowError ? error.status : 500;

    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Call outcome failed.",
      },
      { status },
    );
  }
}
