import { findCallerMatches, TelephonyWorkflowError } from "@/server/telephony-workflow";
import { motoristAccessGuard } from "@/server/api-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = await motoristAccessGuard();
  if (denied) return denied;

  try {
    const url = new URL(request.url);
    const number = url.searchParams.get("number") ?? "";
    const result = await findCallerMatches(number);

    return Response.json({
      ok: true,
      number,
      ...result,
    });
  } catch (error) {
    const status = error instanceof TelephonyWorkflowError ? error.status : 500;

    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Caller matching failed.",
      },
      { status },
    );
  }
}
