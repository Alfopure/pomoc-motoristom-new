import { describe, expect, it } from "vitest";
import { diagnosticFailure, diagnosticResponse } from "./operations";

describe("operation outcomes", () => {
  it("does not report an ambiguous lost mutation response as a proven failed write", () => {
    expect(diagnosticFailure(new TypeError("Failed to fetch"))).toBe("unknown");
    expect(diagnosticFailure(new DOMException("cancelled", "AbortError"))).toBe("unknown");
    expect(diagnosticFailure(new DOMException("cancelled", "AbortError"), false)).toBe("cancelled");
    expect(diagnosticFailure(new DOMException("timeout", "TimeoutError"))).toBe("timeout");
  });

  it("keeps conflicts, validation and a committed write with a failed refresh separate", () => {
    expect(diagnosticResponse(new Response(null, { status: 409 }))).toBe("conflict");
    expect(diagnosticResponse(new Response(null, { status: 422 }))).toBe("cancelled");
    expect(diagnosticResponse(new Response(null, { status: 500, headers: { "x-operation-committed": "true" } }))).toBe("committed_refresh_failed");
    expect(diagnosticResponse(new Response(null), { refreshRequired: true })).toBe("committed_refresh_failed");
    expect(diagnosticResponse(new Response(null, { status: 503 }))).toBe("failed");
  });
});
