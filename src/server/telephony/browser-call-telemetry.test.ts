import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { BrowserCallObservation } from "@/lib/telephony/browser-call-telemetry";
import { logBrowserCallObservations } from "./browser-call-telemetry";

const entry: BrowserCallObservation = { id: "event-uuid", pageId: "page-uuid", callControlId: "control-1", phase: "ringtone_start", atMs: 1200, outcome: "ok", durationMs: 3 };

function harness() {
  const filters: unknown[][] = [];
  const rows: Record<string, Record<string, unknown>[]> = {
    motorist_call_legs: [
      { id: "leg-1", session_id: "session-1", organization_id: "org-1", profile_id: "profile-1", role: "operator", telnyx_call_control_id: "control-1" },
      { id: "leg-2", session_id: "session-2", organization_id: "org-1", profile_id: "other", role: "operator", telnyx_call_control_id: "control-other" },
      { id: "leg-3", session_id: "session-3", organization_id: "other-org", profile_id: "profile-1", role: "operator", telnyx_call_control_id: "control-other-org" },
      { id: "leg-4", session_id: "session-dev", organization_id: "org-1", profile_id: "profile-1", role: "operator", telnyx_call_control_id: "control-dev" },
    ],
    motorist_call_sessions: [
      { id: "session-1", organization_id: "org-1", "metadata->>environment": "production" },
      { id: "session-dev", organization_id: "org-1", "metadata->>environment": "development" },
    ],
  };
  const from = vi.fn((table: string) => {
    let result = rows[table] ?? [];
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => { filters.push([table, "eq", column, value]); result = result.filter(row => row[column] === value); return query; },
      in: (column: string, values: unknown[]) => { filters.push([table, "in", column, values]); result = result.filter(row => values.includes(row[column])); return query; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: result, error: null }).then(resolve),
    };
    return query;
  });
  return { admin: { from } as unknown as SupabaseClient<Database>, organizationId: "org-1", environment: "production" as const, logger: vi.fn(), filters, from };
}

describe("browser timing log authorization", () => {
  it("logs only exact legs owned by the actor in the organization and deployment environment", async () => {
    const h = harness();
    await logBrowserCallObservations(h, "profile-1", [entry, ...["control-other", "control-other-org", "control-dev", "made-up"].map(callControlId => ({ ...entry, callControlId }))]);
    expect(h.logger).toHaveBeenCalledTimes(1);
    expect(h.logger).toHaveBeenCalledWith({ scope: "browser_call_timing", source: "browser", observationId: entry.id, pageId: entry.pageId,
      sessionId: "session-1", legId: "leg-1", environment: "production", phase: "ringtone_start", browserMonotonicMs: 1200, outcome: "ok", durationMs: 3 });
    expect(JSON.stringify(h.logger.mock.calls)).not.toContain("control-1");
    expect(h.filters).toContainEqual(["motorist_call_sessions", "eq", "metadata->>environment", "production"]);
  });

  it("does no reads for an empty batch and swallows diagnostic read failure", async () => {
    const h = harness();
    await logBrowserCallObservations(h, "profile-1", []);
    expect(h.from).not.toHaveBeenCalled();
    h.from.mockImplementationOnce(() => { throw new Error("database unavailable"); });
    await expect(logBrowserCallObservations(h, "profile-1", [entry])).resolves.toBeUndefined();
    expect(h.logger).not.toHaveBeenCalled();
  });

  it("isolates an asynchronously rejected log sink", async () => {
    const h = harness();
    h.logger.mockRejectedValue(new Error("log sink unavailable"));
    await expect(logBrowserCallObservations(h, "profile-1", [entry])).resolves.toBeUndefined();
  });
});
