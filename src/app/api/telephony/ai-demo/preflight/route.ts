import { handleAiDemoRead } from "@/server/telephony/ai-demo/http";
import { runAiDemoPreflight } from "@/server/telephony/ai-demo/preflight";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Read-only readiness. `?remote=1` adds three provider GETs; nothing on this
 * route can create a call or a paid session.
 */
export async function GET(request: Request) {
  const remote = new URL(request.url).searchParams.get("remote") === "1";
  return handleAiDemoRead(
    async ({ deps }) => Response.json(await runAiDemoPreflight(deps, { remote }), { headers: { "Cache-Control": "private, no-store" } }),
    "Kontrolu pripravenosti sa nepodarilo vykonať.",
  );
}
