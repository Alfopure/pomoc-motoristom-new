import type { DiagnosticOutcome } from "./types";

/** A lost response cannot prove that a mutation did not commit. */
export function diagnosticFailure(error: unknown, mutation = true): DiagnosticOutcome {
  if (error instanceof Error && error.name === "AbortError" && !mutation) return "cancelled";
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "TelephonyRequestTimeoutError")) return "timeout";
  return mutation ? "unknown" : "failed";
}

export function diagnosticResponse(response: Pick<Response, "ok" | "status" | "headers">, body?: unknown): DiagnosticOutcome {
  const data = body && typeof body === "object" ? body as Record<string, unknown> : null;
  if ((response.headers?.get("x-operation-committed") === "true" && !response.ok) || data?.refreshRequired === true) return "committed_refresh_failed";
  if (response.status === 409) return "conflict";
  if (response.status === 400 || response.status === 422) return "cancelled";
  return response.ok ? "ok" : "failed";
}

export function diagnosticRequestId(response: Pick<Response, "headers">): { requestId?: string } {
  const requestId = response.headers?.get("x-request-id");
  return requestId ? { requestId } : {};
}
