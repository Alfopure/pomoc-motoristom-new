import { after } from "next/server";

import { verifyOpenAIWebhook } from "@/lib/integrations/ai/openai-live";
import { aiDemoEnabled, getAiDemoConfig } from "@/server/telephony/ai-demo/config";
import { handleOpenAIIncoming } from "@/server/telephony/ai-demo/openai-events";
import { createTelephonyDeps, telephonyLogger } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The accept round trip sits inside this request on purpose: OpenAI retries
// only when it does not receive a 2xx, and the customer's phone is not ringing
// yet. Room is left for a provider latency spike rather than a 30s cut.
export const maxDuration = 60;

const MAX_BODY_BYTES = 64_000;

/**
 * OpenAI GPT-Live webhook: `live.transport.incoming`.
 *
 * Public by contract, exactly like the Telnyx webhook — the Standard Webhooks
 * signature over `id.timestamp.body` is the authentication, so the raw bytes
 * must be read before anything parses them.
 *
 * A valid signature is not authorisation. It proves the event came from
 * OpenAI; it does not prove the SIP session behind it was started by us. That
 * question is answered by a row this application wrote when an admin pressed
 * the button, and an event matching no such row is acknowledged and ignored.
 * Answering it with a SIP rejection would mean deciding somebody else's call.
 */
export async function POST(request: Request) {
  if (!aiDemoEnabled()) {
    // Off means off: no signature work, no database read, no decision.
    return Response.json({ ok: true, outcome: "disabled" }, { status: 200 });
  }

  const config = getAiDemoConfig();
  if (!config.configured) {
    // Acknowledged, not accepted. A 503 asks the provider to try again, and
    // this is not a blip it can outlast: a missing signing secret stays missing
    // until somebody types it in, so the retries would run for the full 72-hour
    // window and change nothing. It also makes the endpoint impossible to
    // register in the first place, because the secret only exists *after*
    // registration — the chicken-and-egg that sent us looking here.
    //
    // Nothing is acted on: without the secret there is no way to tell a real
    // event from a forged one, so this is the same posture as switched off,
    // with a warning naming exactly what is missing.
    telephonyLogger({ level: "warn", scope: "ai-demo", message: "openai webhook not configured", missing: config.missing });
    return Response.json({ ok: true, outcome: "not_configured", missing: config.missing }, { status: 200 });
  }

  const length = request.headers.get("content-length");
  if (length && Number(length) > MAX_BODY_BYTES) return Response.json({ error: "payload_too_large" }, { status: 413 });

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "payload_too_large" }, { status: 413 });

  const verified = verifyOpenAIWebhook(request.headers, raw, { secret: config.webhookSecret });
  if (!verified.ok) {
    telephonyLogger({ level: "warn", scope: "ai-demo", message: "openai webhook rejected", reason: verified.reason });
    return Response.json({ error: "invalid_signature", reason: verified.reason }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const deps = await createTelephonyDeps({ logger: telephonyLogger });
    const result = await handleOpenAIIncoming({ ...deps, deferMaintenance: (work) => after(work) }, payload);
    // 200 even for `failed`: the decision was made and recorded, and a
    // redelivery would only re-derive the same outcome.
    return Response.json({ ok: true, ...result }, { status: 200 });
  } catch (error) {
    telephonyLogger({ level: "error", scope: "ai-demo", message: "openai webhook failed", error: error instanceof Error ? error.message : String(error) });
    // No decision was recorded, so a retry is worth having.
    return Response.json({ error: "processing_failed" }, { status: 500 });
  }
}
