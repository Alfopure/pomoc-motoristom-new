import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260807102059_dynamic_hotdesk_workplaces.sql"),
  "utf8",
);

describe("dynamic workplace migration security contract", () => {
  it.each([
    "motorist_workplace_operations",
    "motorist_workplace_leases",
    "motorist_telephony_guard_operations",
    "motorist_workplace_resource_claims",
  ])("keeps %s server-only through RLS and explicit privilege revocation", (table) => {
    expect(migration).toContain(`alter table public.${table} enable row level security;`);
    expect(migration).toContain(`alter table public.${table} force row level security;`);
    expect(migration).toContain(`revoke all on table public.${table} from public, anon, authenticated;`);
    expect(migration).toContain(`grant select, insert, update, delete on table public.${table} to service_role;`);
  });

  it.each([
    "motorist_acquire_telephony_resource_claims",
    "motorist_release_telephony_resource_claims",
    "motorist_begin_workplace_operation",
    "motorist_mark_workplace_provider_checked",
    "motorist_heartbeat_workplace_lease",
    "motorist_resume_workplace_lease",
    "motorist_verify_workplace_lease",
    "motorist_finalize_workplace_operation",
    "motorist_abort_workplace_operation",
    "motorist_recover_expired_workplace_operation",
    "motorist_workplace_database_now",
  ])("defines %s with a fixed search path and service-only execute", (rpc) => {
    const definition = migration.slice(migration.indexOf(`create or replace function public.${rpc}`));
    expect(definition.slice(0, definition.indexOf("$$;"))).toMatch(/security definer\s+set search_path = ''/);
    expect(migration).toMatch(new RegExp(`revoke all on function public\\.${rpc}\\([\\s\\S]*?from public, anon, authenticated;`));
    expect(migration).toMatch(new RegExp(`grant execute on function public\\.${rpc}\\([\\s\\S]*?to service_role;`));
    expect(migration).toMatch(new RegExp(`alter function public\\.${rpc}\\([\\s\\S]*?owner to postgres;`));
  });

  it("uses an organization-wide lock before source/target discovery", () => {
    const begin = migration.slice(migration.indexOf("create or replace function public.motorist_begin_workplace_operation"));
    expect(begin.indexOf("motorist.workplace.")).toBeLessThan(begin.indexOf("select * into v_source"));
    expect(migration).toContain("order by value->>'resource_type', (value->>'resource_id')::uuid");
  });

  it("treats every stale-target heartbeat as a resume watermark", () => {
    const heartbeat = migration.slice(migration.indexOf("create or replace function public.motorist_heartbeat_workplace_lease"));
    const targetBranch = heartbeat.indexOf("v_operation.target_lease_id = v_lease.id");
    const resumeWrite = heartbeat.indexOf("set resume_requested_at = v_now", targetBranch);
    expect(targetBranch).toBeGreaterThan(0);
    expect(resumeWrite).toBeGreaterThan(targetBranch);
  });

  it("rechecks legacy extension interlocks after locking both seats", () => {
    const begin = migration.slice(migration.indexOf("create or replace function public.motorist_begin_workplace_operation"));
    expect(begin).toContain("metadata->'assignmentActionClaim'");
    expect(begin).toContain("metadata->'telephonyActionClaim'");
    expect(begin).toContain("metadata#>>'{assignmentTransition,active}'");
    expect(begin).toContain("metadata#>>'{workplaceOwnerTransition,active}'");
    expect(begin).toContain("metadata#>>'{dispatchRouting,operation,status}'");
    expect(begin).toContain("WORKPLACE_SOURCE_LEGACY_INTERLOCK_ACTIVE");
    expect(begin).toContain("WORKPLACE_TARGET_LEGACY_INTERLOCK_ACTIVE");
    const providerCheck = migration.slice(
      migration.indexOf("create or replace function public.motorist_mark_workplace_provider_checked"),
      migration.indexOf("create or replace function public.motorist_heartbeat_workplace_lease"),
    );
    const finalize = migration.slice(
      migration.indexOf("create or replace function public.motorist_finalize_workplace_operation"),
      migration.indexOf("create or replace function public.motorist_abort_workplace_operation"),
    );
    expect(providerCheck).toContain("WORKPLACE_SOURCE_CHANGED_AFTER_BEGIN");
    expect(providerCheck).toContain("WORKPLACE_TARGET_CHANGED_AFTER_BEGIN");
    expect(finalize).toContain("metadata->'assignmentActionClaim'");
    expect(finalize).toContain("metadata#>>'{assignmentTransition,active}'");
  });

  it("rechecks the telephony actor role immediately before the ownership commit", () => {
    const finalize = migration.slice(
      migration.indexOf("create or replace function public.motorist_finalize_workplace_operation"),
      migration.indexOf("create or replace function public.motorist_abort_workplace_operation"),
    );
    expect(finalize).toContain("and active = true");
    expect(finalize).toContain("and role in ('dispatcher', 'senior_dispatcher', 'manager', 'admin')");
    expect(finalize.indexOf("and role in ('dispatcher', 'senior_dispatcher', 'manager', 'admin')"))
      .toBeLessThan(finalize.indexOf("set phase = 'ownership_committed'"));
  });

  it("uses DB time, a hard 60 second lease and does not bootstrap live seats", () => {
    expect(migration).toContain("v_now timestamptz := pg_catalog.clock_timestamp()");
    expect(migration).toContain("expires_at <= heartbeat_at + interval '60 seconds'");
    expect(migration).not.toMatch(/update\s+public\.motorist_telephony_extensions\s+set\s+workplace_seat_generation/i);
    expect(migration).not.toMatch(/\b(601|602|603)\b/);
  });

  it("allows heartbeat version advancement only under the same browser leader fence", () => {
    const verify = migration.slice(migration.indexOf("create or replace function public.motorist_verify_workplace_lease"));
    expect(verify).toContain("v_lease.browser_instance_id <> p_browser_instance_id");
    expect(verify).toContain("v_lease.leader_epoch <> p_leader_epoch");
    expect(verify).toContain("p_lease_version > v_lease.lease_version");
    expect(verify).not.toContain("v_lease.lease_version <> p_lease_version");
  });

  it("makes heartbeat retry-safe after a lost renewal response", () => {
    const heartbeat = migration.slice(
      migration.indexOf("create or replace function public.motorist_heartbeat_workplace_lease"),
      migration.indexOf("create or replace function public.motorist_resume_workplace_lease"),
    );
    expect(heartbeat).toContain("p_lease_version > v_lease.lease_version");
    expect(heartbeat).not.toContain("v_lease.lease_version <> p_lease_version");
    expect(heartbeat).toContain("lease_version = lease_version + 1");
  });

  it("makes resume retry-safe after the atomic rotation response is lost", () => {
    const resume = migration.slice(
      migration.indexOf("create or replace function public.motorist_resume_workplace_lease"),
      migration.indexOf("create or replace function public.motorist_verify_workplace_lease"),
    );
    expect(resume).toContain("v_lease.resume_secret_hash = p_new_resume_secret_hash");
    expect(resume).toContain("v_lease.browser_instance_id = p_new_browser_instance_id");
    expect(resume).toContain("v_lease.leader_epoch = p_expected_leader_epoch + 1");
    expect(resume).toContain("v_lease.lease_version >= p_expected_lease_version + 1");
    expect(resume).toContain("p_idempotency_key uuid");
    expect(resume).toContain("p_idempotency_key is null");
    expect(resume).toContain("if v_lease.resume_secret_hash = p_new_resume_secret_hash then");
  });

  it("requires a DB-time fresh voluntary source lease before handoff", () => {
    const begin = migration.slice(migration.indexOf("create or replace function public.motorist_begin_workplace_operation"));
    expect(begin).toContain("v_source_lease.expires_at < v_now");
    expect(begin).toContain("WORKPLACE_SOURCE_LEASE_EXPIRED");
  });

  it("supports a target-only same-owner browser transfer only from an expired lease", () => {
    const begin = migration.slice(
      migration.indexOf("create or replace function public.motorist_begin_workplace_operation"),
      migration.indexOf("create or replace function public.motorist_mark_workplace_provider_checked"),
    );
    const finalize = migration.slice(
      migration.indexOf("create or replace function public.motorist_finalize_workplace_operation"),
      migration.indexOf("create or replace function public.motorist_abort_workplace_operation"),
    );
    expect(begin).not.toContain("WORKPLACE_BROWSER_TRANSFER_USE_RESUME");
    expect(begin).toContain("p_kind = 'browser_transfer' and (p_source_extension_id is not null");
    expect(begin).toContain("WORKPLACE_BROWSER_TRANSFER_OWNER_MISMATCH");
    expect(begin).toContain("WORKPLACE_BROWSER_TRANSFER_REQUIRES_NEW_BROWSER");
    expect(begin).toContain("v_target_lease.expires_at >= v_now");
    expect(finalize).toContain("v_operation.kind <> 'browser_transfer'");
    expect(finalize).toContain("WORKPLACE_BROWSER_TRANSFER_OWNER_CHANGED");
    expect(finalize).toContain("then 'browser_transfer' else 'offline_takeover'");
  });

  it("recovers only DB-time expired precommit operations", () => {
    const recovery = migration.slice(migration.indexOf("create or replace function public.motorist_recover_expired_workplace_operation"));
    expect(recovery).toContain("v_operation.phase in ('ownership_committed', 'audits_verified', 'completed')");
    expect(recovery).toContain("v_operation.claim_expires_at >= v_now");
    expect(recovery).toContain("motorist_release_telephony_resource_claims");
    expect(recovery).toContain("interval '30 seconds'");
  });

  it("enforces one current lease per profile and extension with org-safe foreign keys", () => {
    expect(migration).toContain("motorist_workplace_leases_one_current_extension_idx");
    expect(migration).toContain("motorist_workplace_leases_one_current_profile_idx");
    expect(migration).toContain("foreign key (organization_id, extension_id)");
    expect(migration).toContain("foreign key (organization_id, profile_id)");
  });

  it("anchors every canonical seat to the latest immutable lifecycle audit", () => {
    const begin = migration.slice(migration.indexOf("create or replace function public.motorist_begin_workplace_operation"));
    expect(begin).toContain("WORKPLACE_SOURCE_IMMUTABLE_LIFECYCLE_MISMATCH");
    expect(begin).toContain("WORKPLACE_TARGET_IMMUTABLE_LIFECYCLE_MISMATCH");
    expect(begin).toContain("after_payload->'assignment_lifecycle' is distinct from");
    expect(migration).toContain("HOTDESK_PREFLIGHT_DUPLICATE_ACTIVE_PROFILE_EXTENSION");
  });
});
