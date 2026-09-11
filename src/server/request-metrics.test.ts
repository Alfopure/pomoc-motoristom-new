import { describe, expect, it, vi } from "vitest";

import { measureRequestStep, recordRequestStep, withRequestMetrics } from "./request-metrics";

describe("request metrics", () => {
  it("keeps overlapping requests isolated and never records request or response data", async () => {
    const logger = vi.fn();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const first = withRequestMetrics("case.save", async () => {
      await measureRequestStep("write", async () => { await wait; return "private customer value"; });
      return Response.json({ contact: "private response" }, { status: 200 });
    }, { logger });
    const second = await withRequestMetrics("call.action", async () => {
      recordRequestStep("provider", 12);
      return Response.json({ command: "secret-provider-identifier" });
    }, { logger });
    release();
    const result = await first;
    expect(result.headers.get("x-request-id")).not.toBe(second.headers.get("x-request-id"));
    expect(result.headers.get("server-timing")).toContain("write;dur=");
    expect(result.headers.get("server-timing")).not.toContain("provider");
    expect(second.headers.get("server-timing")).toContain("provider;dur=12.0");
    expect(logger.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({ route: "call.action", steps: { provider: { count: 1, ms: 12 } } }),
      expect.objectContaining({ route: "case.save", steps: { write: { count: 1, ms: expect.any(Number) } } }),
    ]);
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/private|secret-provider/);
    expect(await result.json()).toEqual({ contact: "private response" });
  });

  it("measures failed operations without swallowing their original errors", async () => {
    const failure = new Error("private SQL payload");
    const logger = vi.fn();
    await expect(withRequestMetrics("case.save", async () => {
      await measureRequestStep("write", async () => { throw failure; });
      return Response.json({});
    }, { logger })).rejects.toBe(failure);
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ status: 500, steps: { write: { count: 1, ms: expect.any(Number) } } }));
    expect(JSON.stringify(logger.mock.calls)).not.toContain("private SQL");
  });

  it("preserves redirects whose response headers are immutable", async () => {
    const logger = vi.fn();
    const original = Response.redirect("https://app.example/auth");
    const response = await withRequestMetrics("case.get", async () => original, { logger });
    expect(response).toBe(original);
    expect(response.status).toBe(302);
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ status: 302, timingHeaders: false }));
  });

  it("ignores late background work and logging failures after a successful response", async () => {
    const logger = vi.fn(() => { throw new Error("sink unavailable"); });
    let late!: () => void;
    const response = await withRequestMetrics("call.action", async () => {
      late = () => recordRequestStep("provider", 9000);
      recordRequestStep("db", Number.NaN);
      recordRequestStep("db", -1);
      return Response.json({ ok: true });
    }, { logger });
    late();
    expect(await response.json()).toEqual({ ok: true });
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ status: 200, steps: {} }));
  });
});
