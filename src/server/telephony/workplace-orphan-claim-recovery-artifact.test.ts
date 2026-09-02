import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const recovery = read("deploy/supabase/viptel-workplace-orphan-webphone-claim-recover.sql");
const runbook = read("docs/operations/viptel-workplace-bootstrap.md");
const automaticMigration = read("supabase/migrations/20260807102059_dynamic_hotdesk_workplaces.sql");

describe("manual orphan webphone assignment-claim recovery", () => {
  it("requires exact claim, row-version, provider evidence and audit inputs", () => {
    for (const input of [
      "organization_id",
      "actor_profile_id",
      "extension",
      "expected_profile_id",
      "expected_claim_id",
      "expected_extension_updated_at",
      "provider_snapshot_command_id",
      "provider_evidence_captured_at",
      "recovery_audit_id",
      "recovery_reference",
    ]) {
      expect(recovery).toContain(`:{?${input}}`);
    }
    expect(recovery).toContain("begin isolation level serializable;");
    expect(recovery).toContain("pg_advisory_xact_lock");
    expect(recovery).toContain("for update");
    expect(recovery).toContain("e.updated_at = v_input.expected_extension_updated_at");
    expect(recovery).toContain("e.metadata = v_extension.metadata");
    expect(recovery).toContain("HOTDESK_ORPHAN_CLAIM_RECOVERY_CAS_LOST");
  });

  it("accepts only one stale exact webphone-session claim with immutable lifecycle authority", () => {
    expect(recovery).toContain("v_claim->>'action' <> 'webphone.session.issue'");
    expect(recovery).toContain("v_claim->>'claimId' <> v_input.expected_claim_id::text");
    expect(recovery).toContain("interval '2 minutes'");
    expect(recovery).toContain("telephony.extension.assign");
    expect(recovery).toContain("assignment_lifecycle");
    expect(recovery).toContain("HOTDESK_ORPHAN_CLAIM_RECOVERY_COMMAND_OWNS_CLAIM");
    expect(recovery).toContain("HOTDESK_ORPHAN_CLAIM_RECOVERY_DB_CALL_ACTIVE");
    expect(recovery).toContain("HOTDESK_ORPHAN_CLAIM_RECOVERY_DB_COMMAND_ACTIVE");
  });

  it("requires one fresh HMAC-bearing provider snapshot proving all seats and queues idle", () => {
    expect(recovery).toContain("c.command_type = 'provider.snapshot'");
    expect(recovery).toContain("v_evidence.status <> 'confirmed_by_event'");
    expect(recovery).toContain("requestHmac");
    expect(recovery).toContain("responseHmac");
    expect(recovery).toContain("interval '5 minutes'");
    expect(recovery).toContain("jsonb_array_length(v_snapshot->'activeCalls') <> 0");
    expect(recovery).toContain("personalExtensions");
    expect(recovery).toContain("('20', '21', '22', '23')");
    expect(recovery).toContain("('601', '602', '603')");
    expect(recovery).toContain("q.value->'waitingCalls' is distinct from '0'::jsonb");
    expect(recovery).toContain("m.value->'inUse' is distinct from 'false'::jsonb");
  });

  it("refreshes only the exact provider projection and removes only the target claim", () => {
    const update = recovery.match(
      /update public\.motorist_telephony_extensions e\s+set([\s\S]*?)from pg_catalog\.jsonb_array_elements/,
    )?.[1];
    expect(update).toBeTruthy();
    expect(update).toContain("metadata = case when e.id = v_extension.id then v_next_metadata else e.metadata end");
    expect(update).toContain("is_registered =");
    expect(update).toContain("is_viptel_phone_active =");
    expect(update).toContain("last_synced_at = v_input.provider_evidence_captured_at");
    expect(update).not.toMatch(/\bprofile_id\s*=/);
    expect(update).not.toMatch(/\bactive\s*=/);
    expect(recovery).toContain("get diagnostics v_updated_count = row_count");
    expect(recovery).toContain("v_updated_count <> 4");
    expect(recovery).not.toMatch(/update\s+public\.motorist_telephony_queues/i);
    expect(recovery).not.toMatch(/update\s+public\.motorist_profiles/i);
  });

  it("writes one immutable, exact and replay-safe recovery audit", () => {
    expect(recovery).toContain("'telephony.extension.assignment_claim.recovered'");
    expect(recovery).toContain("'manual_orphan_webphone_claim_recovery'");
    expect(recovery).toContain("'providerSnapshotCommandId'");
    expect(recovery).toContain("'providerCapturedAt'");
    expect(recovery).toContain("'providerProjectionBefore'");
    expect(recovery).toContain("'providerProjectionAfter'");
    expect(recovery).toContain("'routingSnapshot'");
    expect(recovery).toContain("already_recovered");
    expect(recovery).toContain("HOTDESK_ORPHAN_CLAIM_RECOVERY_AUDIT_ID_CONFLICT");
    expect(recovery).not.toMatch(/delete\s+from\s+public\.motorist_audit_log/i);
    expect(recovery).not.toMatch(/update\s+public\.motorist_audit_log/i);
  });

  it("stays outside migrations and documents the guarded operator flow", () => {
    expect(automaticMigration).not.toContain("telephony.extension.assignment_claim.recovered");
    expect(runbook).toContain("Recovery osirelého webphone claimu");
    expect(runbook).toContain("viptel-workplace-orphan-webphone-claim-recover.sql");
    expect(runbook).toContain("is_registered");
    expect(runbook).toContain("is_viptel_phone_active");
    expect(runbook).toContain("last_synced_at");
    expect(runbook).toContain("nemení vlastníka");
  });
});
