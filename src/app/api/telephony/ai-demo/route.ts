import { AI_DEMO_LIMITS } from "@/server/telephony/ai-demo/config";
import { handleAiDemoRead } from "@/server/telephony/ai-demo/http";
import { listRecent } from "@/server/telephony/ai-demo/attempts";
import { describeAttempt } from "@/server/telephony/ai-demo/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** The last few demo attempts, with their measured latencies. Admin only. */
export async function GET(request: Request) {
  return handleAiDemoRead(async ({ deps }) => {
    const requested = Number.parseInt(new URL(request.url).searchParams.get("limit") ?? "", 10);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(AI_DEMO_LIMITS.historyLimit, requested)) : AI_DEMO_LIMITS.historyLimit;
    const rows = await listRecent(deps.admin, deps.organizationId, limit);
    return Response.json({ attempts: rows.map((row) => describeAttempt(row)) }, { headers: { "Cache-Control": "private, no-store" } });
  }, "Históriu AI dema sa nepodarilo načítať.");
}
