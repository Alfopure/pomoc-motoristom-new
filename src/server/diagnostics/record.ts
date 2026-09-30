import "server-only";
import { after } from "next/server";
import type { DiagnosticEventInput } from "@/lib/diagnostics/types";

/** Keep the diagnostics store and its auth/read graph off the voice request path. */
export function recordServerDiagnostic(actor: { organizationId: string; profileId: string }, input: DiagnosticEventInput): void {
  if (process.env.DIAGNOSTICS_ENABLED !== "true") return;
  try {
    const identity = { ...actor };
    const event = { ...input };
    const occurredAt = new Date().toISOString();
    after(async () => {
      try {
        const { persistServerDiagnostic } = await import("./service");
        await persistServerDiagnostic(identity, event, occurredAt);
      } catch { /* Optional diagnostics never affect call control. */ }
    });
  } catch { /* No request lifecycle means no detached write. */ }
}
