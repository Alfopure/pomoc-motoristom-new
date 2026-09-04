import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runTelephonyCronJobs = vi.fn();
const createTelephonyDeps = vi.fn(async () => ({ marker: "deps", organizationId: "org-1" }));
const materializeDueTaskReminders = vi.fn(async () => ({ materialized: 0, skipped: 0 }));
let jobControl: { enabled: boolean } | null = { enabled: true };

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: jobControl, error: null }) }) }),
    }),
  }),
}));

vi.mock("@/server/task-notifications", () => ({
  materializeDueTaskReminders: (...args: unknown[]) => materializeDueTaskReminders(...(args as [])),
}));

vi.mock("@/server/telephony/cron-jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/cron-jobs")>();
  return { ...actual, runTelephonyCronJobs: (...args: unknown[]) => runTelephonyCronJobs(...args) };
});

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: (...args: unknown[]) => createTelephonyDeps(...(args as [])) };
});

import { GET } from "./route";

const SECRET = "test-cron-secret";

function cronRequest(token?: string) {
  return new Request("https://app.test/api/telephony/cron", { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

const SUMMARY = {
  status: "ok",
  checkedAt: "2026-09-03T08:00:00.000Z",
  organizationId: "org-1",
  configured: true,
  ms: 4,
  jobs: [
    { job: "telephony.ring.sweep", status: "ok", detail: { checked: 0, swept: 0, errors: [] } },
    { job: "telephony.sessions.stuck", status: "ok", detail: { stuck: 0 } },
    { job: "telephony.ledger.prune", status: "disabled", detail: { reason: "job_control_disabled" } },
  ],
};

describe("GET /api/telephony/cron", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    runTelephonyCronJobs.mockReset().mockResolvedValue(SUMMARY);
    createTelephonyDeps.mockClear();
    materializeDueTaskReminders.mockClear().mockResolvedValue({ materialized: 0, skipped: 0 });
    jobControl = { enabled: true };
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("rejects a request without the cron bearer token", async () => {
    const response = await GET(cronRequest());

    expect(response.status).toBe(401);
    expect(runTelephonyCronJobs).not.toHaveBeenCalled();
  });

  it("rejects a wrong token", async () => {
    expect((await GET(cronRequest("nope"))).status).toBe(401);
    expect(runTelephonyCronJobs).not.toHaveBeenCalled();
  });

  it("rejects everything when no secret is configured", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(cronRequest(SECRET))).status).toBe(401);
  });

  it("runs the jobs and answers with the summary", async () => {
    const response = await GET(cronRequest(SECRET));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    // The telephony summary plus the reminder job this deployment has nowhere
    // else to run (no worker, one allowed cron).
    await expect(response.json()).resolves.toEqual({
      ...SUMMARY,
      jobs: [...SUMMARY.jobs, { job: "notifications.materialize", status: "ok", detail: { materialized: 0, skipped: 0 } }],
    });
    expect(createTelephonyDeps).toHaveBeenCalledWith({ sweepAfterEvent: false });
    expect(runTelephonyCronJobs).toHaveBeenCalledWith({ marker: "deps", organizationId: "org-1" });
    expect(materializeDueTaskReminders).toHaveBeenCalledTimes(1);
  });

  it("materialises due reminders, and honours the job control switch", async () => {
    materializeDueTaskReminders.mockResolvedValue({ materialized: 3, skipped: 1 });
    const ran = await (await GET(cronRequest(SECRET))).json();
    expect(ran.jobs.at(-1)).toEqual({ job: "notifications.materialize", status: "ok", detail: { materialized: 3, skipped: 1 } });

    jobControl = { enabled: false };
    materializeDueTaskReminders.mockClear();
    const off = await (await GET(cronRequest(SECRET))).json();
    expect(off.jobs.at(-1)).toEqual({ job: "notifications.materialize", status: "disabled", detail: { reason: "job_control_disabled" } });
    expect(materializeDueTaskReminders).not.toHaveBeenCalled();
  });

  it("degrades the tick when reminders fail, without losing the telephony summary", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    materializeDueTaskReminders.mockRejectedValue(new Error("reminders down"));

    const response = await GET(cronRequest(SECRET));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.jobs.at(-1)).toMatchObject({ job: "notifications.materialize", status: "failed", error: "reminders down" });
    expect(body.jobs).toHaveLength(SUMMARY.jobs.length + 1);
    consoleError.mockRestore();
  });

  it("still answers 200 with a degraded summary when a job failed", async () => {
    runTelephonyCronJobs.mockResolvedValue({ ...SUMMARY, status: "degraded" });

    const response = await GET(cronRequest(SECRET));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "degraded" });
  });

  it("returns 500 when the job runner throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    runTelephonyCronJobs.mockRejectedValue(new Error("supabase down"));

    const response = await GET(cronRequest(SECRET));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ status: "failed", jobs: [] });
    consoleError.mockRestore();
  });
});
