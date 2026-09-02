import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260901210000_workplace_sweeper.sql"),
  "utf8",
);

const RPCS = [
  "motorist_acquire_telephony_resource_claims",
  "motorist_renew_workplace_operation_claim",
  "motorist_release_terminal_telephony_resource_claims",
  "motorist_mark_workplace_operation_manual_recovery",
  "motorist_reap_expired_workplace_lease",
] as const;

describe("workplace sweeper migration security contract", () => {
  it.each(RPCS)("defines %s with a fixed search path and service-only execute", (rpc) => {
    const definition = migration.slice(migration.indexOf(`create or replace function public.${rpc}`));
    expect(definition.slice(0, definition.indexOf("$$;"))).toMatch(/security definer\s+set search_path = ''/);
    expect(migration).toMatch(new RegExp(`revoke all on function public\\.${rpc}\\([\\s\\S]*?from public, anon, authenticated;`));
    expect(migration).toMatch(new RegExp(`grant execute on function public\\.${rpc}\\([\\s\\S]*?to service_role;`));
    expect(migration).toMatch(new RegExp(`alter function public\\.${rpc}\\([\\s\\S]*?owner to postgres;`));
  });

  it("is safe to run more than once", () => {
    // It will be applied by hand in the SQL editor, so a partial run followed by
    // a full re-run must not fail.
    expect(migration).toContain("add column if not exists last_released_reason");
    expect(migration).toContain("create index if not exists motorist_guard_operations_terminal_idx");
    expect(migration).toContain("on conflict (job_name) do nothing");
    expect(migration).not.toMatch(/^\s*create table (?!if not exists)/m);
    // `add constraint` has no IF NOT EXISTS, so each one must sit behind an
    // explicit pg_constraint existence guard.
    const addConstraints = migration.match(/add constraint/g) ?? [];
    const guards = migration.match(/from pg_catalog\.pg_constraint/g) ?? [];
    expect(addConstraints).toHaveLength(guards.length);
    for (const match of addConstraints) {
      const at = migration.indexOf(match);
      const preceding = migration.slice(Math.max(0, at - 400), at);
      expect(preceding).toContain("pg_catalog.pg_constraint");
    }
  });

  it("never lets the lease reaper touch extension ownership", () => {
    // Half-releasing these correlated rows is the documented way to make a
    // workstation permanently stuck, so the reaper must stay lease-only.
    const reaper = migration.slice(
      migration.indexOf("create or replace function public.motorist_reap_expired_workplace_lease"),
    );
    const body = reaper.slice(0, reaper.indexOf("$$;"));
    expect(body).toContain("update public.motorist_workplace_leases");
    expect(body).not.toContain("motorist_telephony_extensions");
    expect(body).not.toContain("motorist_profiles");
  });

  it("reaps only a lease that is well past expiry and unreferenced", () => {
    const reaper = migration.slice(
      migration.indexOf("create or replace function public.motorist_reap_expired_workplace_lease"),
    );
    const body = reaper.slice(0, reaper.indexOf("$$;"));
    expect(body).toContain("interval '5 minutes'");
    expect(body).toContain("phase not in ('completed', 'aborted')");
    expect(body).toContain("TELEPHONY_RESOURCE_BUSY");
  });

  it("only self-heals a claim whose owner is terminal in both tables", () => {
    // Age alone must never free a claim: a persisted provider operation does not
    // become safe because time passed. Only a terminal operation AND a terminal
    // guard prove the release merely crashed.
    const acquire = migration.slice(
      migration.indexOf("create or replace function public.motorist_acquire_telephony_resource_claims"),
    );
    const body = acquire.slice(0, acquire.indexOf("$$;"));
    expect(body).toContain("v_owner_phase in ('completed', 'aborted') and v_owner_terminal_at is not null");
    expect(body).toContain("TELEPHONY_RESOURCE_BUSY");
    expect(body).toContain("TERMINAL_OWNER_RECLAIMED");
  });

  it("raises the claim ttl ceiling without changing the default", () => {
    // The switch/leave flow waits for a human to unplug a desk phone; the old
    // 120 s ceiling could not cover that, and finalize rejects an expired guard.
    expect(migration).toContain("least(coalesce(p_claim_ttl_seconds, 90), 300)");
  });

  it("writes manual_recovery_required only for a post-commit operation", () => {
    const mark = migration.slice(
      migration.indexOf("create or replace function public.motorist_mark_workplace_operation_manual_recovery"),
    );
    const body = mark.slice(0, mark.indexOf("$$;"));
    expect(body).toContain("phase not in ('ownership_committed', 'audits_verified')");
    expect(body).toContain("phase = 'manual_recovery_required'");
    // Claims stay held: a post-commit operation must roll forward, not be freed.
    expect(body).not.toContain("motorist_release_telephony_resource_claims");
  });

  it("registers the sweep job disabled", () => {
    expect(migration).toMatch(/insert into public\.motorist_job_controls[\s\S]*?'telephony\.workplace\.sweep', false/);
  });
});
