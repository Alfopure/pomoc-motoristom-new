import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiagnosticsUploader, voiceDiagnosticsSender, type DiagnosticsOwner, type DiagnosticsUploadResult } from "./diagnostics-upload";
import type { VoiceDiagnosticEvent } from "./diagnostics";

const event = (id: number, fields: Record<string, string> = { reason: "voice_disabled" }): VoiceDiagnosticEvent => ({ id, at: 1_793_000_000_000 + id, event: "push.refused", fields });
function fixture(count: number, results: DiagnosticsUploadResult[] = [], owner?: DiagnosticsOwner) {
  let ring = Array.from({ length: count }, (_, index) => event(index + 1));
  const events = vi.fn(async () => ring);
  const clear = vi.fn(async (upToId: number) => { ring = ring.filter(item => item.id > upToId); });
  const send = vi.fn(async (_batch: VoiceDiagnosticEvent[]) => results.shift() ?? { status: 200 });
  const uploader = createDiagnosticsUploader({ events, clear, send, owner });
  return { uploader, events, clear, send, ring: () => ring, add: (item: VoiceDiagnosticEvent) => { ring = [...ring, item]; } };
}
function owner(id: string, stored: string | null) {
  const value = { stored };
  return { value, owner: { id, load: vi.fn(async () => value.stored), save: vi.fn(async (next: string) => { value.stored = next; }) } };
}
const settle = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 9, 30, 8)); });
afterEach(() => { vi.useRealTimers(); });

describe("voice device-log upload", () => {
  it("sends the ring a moment after a trigger in batches of at most 100 and forgets each batch only after a 2xx", async () => {
    const f = fixture(250);
    f.uploader.request(); f.uploader.request();
    await settle(1_999); expect(f.send).not.toHaveBeenCalled();
    await settle(1);
    expect(f.send.mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 50]);
    expect(f.send.mock.calls[1][0][0].id).toBe(101);
    expect(f.clear.mock.calls).toEqual([[100], [200], [250]]);
    expect(f.ring()).toEqual([]);
  });
  it("keeps every request body well under the server's size limit", async () => {
    const f = fixture(0);
    for (let id = 1; id <= 100; id += 1) f.add(event(id, Object.fromEntries(Array.from({ length: 20 }, (_, index) => ["key_" + index, "v".repeat(40)]))));
    f.uploader.request(); await settle(2_000);
    expect(f.send.mock.calls.length).toBeGreaterThan(1);
    for (const [batch] of f.send.mock.calls) expect(JSON.stringify(batch).length).toBeLessThan(50_000);
    expect(f.ring()).toEqual([]);
  });
  it("keeps a refused or failed batch and retries it on the next trigger, at most once per 30 s", async () => {
    const f = fixture(120, [{ status: 200 }, { status: 503 }]);
    f.uploader.request(); await settle(2_000);
    expect(f.clear.mock.calls).toEqual([[100]]); expect(f.ring().map(item => item.id)).toEqual(Array.from({ length: 20 }, (_, index) => 101 + index));
    f.uploader.request(); await settle(29_999);
    expect(f.send).toHaveBeenCalledTimes(2);
    await settle(1);
    expect(f.send).toHaveBeenCalledTimes(3); expect(f.send.mock.calls[2][0].map(item => item.id)).toEqual(f.send.mock.calls[1][0].map(item => item.id));
    expect(f.ring()).toEqual([]);
  });
  it("keeps events when nothing could be sent or the request throws", async () => {
    const f = fixture(3, [{ status: 0 }, { status: 401 }]);
    f.uploader.request(); await settle(2_000);
    f.uploader.request(); await settle(30_000);
    f.send.mockRejectedValueOnce(new Error("offline"));
    f.uploader.request(); await settle(30_000);
    expect(f.send).toHaveBeenCalledTimes(3); expect(f.clear).not.toHaveBeenCalled(); expect(f.ring()).toHaveLength(3);
    f.uploader.request(); await settle(30_000);
    expect(f.ring()).toEqual([]);
  });
  it("stops when the server has the upload switched off, and after dispose", async () => {
    const f = fixture(5, [{ status: 403, code: "voice_diagnostics_disabled" }]);
    f.uploader.request(); await settle(2_000);
    f.uploader.request(); await settle(60_000);
    expect(f.send).toHaveBeenCalledOnce(); expect(f.ring()).toHaveLength(5);
    const g = fixture(5); g.uploader.request(); g.uploader.dispose(); await settle(60_000);
    expect(g.send).not.toHaveBeenCalled();
  });
  it("backs off one more interval when the server limits the rate", async () => {
    const f = fixture(3, [{ status: 429, code: "voice_diagnostics_rate_limited" }]);
    f.uploader.request(); await settle(2_000);
    f.uploader.request(); await settle(59_999);
    expect(f.send).toHaveBeenCalledOnce(); expect(f.ring()).toHaveLength(3);
    await settle(1);
    expect(f.send).toHaveBeenCalledTimes(2); expect(f.ring()).toEqual([]);
  });
  it("forgets another operator's events unsent, and keeps the first owner's", async () => {
    const other = owner("profile-b", "profile-a"), f = fixture(5, [], other.owner);
    f.uploader.request(); await settle(2_000);
    expect(f.clear).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER); expect(f.send).not.toHaveBeenCalled(); expect(other.value.stored).toBe("profile-b");
    const first = owner("profile-a", null), g = fixture(5, [], first.owner);
    g.uploader.request(); await settle(2_000);
    expect(g.send).toHaveBeenCalledOnce(); expect(g.send.mock.calls[0][0]).toHaveLength(5); expect(first.value.stored).toBe("profile-a");
  });
  it("at logout sends what is pending at once and then empties the ring, even when the upload fails or hangs", async () => {
    const f = fixture(150, [], owner("profile-a", "profile-a").owner);
    await f.uploader.finish();
    expect(f.send.mock.calls.map(([batch]) => batch.length)).toEqual([100, 50]); expect(f.clear).toHaveBeenLastCalledWith(Number.MAX_SAFE_INTEGER);
    const g = fixture(5, [{ status: 503 }]);
    await g.uploader.finish();
    expect(g.send).toHaveBeenCalledOnce(); expect(g.ring()).toEqual([]);
    const h = fixture(5); h.send.mockReturnValue(new Promise(() => {}));
    const finished = h.uploader.finish(); await settle(4_000); await finished;
    expect(h.ring()).toEqual([]);
  });
  it("posts the signed-in operator's batch with the device session and build, and reads the refusal code", async () => {
    const transport = vi.fn(async () => new Response(JSON.stringify({ ok: false, code: "voice_diagnostics_disabled" }), { status: 403 }));
    const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk" } as Parameters<typeof voiceDiagnosticsSender>[0];
    const send = voiceDiagnosticsSender(config, async () => "jwt", async () => "3f2a9c1b-0000-4000-8000-000000000001", "27", transport);
    expect(await send([event(1)])).toEqual({ status: 403, code: "voice_diagnostics_disabled" });
    const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://test.dispecing.linkapomoci.sk/api/mobile/v1/diagnostics/voice");
    expect(init.headers).toMatchObject({ Authorization: "Bearer jwt", "X-PM-App-Environment": "test" });
    expect(JSON.parse(init.body as string)).toEqual({ deviceSession: "3f2a9c1b-0000-4000-8000-000000000001", build: "27", events: [event(1)] });
    const signedOut = voiceDiagnosticsSender(config, async () => null, async () => null, null, transport);
    expect(await signedOut([event(1)])).toEqual({ status: 0 }); expect(transport).toHaveBeenCalledOnce();
  });
});
