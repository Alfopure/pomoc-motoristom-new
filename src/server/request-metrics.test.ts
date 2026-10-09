import { describe, expect, it, vi } from "vitest";
import { channel } from "node:diagnostics_channel";

import { measureControlStage, measureRequestStep, observeDatabaseTimeout, recordRequestStep, registerDatabaseOrigin, requestStepCount, withBackgroundRequestMetrics, withRequestMetrics, type ControlStage } from "./request-metrics";

describe("request metrics", () => {
  it("starts independent after counters with the response request identity", async () => {
    const logger = vi.fn();
    let background!: () => Promise<void>;
    const response = await withRequestMetrics("call.webhook", async () => {
      recordRequestStep("db", 30);
      background = withBackgroundRequestMetrics(async () => {
        expect(requestStepCount("db")).toBeNull();
        recordRequestStep("db", 7);
        expect(requestStepCount("db")).toBe(1);
      });
      return Response.json({});
    }, { logger });
    const original = structuredClone(logger.mock.calls[0][0]);
    await background();
    expect(logger.mock.calls[0][0]).toEqual(original);
    expect(logger.mock.calls[1][0]).toMatchObject({ phase: "after", requestId: response.headers.get("x-request-id"), steps: { db: { count: 1, ms: 7 } } });
  });

  it("measures the first-issued database request and the maximum despite overlap", async () => {
    const logger = vi.fn();
    let time = 0;
    let release!: () => void;
    await withRequestMetrics("call.action", async () => {
      const first = measureRequestStep("db", () => new Promise<void>(resolve => { release = resolve; }));
      time = 1;
      await measureRequestStep("db", async () => { time = 3; });
      time = 10;
      release();
      await first;
      return Response.json({});
    }, { logger, now: () => time });
    expect(logger.mock.calls[0][0]).toMatchObject({ dbFirstMs: 10, dbMaxMs: 10, steps: { db: { count: 2, ms: 12 } } });
  });

  it("separates observed database sockets and fired timeouts without logging destinations", async () => {
    const logger = vi.fn();
    await withRequestMetrics("call.action", async () => {
      registerDatabaseOrigin("https://private-project.supabase.co/rest/v1/calls?secret=value");
      channel("undici:client:connected").publish({ connectParams: { hostname: "telnyx.example" } });
      channel("undici:client:connected").publish({ connectParams: { hostname: "private-project.supabase.co" } });
      const active = new AbortController();
      const finished = new AbortController();
      const detach = observeDatabaseTimeout(active.signal);
      observeDatabaseTimeout(finished.signal)();
      active.abort(new DOMException("deadline reached", "TimeoutError"));
      detach();
      finished.abort();
      return Response.json({});
    }, { logger });
    expect(logger.mock.calls[0][0]).toMatchObject({ dbConnects: 1, dbConnectsScope: "instance-window", dbAborts: 1 });
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/private-project|secret|telnyx/);
  });

  it("counts an already expired caller deadline but not cancellation or a completed request", async () => {
    const logger = vi.fn();
    await withRequestMetrics("call.action", async () => {
      const expired = AbortSignal.abort(new DOMException("private deadline", "TimeoutError"));
      observeDatabaseTimeout(expired)();
      const cancelled = new AbortController();
      const detach = observeDatabaseTimeout(cancelled.signal);
      cancelled.abort(new DOMException("private cancellation", "AbortError"));
      detach();
      const completed = new AbortController();
      observeDatabaseTimeout(completed.signal)();
      completed.abort(new DOMException("late deadline", "TimeoutError"));
      return Response.json({});
    }, { logger });
    expect(logger.mock.calls[0][0]).toMatchObject({ dbAborts: 1 });
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/private|deadline|cancellation/);
  });
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

  it("attributes overlapping database work to its control stage without counting unrelated requests", async () => {
    const logger = vi.fn();
    let time = 0;
    let release!: () => void;
    const response = await withRequestMetrics("call.action", async () => {
      const ack = measureControlStage("recording.ack", () => measureRequestStep("db", () =>
        new Promise<void>(resolve => { release = resolve; })));
      time = 1;
      await measureControlStage("participants", () => measureRequestStep("db", async () => { time = 3; }));
      time = 4;
      await measureRequestStep("db", async () => { time = 5; });
      time = 10;
      release();
      await ack;
      return Response.json({});
    }, { logger, now: () => time });
    expect(logger.mock.calls[0][0]).toMatchObject({ steps: {
      "control.recording.ack": { count: 1, ms: 10, dbCount: 1, dbMs: 10 },
      "control.participants": { count: 1, ms: 2, dbCount: 1, dbMs: 2 },
      db: { count: 3, ms: 13 },
    } });
    expect(response.headers.get("server-timing")).toContain("control.recording.ack;dur=10.0");
  });

  it("attributes nested database work once and aggregates repeated control stages", async () => {
    const logger = vi.fn();
    let time = 0;
    await withRequestMetrics("call.action", async () => {
      await measureControlStage("projection", async () => {
        await measureRequestStep("db", async () => { time += 3; });
        await measureControlStage("participants", () => measureRequestStep("db", async () => { time += 4; }));
        await measureRequestStep("db", async () => { time += 5; });
      });
      await measureControlStage("projection", () => measureRequestStep("db", async () => { time += 2; }));
      return Response.json({});
    }, { logger, now: () => time });
    expect(logger.mock.calls[0][0]).toMatchObject({ steps: {
      "control.projection": { count: 2, ms: 14, dbCount: 3, dbMs: 10 },
      "control.participants": { count: 1, ms: 4, dbCount: 1, dbMs: 4 },
      db: { count: 4, ms: 14 },
    } });
  });

  it("does not attribute unawaited database work to a completed stage or inherit it into after work", async () => {
    const logger = vi.fn();
    let time = 0;
    let release!: () => void;
    let late!: Promise<void>;
    let background!: () => Promise<void>;
    await withRequestMetrics("call.action", async () => {
      await measureControlStage("audit", async () => {
        late = measureRequestStep("db", () => new Promise<void>(resolve => { release = resolve; }));
        background = withBackgroundRequestMetrics(async () => {
          await measureRequestStep("db", async () => { time += 2; });
        });
        time = 1;
      });
      time = 3;
      release();
      await late;
      return Response.json({});
    }, { logger, now: () => time });
    await background();
    expect(logger.mock.calls[0][0]).toMatchObject({ phase: "response", steps: {
      "control.audit": { count: 1, ms: 1, dbCount: 0, dbMs: 0 },
      db: { count: 1, ms: 3 },
    } });
    expect(logger.mock.calls[1][0]).toMatchObject({ phase: "after", steps: { db: { count: 1, ms: 2 } } });
    expect(logger.mock.calls[1][0].steps).not.toHaveProperty("control.audit");
  });

  it("preserves committed stage values and original errors when timing or logging fails", async () => {
    const logger = vi.fn(() => { throw new Error("sink unavailable"); });
    let clockFailed = false;
    const failure = new Error("private SQL payload");
    const response = await withRequestMetrics("call.action", async () => {
      const value = await measureControlStage("finalize", async () => {
        clockFailed = true;
        return "committed";
      });
      clockFailed = false;
      expect(value).toBe("committed");
      await expect(measureControlStage("recording.ack", async () => {
        clockFailed = true;
        throw failure;
      })).rejects.toBe(failure);
      clockFailed = false;
      return Response.json({ ok: true });
    }, { logger, now: () => {
      if (clockFailed) throw new Error("clock unavailable");
      return 0;
    } });
    expect(await response.json()).toEqual({ ok: true });
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/committed|private SQL|clock unavailable/);
  });

  it("keeps stage cardinality closed and passes through work outside request metrics", async () => {
    const logger = vi.fn();
    const work = vi.fn(async () => "private customer value");
    expect(await measureControlStage("audit", work)).toBe("private customer value");
    await withRequestMetrics("call.action", async () => {
      expect(await measureControlStage("private provider ID" as ControlStage, work)).toBe("private customer value");
      return Response.json({});
    }, { logger });
    expect(work).toHaveBeenCalledTimes(2);
    expect(logger.mock.calls[0][0]).toMatchObject({ steps: {} });
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/private|provider ID/);
  });
});
