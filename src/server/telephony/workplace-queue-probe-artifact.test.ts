import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const approve = read("deploy/supabase/viptel-workplace-queue-probe-approve.sql");
const revoke = read("deploy/supabase/viptel-workplace-queue-probe-revoke.sql");
const status = read("deploy/supabase/viptel-workplace-queue-probe-status.sql");
const runbook = read("docs/operations/viptel-workplace-queue-probe-approval.md");
const automaticMigration = read("supabase/migrations/20260807102059_dynamic_hotdesk_workplaces.sql");

describe("manual controlled queue-probe approval artifacts", () => {
  it("writes the exact immutable payload consumed by workplace handoff", () => {
    for (const key of [
      "schemaVersion",
      "capability",
      "organizationId",
      "profileId",
      "sourceExtension",
      "rootQueueId",
      "startsAt",
      "endsAt",
      "fallbackReference",
    ]) {
      expect(approve).toContain(`'${key}'`);
    }
    expect(approve).toContain("'telephony.workplace.queue_probe.approved'");
    expect(approve).toContain("'motorist_telephony_queues'");
    expect(approve).toContain("v_input.root_queue_id");
    expect(approve).toContain("begin isolation level serializable;");
    expect(approve).toContain("WORKPLACE_QUEUE_PROBE_EVIDENCE_ID_CONFLICT");
    expect(approve).toContain("WORKPLACE_QUEUE_PROBE_OVERLAPPING_APPROVAL");
    expect(approve).toContain("WORKPLACE_QUEUE_PROBE_APPROVAL_REVOKED");
  });

  it("bounds approval to one canonical queued owner and fresh empty queues", () => {
    expect(approve).toContain("v_input.source_extension not in ('20','21','22','23')");
    expect(approve).toContain("interval '12 hours'");
    expect(approve).toContain("p.role in ('dispatcher', 'senior_dispatcher', 'manager', 'admin')");
    expect(approve).toContain("q.external_id = '601'");
    expect(approve).toContain("q.line_id is null");
    expect(approve).toContain("'{dispatchRouting,currentPlan}'");
    expect(approve).toContain("'telephony.extension.assign'");
    expect(approve).toContain("e.workplace_seat_generation is not null");
    expect(approve).toContain("latest.waiting_calls = 0");
    expect(approve).toContain("latest.captured_at >= v_input.provider_evidence_not_before");
  });

  it("keeps revocation immutable and explicitly separate from runtime enforcement", () => {
    expect(revoke).toContain("HOTDESK_DISABLED_AND_PROBE_ENV_REMOVED");
    expect(revoke).toContain("'telephony.workplace.queue_probe.revoked'");
    expect(revoke).toContain("'approvalEvidenceId'");
    expect(revoke).toContain("'enforcement', 'hotdesk_disabled_and_probe_env_removed'");
    expect(revoke).toContain("WORKPLACE_QUEUE_PROBE_ALREADY_REVOKED");
    expect(revoke).not.toMatch(/delete\s+from\s+public\.motorist_audit_log/i);
    expect(revoke).not.toMatch(/update\s+public\.motorist_audit_log/i);
    expect(runbook).toContain("Revocation audit je prevádzkový dôkaz, nie kill switch");
    expect(runbook).toContain("VIPTEL_WORKPLACE_HOTDESK_ENABLED=false");
    expect(runbook).toContain("nový claim, takeover a switch");
    expect(runbook).toContain("existujúce leave, heartbeat, resume a recovery");
  });

  it("provides a read-only expiry/status check without pretending to know env state", () => {
    expect(status).toContain("begin transaction read only;");
    expect(status).toContain("'not_started'");
    expect(status).toContain("'expired'");
    expect(status).toContain("'revoked'");
    expect(status).toContain("Audit state does not prove runtime environment state.");
  });

  it("remains outside the automatic migration path and documents exact env mapping", () => {
    expect(automaticMigration).not.toContain("telephony.workplace.queue_probe.approved");
    for (const variable of [
      "VIPTEL_WORKPLACE_QUEUE_EVIDENCE_ID",
      "VIPTEL_WORKPLACE_QUEUE_PROBE_PROFILE_ID",
      "VIPTEL_WORKPLACE_QUEUE_PROBE_SOURCE_EXTENSION",
      "VIPTEL_WORKPLACE_QUEUE_PROBE_STARTS_AT",
      "VIPTEL_WORKPLACE_QUEUE_PROBE_ENDS_AT",
      "VIPTEL_WORKPLACE_QUEUE_PROBE_FALLBACK_REFERENCE",
    ]) {
      expect(runbook).toContain(variable);
    }
  });
});
