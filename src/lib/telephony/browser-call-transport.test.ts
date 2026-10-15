import { describe, expect, it, vi } from "vitest";
import { BrowserCallTelemetry } from "./browser-call-telemetry";
import { BrowserCallTransport } from "./browser-call-transport";

describe("call observation acknowledgement", () => {
  it("retains measurements on an empty/legacy 200 and accepts only IDs from the submitted batch", async () => {
    let now = 0;
    const queue = new BrowserCallTelemetry(() => now);
    queue.record("control", "sdk_invite");
    const id = queue.batch()[0].id;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true }))
      .mockImplementationOnce(async () => {
        queue.record("control", "sdk_active");
        return Response.json({ loggedIds: [id, queue.batch()[1].id, "unknown"] });
      });
    const transport = new BrowserCallTransport(queue, fetcher, () => now);
    await transport.flush();
    expect(queue.batch()).toHaveLength(1);
    now = 5_000;
    await transport.flush();
    expect(queue.batch().map(entry => entry.phase)).toEqual(["sdk_active"]);
  });

  it("deduplicates in-flight requests and backs off failed log acceptance", async () => {
    let now = 0;
    const queue = new BrowserCallTelemetry(() => now);
    queue.record("control", "sdk_invite");
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(done => { resolve = done; }));
    const transport = new BrowserCallTransport(queue, fetcher, () => now);
    const pending = transport.flush();
    await transport.flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(Response.json({}, { status: 503 }));
    await pending;
    now = 4_999;
    await transport.flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(queue.batch()).toHaveLength(1);
  });

  it("lets a correlated new call pass a full unmatched batch without losing the original IDs", async () => {
    let now = 0;
    const queue = new BrowserCallTelemetry(() => now);
    for (let index = 0; index < 16; index++) queue.record(`old-${index}`, "sdk_invite");
    const first = queue.batch();
    queue.record("new", "sdk_invite");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      const rows = JSON.parse(options!.body as string).observations as Array<{ id: string; callControlId: string }>;
      return Response.json({ loggedIds: rows.filter(row => row.callControlId === "new").map(row => row.id) });
    });
    const transport = new BrowserCallTransport(queue, fetcher, () => now);
    await transport.flush(); now = 5_000; await transport.flush();
    expect(queue.batch().map(row => row.id).sort()).toEqual(first.map(row => row.id).sort());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

it("flushes request metrics through the existing endpoint without call observations and retains failed acknowledgements", async () => {
  const { RequestPerformanceQueue } = await import("./request-performance");
  let now = 0;
  const queue = new RequestPerformanceQueue(() => now);
  const row = {id:"00000000-0000-4000-8000-000000000001",operation:"call.park" as const,ms:321,outcome:"ok" as const};
  queue.record(row);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ loggedIds: [] })).mockResolvedValueOnce(Response.json({ loggedIds: [], performanceIds: [row.id] }));
  const transport = new BrowserCallTransport(new BrowserCallTelemetry(), fetcher, () => now, queue);
  await transport.flush(); expect(queue.batch()).toHaveLength(1);
  now = 5000; await transport.flush(); expect(queue.batch()).toHaveLength(0);
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({observations:[],requestTimings:[row]});
});
