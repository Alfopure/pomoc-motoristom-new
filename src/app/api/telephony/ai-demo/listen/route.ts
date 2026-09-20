import { aiDemoEnabled, getAiDemoConfig } from "@/server/telephony/ai-demo/config";
import { verifyListenToken } from "@/server/telephony/ai-demo/listen-token";
import { runGreetingAndFinish } from "@/server/telephony/ai-demo/orchestrator";
import { createTelephonyDeps, telephonyLogger } from "@/server/telephony/runtime";
import { isUuid } from "@/lib/telephony/uuid";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Long enough to hear out a demo call.
 *
 * A demo is capped at 300 seconds by the provider, so this is that plus a
 * little for the greeting and the closing events. It sits on its own route on
 * purpose: the Telnyx webhook's budget is sized for the human call path, and
 * a demo must not widen it.
 *
 * Almost all of this time is spent waiting on a socket rather than computing.
 */
export const maxDuration = 320;

/**
 * Listens to one demo call and records what was said.
 *
 * Called by the bridge webhook, which cannot wait this long itself. The
 * credential is a token bound to this one attempt; there is no session here
 * and no browser.
 */
export async function POST(request: Request) {
  if (!aiDemoEnabled()) return Response.json({ ok: true, outcome: "disabled" });

  const config = getAiDemoConfig();
  if (!config.configured) return Response.json({ error: "not_configured" }, { status: 503 });

  const body = (await request.json().catch(() => null)) as { attemptId?: unknown; token?: unknown } | null;
  const attemptId = typeof body?.attemptId === "string" && isUuid(body.attemptId) ? body.attemptId : null;
  const token = typeof body?.token === "string" ? body.token : null;
  if (!attemptId || !token) return Response.json({ error: "invalid_request" }, { status: 400 });

  if (!verifyListenToken(config.webhookSecret, attemptId, token)) {
    telephonyLogger({ level: "warn", scope: "ai-demo", message: "listen token rejected", attemptId });
    return Response.json({ error: "invalid_token" }, { status: 401 });
  }

  try {
    const deps = await createTelephonyDeps({ logger: telephonyLogger });
    await runGreetingAndFinish(deps, attemptId);
    return Response.json({ ok: true });
  } catch (error) {
    telephonyLogger({ level: "error", scope: "ai-demo", message: "listen failed", attemptId, error: error instanceof Error ? error.message : String(error) });
    return Response.json({ error: "listen_failed" }, { status: 500 });
  }
}
