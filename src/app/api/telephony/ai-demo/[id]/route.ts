import { handleAiDemoRead } from "@/server/telephony/ai-demo/http";
import { describeAttempt, loadAttempt } from "@/server/telephony/ai-demo/orchestrator";
import { isUuid } from "@/lib/telephony/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** One attempt, for the timeline poll. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleAiDemoRead(async ({ deps }) => {
    if (!isUuid(id)) return Response.json({ error: "Neplatný identifikátor.", code: "invalid_id" }, { status: 404 });
    const attempt = await loadAttempt(deps.admin, deps.organizationId, id);
    if (!attempt) return Response.json({ error: "Pokus neexistuje.", code: "not_found" }, { status: 404 });
    // The one place the words are served, and only to an admin who asked for
    // this exact attempt.
    const params = new URL(_request.url).searchParams;
    const includeTranscript = params.get("transcript") === "1";
    const rawSince = Number.parseInt(params.get("since") ?? "", 10);
    const transcriptSince = Number.isFinite(rawSince) ? rawSince : undefined;
    return Response.json(
      { attempt: describeAttempt(attempt, { includeTranscript, ...(transcriptSince !== undefined ? { transcriptSince } : {}) }) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }, "Stav AI dema sa nepodarilo načítať.");
}
