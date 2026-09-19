import { afterEach, describe, expect, it, vi } from "vitest";
import { CallbackQueueStore } from "./callback-queue-store";
import { EMPTY_CALLBACK_QUEUE, type CallbackQueuePayload, type CallbackRequestPayload } from "./callback-queue";
import { telephonyJson } from "./client-request";

vi.mock("./client-request", () => ({ TELEPHONY_TIMEOUT_MS: { read: 10000 }, telephonyJson: vi.fn() }));
vi.mock("./realtime-client", () => ({ subscribeTelephonyRealtime: vi.fn(() => () => {}) }));
const request = vi.mocked(telephonyJson);
function row(id: string): CallbackRequestPayload { return { id, status: "open" } as CallbackRequestPayload; }
function payload(ids: string[], total = ids.length, cursor: string | null = null): CallbackQueuePayload { return { ...EMPTY_CALLBACK_QUEUE, configured: true, open: ids.map(row), openTotal: total, nextCursor: cursor }; }
function response(body: CallbackQueuePayload, status = 200) { return { body, status, ok: status === 200 }; }
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("shared callback queue", () => {
  it("uses one request for header and panel and keeps the complete count beyond a page", async () => {
    vi.useFakeTimers(); request.mockResolvedValue(response(payload(["a"], 125, "next")));
    const store = new CallbackQueueStore(); const closeHeader = store.subscribe(() => {}); const closePanel = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1); expect(store.getSnapshot().queue.openTotal).toBe(125);
    closePanel(); expect(store.getSnapshot().queue.open).toHaveLength(1);
    closeHeader(); expect(store.getSnapshot().queue.open).toEqual([]);
  });

  it("reconciles every loaded page after invalidation, removing resolved rows", async () => {
    vi.useFakeTimers(); request.mockResolvedValueOnce(response(payload(["a"], 3, "next"))).mockResolvedValueOnce(response(payload(["b"], 3, "last")));
    const store = new CallbackQueueStore(); const close = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0); store.loadMore(); await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().queue.open.map((item) => item.id)).toEqual(["a", "b"]);
    request.mockResolvedValueOnce(response(payload(["b"], 2, "next"))).mockResolvedValueOnce(response(payload(["c"], 2)));
    store.refresh(); store.refresh(); await vi.advanceTimersByTimeAsync(150);
    expect(store.getSnapshot().queue.open.map((item) => item.id)).toEqual(["b", "c"]);
    expect(store.getSnapshot().queue.openTotal).toBe(2); close();
  });

  it("clears caller data immediately on revoked access", async () => {
    vi.useFakeTimers(); request.mockResolvedValueOnce(response(payload(["private"]))).mockResolvedValueOnce(response(payload([]), 403));
    const store = new CallbackQueueStore(); const close = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0); store.refresh(); await vi.advanceTimersByTimeAsync(150);
    expect(store.getSnapshot().queue.open).toEqual([]); expect(store.getSnapshot().error).toBeTruthy(); close();
  });

  it("expires private data after 30 seconds without successful authorization", async () => {
    vi.useFakeTimers(); request.mockResolvedValueOnce(response(payload(["private"]))).mockRejectedValue(new Error("offline"));
    const store = new CallbackQueueStore(); const close = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(29_999); expect(store.getSnapshot().queue.open).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(store.getSnapshot().queue.open).toEqual([]); close();
  });

  it("ignores a late result from a previous signed-in scope", async () => {
    vi.useFakeTimers(); let finish!: (value: ReturnType<typeof response>) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const store = new CallbackQueueStore(); const close = store.subscribe(() => {});
    close(); finish(response(payload(["private"]))); await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot().queue.open).toEqual([]);
  });
});
