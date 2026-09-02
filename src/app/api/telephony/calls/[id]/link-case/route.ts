import { linkCallToCase, TelephonyWorkflowError } from "@/server/telephony-workflow";
import { motoristAccessGuard } from "@/server/api-auth";

export const runtime = "nodejs";

type LinkCaseBody = {
  caseId?: unknown;
};

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await motoristAccessGuard({ request });
  if (denied) return denied;

  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as LinkCaseBody | null;

    if (!body || typeof body.caseId !== "string") {
      throw new TelephonyWorkflowError("caseId je povinné.", 400);
    }

    const dispatchData = await linkCallToCase(id, body.caseId);

    return Response.json({
      ok: true,
      callId: id,
      caseId: body.caseId,
      dispatchData,
    });
  } catch (error) {
    const status = error instanceof TelephonyWorkflowError ? error.status : 500;

    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Call linking failed.",
      },
      { status },
    );
  }
}
