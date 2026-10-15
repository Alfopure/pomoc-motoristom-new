import { measureRequestStep, requestTimingContext, withRequestMetrics, withBackgroundRequestMetrics } from "@/server/request-metrics";
import { after } from "next/server";
import { createTelephonyDeps, notConfiguredResponse, telephonyLogger } from "@/server/telephony/runtime";
import { getTelnyxConfig } from "@/server/telephony/telnyx/env";
import { processTelnyxEvent } from "@/server/telephony/telnyx/event-processor";
import { verifyTelnyxRequest } from "@/server/telephony/telnyx/signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Leave room to finish ledger/teardown writes during a provider or database
// latency spike instead of killing an already-applied call transition at 30s.
export const maxDuration = 60;

/** Retained reporting stays outside the cold call-control import and response path. */
function reportWebhookFailure(error: unknown, details: { sessionId?: string | null; eventId?: string | null; retryable: boolean; attempt?: number; status: number }) {
  if (process.env.DIAGNOSTICS_SERVER_ERRORS_ENABLED !== "true") return;
  const requestId = requestTimingContext()?.request_id;
  try {
    after(async () => {
      try {
        const { captureServerError } = await import("@/server/diagnostics/server-errors");
        await captureServerError(error, { source: "telephony", route: "call.webhook", requestId, status: details.status,
          callSessionId: details.sessionId ?? undefined, eventId: details.eventId ?? undefined, retryable: details.retryable, attempt: details.attempt });
      } catch { /* Reporting cannot change provider acknowledgement or call control. */ }
    });
  } catch { /* No retained lifecycle; no detached background task. */ }
}

/**
 * Telnyx Call Control webhook (design §2.3).
 *
 * Public by contract: the Ed25519 signature over `timestamp|rawBody` is the
 * authentication. Failure order matters — raw body first (`request.text()`,
 * never `request.json()`, the signature is over the exact bytes), signature
 * second (400), then the claim ledger and the per-session pipeline inside
 * `processTelnyxEvent`, which owns the 200/500 policy: completed or compensated
 * events answer 200; so does a lease-busy deferral of a control fact that is
 * durably in the ledger and finished by this invocation after the response
 * (`drainDeferredDelivery`, outcome `deferred`). Busy claims, other pre-effect
 * deferrals and bookkeeping failures answer 500 so Telnyx redelivers.
 *
 * Foreign `connection_id` values (another environment sharing the account) are
 * acknowledged with 200 and ignored.
 */
export async function POST(request: Request) {
  return withRequestMetrics("call.webhook", async () => {
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
      const deps = await measureRequestStep("read", () => createTelephonyDeps({ config }));
      const result = await processTelnyxEvent({ ...deps, deferMaintenance: (work) => after(withBackgroundRequestMetrics(work)) }, envelope);

      // Busy claims and pending correlation deliberately request provider retry.
      // First technical failure and terminal unresolved outcomes need a signal;
      // ordinary later redeliveries already have durable ledger/incident evidence.
      if (result.outcome === "unresolved" || result.outcome === "failed" && (result.status === 200 || (result.claim?.attempts ?? 1) <= 1)) {
        const code = result.outcome === "unresolved" ? "webhook_unresolved" : "webhook_processing_failed";
        reportWebhookFailure(Object.assign(new Error(code), { code }), { sessionId: result.sessionId, eventId: result.eventId,
          retryable: result.status >= 500, attempt: result.claim?.attempts, status: result.status });
      }

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
      reportWebhookFailure(error, { retryable: true, status: 500 });
      telephonyLogger({ level: "error", scope: "webhook", message: "processing failed", error: error instanceof Error ? error.message : String(error) });
      return Response.json({ error: "processing_failed" }, { status: 500 });
    }
  });
}
