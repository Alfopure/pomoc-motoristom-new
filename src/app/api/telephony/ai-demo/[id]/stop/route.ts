import { handleAiDemoWrite } from "@/server/telephony/ai-demo/http";
import { describeAttempt, stopAiDemo } from "@/server/telephony/ai-demo/orchestrator";
import { isUuid } from "@/lib/telephony/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Ends the demo now.
 *
 * Deliberately does not check `AI_DEMO_ENABLED` or the live-calls switches:
 * turning off new calls must never be the reason an existing one cannot be
 * stopped. Idempotent, so the button can be pressed twice.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleAiDemoWrite(
    request,
    async ({ deps }) => {
      if (!isUuid(id)) return Response.json({ error: "Neplatný identifikátor.", code: "invalid_id" }, { status: 404 });
      const attempt = await stopAiDemo(deps, id);
      if (!attempt) return Response.json({ error: "Pokus neexistuje.", code: "not_found" }, { status: 404 });
      return Response.json({ attempt: describeAttempt(attempt) });
    },
    "AI demo sa nepodarilo ukončiť.",
  );
}
