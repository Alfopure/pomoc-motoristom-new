import { beginDiagnosticOperation } from "./client";
import { diagnosticFailure, diagnosticRequestId, diagnosticResponse } from "./operations";
import { isDiagnosticUuid, type DiagnosticEventInput, type DiagnosticModule, type DiagnosticOperation } from "./types";

/** Explicit user requests only. Never install a global fetch interceptor or log bodies. */
export async function diagnosticJson<T>(operation: DiagnosticOperation, module: DiagnosticModule, url: string,
  init?: RequestInit, context: Partial<DiagnosticEventInput> = {}, acceptsBody?: (body: T) => boolean): Promise<{ response: Response; body: T }> {
  const finish = beginDiagnosticOperation(operation, module, context);
  try {
    const response = await fetch(url, init);
    const body = await response.json() as T;
    const caseId = body && typeof body === "object" && "caseId" in body && isDiagnosticUuid(body.caseId) ? body.caseId : undefined;
    let outcome = diagnosticResponse(response, body);
    if (outcome === "ok" && acceptsBody) {
      try { if (!acceptsBody(body)) outcome = diagnosticFailure(null, (init?.method ?? "GET") !== "GET"); }
      catch { outcome = "unknown"; }
    }
    finish({ outcome, ...diagnosticRequestId(response), ...(caseId ? { caseId } : {}) });
    return { response, body };
  } catch (error) {
    finish({ outcome: diagnosticFailure(error, (init?.method ?? "GET") !== "GET") });
    throw error;
  }
}
