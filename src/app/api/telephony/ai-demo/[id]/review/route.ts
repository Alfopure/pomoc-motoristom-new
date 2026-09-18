import { loadAttempt, patchAttempt } from "@/server/telephony/ai-demo/attempts";
import { getAiDemoConfig } from "@/server/telephony/ai-demo/config";
import { handleAiDemoWrite } from "@/server/telephony/ai-demo/http";
import { AiDemoError, describeAttempt } from "@/server/telephony/ai-demo/orchestrator";
import { AiDemoReviewError, reviewDemoCall } from "@/server/telephony/ai-demo/review";
import { transcriptTurns } from "@/server/telephony/ai-demo/transcript";
import { isUuid } from "@/lib/telephony/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A model reads the whole transcript back; that is slower than a page load.
export const maxDuration = 90;

/**
 * Reads one demo call back and writes down how it went.
 *
 * On demand rather than automatic: it costs a model call, it is worth
 * re-running after the rubric changes, and a review nobody asked for is a
 * review nobody reads.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleAiDemoWrite(
    request,
    async ({ deps }) => {
      if (!isUuid(id)) return Response.json({ error: "Neplatný identifikátor.", code: "invalid_id" }, { status: 404 });
      const attempt = await loadAttempt(deps.admin, deps.organizationId, id);
      if (!attempt) return Response.json({ error: "Pokus neexistuje.", code: "not_found" }, { status: 404 });

      const config = getAiDemoConfig(deps.env ?? process.env);
      if (!config.configured) throw new AiDemoError("AI demo nie je nakonfigurované.", 503, "ai_demo_not_configured", config.missing);

      const turns = transcriptTurns(attempt.transcript);
      if (turns.length === 0) {
        return Response.json({ error: "K tomuto hovoru nie je prepis.", code: "ai_demo_no_transcript" }, { status: 409 });
      }

      const stats = attempt.conversation_stats as { longestSilenceMs?: number } | null;
      const latency = (attempt.metadata as { latency?: { first_word_ms?: number | null } } | null)?.latency;
      const contextValue = (attempt.metadata as { context?: unknown } | null)?.context;

      try {
        const review = await reviewDemoCall(
          {
            turns,
            scenario: attempt.scenario,
            context: typeof contextValue === "string" ? contextValue : null,
            // The transcript stops when the session does; if the call outlived
            // it, the model must not judge an ending it cannot see.
            coverage: attempt.state === "ended" || attempt.state === "failed" ? "whole_call" : "opening_only",
            firstWordMs: typeof latency?.first_word_ms === "number" ? latency.first_word_ms : null,
            longestSilenceMs: typeof stats?.longestSilenceMs === "number" ? stats.longestSilenceMs : null,
          },
          { apiKey: config.apiKey, model: config.backendModel },
        );
        const saved = await patchAttempt(deps.admin, attempt.id, { review, reviewed_at: new Date().toISOString() });
        return Response.json({ attempt: describeAttempt(saved ?? attempt, { includeTranscript: true }) });
      } catch (error) {
        if (error instanceof AiDemoReviewError) {
          return Response.json({ error: "Vyhodnotenie sa nepodarilo.", code: error.code }, { status: error.status >= 400 && error.status < 600 ? error.status : 502 });
        }
        throw error;
      }
    },
    "Hovor sa nepodarilo vyhodnotiť.",
  );
}
