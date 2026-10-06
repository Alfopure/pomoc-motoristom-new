import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runTelephonyCronJobs = vi.fn();
const createTelephonyDeps = vi.fn(async () => ({ marker: "deps", organizationId: "org-1" }));
const materializeDueTaskReminders = vi.fn(async () => ({ materialized: 0, skipped: 0 }));
const materializeDuePauseEndingNotifications = vi.fn(async () => ({ checked: 0, delivered: 0 }));
const runRecordingProcessing = vi.fn();
const runDiagnosticsMaintenance = vi.fn();
let jobControl: { enabled: boolean } | null = { enabled: true };

vi.mock("@/server/telephony/recording-processing", () => ({ runRecordingProcessing: (...args: unknown[]) => runRecordingProcessing(...args) }));
vi.mock("@/server/diagnostics/service", () => ({ runDiagnosticsMaintenance: (...args: unknown[]) => runDiagnosticsMaintenance(...args) }));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ abortSignal: () => ({ maybeSingle: async () => ({ data: jobControl, error: null }) }) }) }),
    }),
  }),
}));

vi.mock("@/server/task-notifications", () => ({
  materializeDueTaskReminders: (...args: unknown[]) => materializeDueTaskReminders(...(args as [])),
}));

vi.mock("@/server/telephony/pause-ending-notifications", () => ({
  materializeDuePauseEndingNotifications: (...args: unknown[]) => materializeDuePauseEndingNotifications(...(args as [])),
}));

vi.mock("@/server/telephony/cron-jobs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/cron-jobs")>();
  return { ...actual, runTelephonyCronJobs: (...args: unknown[]) => runTelephonyCronJobs(...args) };
});

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: (...args: unknown[]) => createTelephonyDeps(...(args as [])) };
});

import { GET, maxDuration } from "./route";

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
    { job: "telephony.alerts", status: "ok", detail: { health: "ok", alerts: 0, sent: 0 } },
    { job: "telephony.ledger.prune", status: "disabled", detail: { reason: "job_control_disabled" } },
  ],
};

describe("GET /api/telephony/cron", () => {
  it("declares the 120 s budget", () => {
    // Under the 5-minute schedule by a wide margin: one run in flight, no lock.
    expect(maxDuration).toBe(120);
  });

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    vi.stubEnv("DIAGNOSTICS_ENABLED", "false");
    runTelephonyCronJobs.mockReset().mockResolvedValue(SUMMARY);
    createTelephonyDeps.mockClear();
    materializeDueTaskReminders.mockClear().mockResolvedValue({ materialized: 0, skipped: 0 });
    materializeDuePauseEndingNotifications.mockClear().mockResolvedValue({ checked: 0, delivered: 0 });
    runRecordingProcessing.mockReset().mockResolvedValue({ job: "telephony.recordings.process", status: "ok", detail: { processed: 0 } });
    runDiagnosticsMaintenance.mockReset().mockResolvedValue({ job: "diagnostics.maintenance", status: "disabled", detail: {} });
    jobControl = { enabled: true };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
    const body = await response.json();
    expect(body).toMatchObject({
      ...SUMMARY,
      checkedAt: expect.any(String), ms: expect.any(Number), executionStatus: "ok", telephonyHealth: "ok", failedJobs: [],
      jobs: [...SUMMARY.jobs, { job: "notifications.materialize", status: "ok", detail: { materialized: 0, skipped: 0 } }, { job: "notifications.pause-ending", status: "ok", detail: { checked: 0, delivered: 0 } }, { job: "telephony.recordings.process", status: "ok", detail: { processed: 0 } }, { job: "diagnostics.maintenance", status: "disabled", detail: {} }],
    });
    expect(body.jobs).toHaveLength(SUMMARY.jobs.length + 4);
    // The tail jobs are timed too, so the budget split is visible in the response.
    for (const job of body.jobs.slice(-4)) expect(job).toMatchObject({ ms: expect.any(Number), startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(createTelephonyDeps).toHaveBeenCalledWith({ sweepAfterEvent: false });
    expect(runTelephonyCronJobs).toHaveBeenCalledWith({ marker: "deps", organizationId: "org-1" }, { cronStartedAt: expect.any(Number) });
    expect(materializeDueTaskReminders).toHaveBeenCalledTimes(1);
    expect(materializeDuePauseEndingNotifications).toHaveBeenCalledTimes(1);
  });

  it("materialises due reminders, and honours the job control switch", async () => {
    materializeDueTaskReminders.mockResolvedValue({ materialized: 3, skipped: 1 });
    const ran = await (await GET(cronRequest(SECRET))).json();
    expect(ran.jobs.find((job: {job: string}) => job.job === "notifications.materialize")).toMatchObject({ job: "notifications.materialize", status: "ok", detail: { materialized: 3, skipped: 1 } });

    jobControl = { enabled: false };
    materializeDueTaskReminders.mockClear();
    const off = await (await GET(cronRequest(SECRET))).json();
    expect(off.jobs.find((job: {job: string}) => job.job === "notifications.materialize")).toMatchObject({ job: "notifications.materialize", status: "disabled", detail: { reason: "job_control_disabled" } });
    expect(materializeDueTaskReminders).not.toHaveBeenCalled();
  });

  it("degrades the tick when reminders fail, without losing the telephony summary", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    materializeDueTaskReminders.mockRejectedValue(new Error("reminders down"));

    const response = await GET(cronRequest(SECRET));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.jobs.find((job: {job: string}) => job.job === "notifications.materialize")).toMatchObject({ job: "notifications.materialize", status: "failed", error: "reminders down" });
    expect(body.jobs).toHaveLength(SUMMARY.jobs.length + 4);
    consoleError.mockRestore();
  });

  it("degrades the tick when pause warning materialization fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    materializeDuePauseEndingNotifications.mockRejectedValue(new Error("pause warnings down"));

    const body = await (await GET(cronRequest(SECRET))).json();
    expect(body.status).toBe("degraded");
    expect(body.jobs.find((job: {job: string}) => job.job === "notifications.pause-ending")).toMatchObject({ job: "notifications.pause-ending", status: "failed", error: "pause warnings down" });
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
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('"executionStatus":"failed"'));
    consoleError.mockRestore();
  });

  it.each(["diagnostics", "recordings"])("logs and returns a late %s failure instead of the earlier green summary", async failing => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const job = failing === "diagnostics" ? "diagnostics.maintenance" : "telephony.recordings.process";
    (failing === "diagnostics" ? runDiagnosticsMaintenance : runRecordingProcessing).mockResolvedValue({ job, status: "failed", detail: { reason: "unavailable" }, error: "private database response" });
    const body = await (await GET(cronRequest(SECRET))).json();
    const runtime = JSON.parse(log.mock.calls.find(([line]) => String(line).includes("telephony-cron-runtime"))![0]);
    expect(body).toMatchObject({ status: "degraded", executionStatus: "degraded", telephonyHealth: "ok", failedJobs: [job] });
    expect(runtime).toMatchObject({ status: body.status, executionStatus: body.executionStatus, telephonyHealth: body.telephonyHealth, failedJobs: [job], checkedAt: body.checkedAt, ms: body.ms });
    expect(runtime.jobs).toHaveLength(body.jobs.length);
    expect(JSON.stringify(runtime)).not.toContain("private database response");
    log.mockRestore();
  });

  it("distinguishes a successfully suppressed alert from unhealthy telephony", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    runTelephonyCronJobs.mockResolvedValue({ ...SUMMARY, jobs: SUMMARY.jobs.map(job => job.job === "telephony.alerts"
      ? { ...job, detail: { health: "fail", alerts: 13, sent: 0, suppressed: 13 } } : job) });
    const body = await (await GET(cronRequest(SECRET))).json();
    const runtime = JSON.parse(log.mock.calls.find(([line]) => String(line).includes("telephony-cron-runtime"))![0]);
    expect(body).toMatchObject({ status: "degraded", executionStatus: "ok", telephonyHealth: "fail", failedJobs: [] });
    expect(runtime).toMatchObject({ status: "degraded", executionStatus: "ok", telephonyHealth: "fail", alerts: { detected: 13, sent: 0, suppressed: 13 } });
    log.mockRestore();
  });
});
