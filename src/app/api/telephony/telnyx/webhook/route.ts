import { createTelephonyDeps, notConfiguredResponse, telephonyLogger } from "@/server/telephony/runtime";
import { getTelnyxConfig } from "@/server/telephony/telnyx/env";
import { processTelnyxEvent } from "@/server/telephony/telnyx/event-processor";
import { verifyTelnyxRequest } from "@/server/telephony/telnyx/signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * Telnyx Call Control webhook (design §2.3).
 *
 * Public by contract: the Ed25519 signature over `timestamp|rawBody` is the
 * authentication. Failure order matters — raw body first (`request.text()`,
 * never `request.json()`, the signature is over the exact bytes), signature
 * second (400), then the claim ledger and the per-session pipeline inside
 * `processTelnyxEvent`, which owns the 200/500 policy: control events always
 * answer 200 once compensation was attempted, bookkeeping events may answer
 * 500 so Telnyx retries them.
 *
 * Foreign `connection_id` values (another environment sharing the account) are
 * acknowledged with 200 and ignored.
 */
export async function POST(request: Request) {
  const config = getTelnyxConfig();
  if (!config.configured || !config.publicKey) {
    return notConfiguredResponse();
  }

  const raw = await request.text();
  const verified = verifyTelnyxRequest(request.headers, raw, { publicKey: config.publicKey });
  if (!verified.ok) {
    telephonyLogger({ level: "warn", scope: "webhook", verified: false, reason: verified.reason });
    return Response.json({ error: "invalid_signature", reason: verified.reason }, { status: 400 });
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    const deps = await createTelephonyDeps({ config });
    const result = await processTelnyxEvent(deps, envelope);

    return Response.json(
      {
        ok: result.status === 200,
        outcome: result.outcome,
        eventId: result.eventId,
        type: result.type,
        sessionId: result.sessionId,
        commands: result.commands.map((command) => `${command.kind}${command.ok ? "" : "!"}`),
        ms: result.ms,
      },
      { status: result.status },
    );
  } catch (error) {
    telephonyLogger({ level: "error", scope: "webhook", message: "processing failed", error: error instanceof Error ? error.message : String(error) });
    return Response.json({ error: "processing_failed" }, { status: 500 });
  }
}
