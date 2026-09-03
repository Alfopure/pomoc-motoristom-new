import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runTelephonyCronJobs = vi.fn();
const createTelephonyDeps = vi.fn(async () => ({ marker: "deps" }));

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
    await expect(response.json()).resolves.toEqual(SUMMARY);
    expect(createTelephonyDeps).toHaveBeenCalledWith({ sweepAfterEvent: false });
    expect(runTelephonyCronJobs).toHaveBeenCalledWith({ marker: "deps" });
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
