import { authorizeRecordingsSync } from "@/server/telephony/sync-auth";
import { processTranscripts, TranscriptsProcessError } from "@/server/telephony/transcripts-process";

export const runtime = "nodejs";
// Enqueue only; processing is bounded by the existing single cron.
export const maxDuration = 15;

export async function POST(request: Request) {
  const auth = authorizeRecordingsSync(request);

  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: Record<string, unknown> = {};

  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  try {
    const summary = await processTranscripts({
      dryRun: body.dryRun === true,
      maxItems: typeof body.maxItems === "number" && Number.isFinite(body.maxItems) ? body.maxItems : undefined,
    });

    return Response.json(summary, { status: summary.status === "failed" ? 502 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof TranscriptsProcessError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Transcripts processing failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}
