import { describe, expect, it } from "vitest";

import {
  ONE_SHOT_JOB_NAMES,
  ONE_SHOT_TARGET_REF,
  failedOneShotOutput,
  oneShotOutput,
  parseOneShotRequest,
  projectOneShotSummary,
  serializeOneShotOutput,
} from "./one-shot-contract";

const TARGET_URL = `https://${ONE_SHOT_TARGET_REF}.supabase.co`;

function productionEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    MOTORIST_DEV_AUTH_BYPASS: "false",
    DEPLOYMENT_VERSION: "manual-test",
    SCHEDULER_ENABLED: "false",
    SUPABASE_PROJECT_REF: ONE_SHOT_TARGET_REF,
    SUPABASE_URL: TARGET_URL,
    NEXT_PUBLIC_SUPABASE_URL: TARGET_URL,
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    SUPABASE_SECRET_KEY: "sb_secret_test",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
    ...overrides,
  };
}

function commonArguments(job: string) {
  return [
    "--job",
    job,
    "--expected-project-ref",
    ONE_SHOT_TARGET_REF,
    "--acknowledge-target-writes",
  ];
}

describe("one-shot job contract", () => {
  it("uses a closed allowlist without either SWHouse job", () => {
    expect(ONE_SHOT_JOB_NAMES).toHaveLength(6);
    expect(ONE_SHOT_JOB_NAMES).not.toContain("fleet.swhouse.occupancy");
    expect(ONE_SHOT_JOB_NAMES).not.toContain("fleet.swhouse.roster");
    expect(() => parseOneShotRequest(commonArguments("fleet.swhouse.roster"), productionEnv())).toThrow();
  });

  it("returns fixed, minimal payloads rather than accepting caller payloads", () => {
    expect(parseOneShotRequest(commonArguments("notifications.materialize").concat("--acknowledge-external-delivery"), productionEnv()))
      .toMatchObject({ job: "notifications.materialize", payload: { limit: 1 } });
    expect(parseOneShotRequest(commonArguments("fleet.commander.catalog"), productionEnv()))
      .toMatchObject({ job: "fleet.commander.catalog", payload: {} });
    expect(parseOneShotRequest(commonArguments("telephony.transcripts.process").concat("--acknowledge-paid-ai"), productionEnv()))
      .toMatchObject({ job: "telephony.transcripts.process", payload: { maxItems: 1 } });
    expect(() => parseOneShotRequest(commonArguments("fleet.commander.catalog").concat("--payload", "{}"), productionEnv()))
      .toThrow();
  });

  it("requires the specific acknowledgement for external delivery and paid AI", () => {
    expect(() => parseOneShotRequest(commonArguments("notifications.materialize"), productionEnv())).toThrow();
    expect(() => parseOneShotRequest(commonArguments("telephony.transcripts.process"), productionEnv())).toThrow();
    expect(() => parseOneShotRequest(commonArguments("fleet.commander.catalog").concat("--acknowledge-paid-ai"), productionEnv()))
      .toThrow();
  });

  it("requires the exact disabled scheduler state and exact production target", () => {
    expect(() => parseOneShotRequest(commonArguments("fleet.commander.catalog"), productionEnv({ SCHEDULER_ENABLED: "False" })))
      .toThrow();
    expect(() => parseOneShotRequest(commonArguments("fleet.commander.catalog"), productionEnv({ SUPABASE_PROJECT_REF: "other" })))
      .toThrow();
    expect(() => parseOneShotRequest([
      "--job",
      "fleet.commander.catalog",
      "--expected-project-ref",
      "other",
      "--acknowledge-target-writes",
    ], productionEnv())).toThrow();
  });

  it("projects only the job's aggregate numeric and enumerated status fields", () => {
    expect(projectOneShotSummary("fleet.commander.catalog", {
      status: "success",
      fetchedCount: 5,
      createdCount: 2,
      updatedCount: 3,
      errorCount: 0,
      providerUrl: "https://provider.invalid/private",
      phone: "+421900123456",
      error: "secret provider response",
      nested: { email: "person@example.com" },
    })).toEqual({
      fetchedCount: 5,
      createdCount: 2,
      updatedCount: 3,
      errorCount: 0,
      status: "success",
    });
  });

  it("rejects malformed aggregates and unapproved status values", () => {
    expect(() => projectOneShotSummary("notifications.materialize", {
      processed: 1,
      sent: 0,
      cancelled: 0,
      failed: -1,
    })).toThrow();
    expect(() => projectOneShotSummary("fleet.commander.positions", {
      status: "partial",
      fetchedCount: 1,
      updatedCount: 1,
      skippedCount: 0,
      errorCount: 0,
    })).toThrow();
  });

  it("serializes exactly one safe JSON line with the fixed five-field schema", () => {
    const result = oneShotOutput("notifications.materialize", "success", {
      processed: 1,
      sent: 1,
      cancelled: 0,
      failed: 0,
      recipient: "person@example.com",
    });
    const serialized = serializeOneShotOutput(result);

    expect(Object.keys(result)).toEqual(["schema", "ok", "job", "status", "summary"]);
    expect(serialized.split("\n")).toHaveLength(2);
    expect(serialized).not.toContain("person@example.com");
    expect(JSON.parse(serialized)).toEqual(result);
  });

  it("never includes an error message or stack in a failed result", () => {
    expect(failedOneShotOutput("invalid")).toEqual({
      schema: "motorist-one-shot/v1",
      ok: false,
      job: "invalid",
      status: "failed",
      summary: {},
    });
  });
});
