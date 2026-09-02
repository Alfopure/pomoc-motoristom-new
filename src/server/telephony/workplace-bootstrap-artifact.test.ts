import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const preflight = read("deploy/supabase/viptel-workplace-bootstrap-preflight.sql");
const apply = read("deploy/supabase/viptel-workplace-bootstrap-apply.sql");
const rollback = read("deploy/supabase/viptel-workplace-bootstrap-rollback.sql");
const runbook = read("docs/operations/viptel-workplace-bootstrap.md");
const automaticMigration = read("supabase/migrations/20260807102059_dynamic_hotdesk_workplaces.sql");
const receiptMigration = read("supabase/migrations/20260807102355_workplace_bootstrap_receipts.sql");

describe("manual VIPTel workplace bootstrap artifacts", () => {
  it.each([preflight, apply])("requires an exact explicit 20-23 ownership projection", (sql) => {
    expect(sql).toContain("HOTDESK_BOOTSTRAP_MIGRATION_20260807102059_REQUIRED");
    expect(sql).toContain("array['20','21','22','23']::text[]");
    for (const extension of ["20", "21", "22", "23"]) {
      expect(sql).toContain(`seat${extension}_profile_id`);
    }
    expect(sql).toContain("HOTDESK_BOOTSTRAP_DUPLICATE_PROFILE");
    expect(sql).toContain("expected_profile_id");
  });

  it("keeps the preflight read-only and fails closed on ambiguous provider/runtime state", () => {
    expect(preflight).toContain("begin transaction read only;");
    expect(preflight).toContain("HOTDESK_BOOTSTRAP_PROVIDER_EVIDENCE_STALE");
    expect(preflight).toContain("is_registered is distinct from false");
    expect(preflight).toContain("is_viptel_phone_active is distinct from false");
    expect(preflight).toContain("HOTDESK_BOOTSTRAP_IMMUTABLE_BASELINE_MISMATCH");
    expect(preflight).toContain("'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'");
    expect(preflight).toContain("HOTDESK_BOOTSTRAP_LIVE_ACTIVITY_PRESENT");
    expect(preflight).toContain("HOTDESK_BOOTSTRAP_DURABLE_OPERATION_PRESENT");
    expect(preflight).toContain("HOTDESK_BOOTSTRAP_ROUTING_NOT_QUIESCENT");
    expect(preflight).toContain("jsonb_path_exists");
    expect(preflight).not.toMatch(/update\s+public\./i);
    expect(preflight).not.toMatch(/delete\s+from\s+public\./i);
  });

  it("applies all seats atomically with canonical lifecycles and offline-only leases", () => {
    expect(apply).toContain("begin isolation level serializable;");
    expect(apply).toContain("pg_advisory_xact_lock");
    expect(apply).toContain("motorist_workplace_resource_claims");
    expect(apply).toContain("for update");
    expect(apply).toContain("workplace_seat_generation = v_seat_generation");
    expect(apply).toContain("'assignmentMode', 'workplace_claim'");
    expect(apply).toContain("'unassignedAt', v_iso");
    expect(apply).toContain("v_now - interval '61 seconds'");
    expect(apply).toContain("v_now - interval '1 second'");
    expect(apply).toContain("replace(gen_random_uuid()::text, '-', '')");
    expect(apply).toContain("HOTDESK_BOOTSTRAP_TERMINAL_AUDIT_NOT_HEAD");
    expect(apply).toContain("'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'");
    expect(apply).not.toMatch(/update\s+public\.motorist_telephony_queues/i);
    expect(apply).not.toMatch(/insert\s+into\s+public\.motorist_queue_memberships/i);
  });

  it("records a server-only exact receipt and permits only an exact idempotent replay", () => {
    expect(apply).toContain("to_regclass('public.motorist_workplace_bootstrap_receipts')");
    expect(receiptMigration).toContain("create table if not exists public.motorist_workplace_bootstrap_receipts");
    expect(receiptMigration).toContain("before_metadata jsonb not null");
    expect(receiptMigration).toContain("after_metadata jsonb not null");
    expect(receiptMigration).toContain("bootstrap_lease_row jsonb");
    expect(receiptMigration).toContain("provider_evidence_not_before timestamptz not null");
    expect(receiptMigration).toContain("guard_snapshot jsonb not null");
    expect(receiptMigration).toContain("routing_snapshot jsonb not null");
    expect(receiptMigration).toContain("force row level security");
    expect(receiptMigration).toContain("revoke all on table public.motorist_workplace_bootstrap_receipts from public");
    expect(apply).toContain("HOTDESK_BOOTSTRAP_BATCH_REUSE_MISMATCH");
    expect(apply).toContain("HOTDESK_BOOTSTRAP_IDEMPOTENT_STATE_CHANGED");
    expect(apply).toContain("HOTDESK_BOOTSTRAP_IDEMPOTENT_GUARD_CHANGED");
  });

  it("rolls back only an audited untouched batch and never erases immutable history", () => {
    expect(rollback).toContain("begin isolation level serializable;");
    expect(rollback).toContain("HOTDESK_BOOTSTRAP_ROLLBACK_STATE_CHANGED");
    expect(rollback).toContain("HOTDESK_BOOTSTRAP_ROLLBACK_GUARD_CHANGED");
    expect(rollback).toContain("HOTDESK_BOOTSTRAP_ROLLBACK_ROUTING_CHANGED");
    expect(rollback).toContain("HOTDESK_BOOTSTRAP_ROLLBACK_LIVE_ACTIVITY_PRESENT");
    expect(rollback).toContain("pg_catalog.to_jsonb(lease) = v_receipt.bootstrap_lease_row");
    expect(rollback).toContain("telephony.extension.bootstrap.rollback");
    expect(rollback).toContain("immutable_bootstrap_history_retained");
    expect(rollback).not.toMatch(/delete\s+from\s+public\.motorist_audit_log/i);
    expect(rollback).not.toMatch(/update\s+public\.motorist_telephony_queues/i);
  });

  it("remains operator-triggered and documents the external safety boundary", () => {
    expect(automaticMigration).not.toContain("motorist_workplace_bootstrap_receipts");
    expect(receiptMigration).not.toContain("manual_bootstrap");
    expect(automaticMigration).not.toContain("manual_bootstrap");
    expect(runbook).toContain("zámerne mimo");
    expect(runbook).toContain("SQL nedokáže zastaviť browser, listener ani SIP registráciu mimo databázy");
    expect(runbook).toContain("provider_evidence_not_before");
    expect(runbook).toContain("rovnakým `bootstrap_batch_id`");
    expect(runbook).toContain("vyžaduje skutočnú SIP");
  });
});
