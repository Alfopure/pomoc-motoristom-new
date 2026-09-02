import { loadDispatchData } from "@/data/dispatch-repository";
import { sendCaseSms, SmsWorkflowError } from "@/server/sms-workflow";
import { motoristAccessGuard } from "@/server/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await motoristAccessGuard({ request });
  if (denied) return denied;

  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as {
      resend?: boolean;
      taskId?: string;
      template?: string;
    };
    const result = await sendCaseSms({
      caseId: id,
      publicBaseUrl: publicBaseUrlFromRequest(request),
      resend: Boolean(body.resend),
      taskId: typeof body.taskId === "string" ? body.taskId : null,
      template: body.template === "eta_update" ? "eta_update" : "location_request",
    });
    const dispatchData = await loadDispatchData();

    return Response.json({
      caseId: id,
      dispatchData,
      sms: result,
    });
  } catch (error) {
    if (error instanceof SmsWorkflowError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Case SMS send failed:", error);
    return Response.json({ error: "SMS sa nepodarilo odoslat." }, { status: 500 });
  }
}

function publicBaseUrlFromRequest(request: Request) {
  const configured = process.env.PUBLIC_APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();

  if (configured) {
    return configured;
  }

  return new URL(request.url).origin;
}
