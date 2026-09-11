import { afterEach, describe, expect, it, vi } from "vitest";
import { requestFleetRefresh } from "./fleet-refresh-client";
afterEach(() => vi.unstubAllGlobals());
describe("tab-wide fleet singleflight", () => {
  it("shares a pending result across panels and releases it after completion", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; })); vi.stubGlobal("fetch", fetcher);
    const first = requestFleetRefresh(), second = requestFleetRefresh();
    expect(first).toBe(second); expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(Response.json({ fleetData: { fleetAssets: [] } }));
    await expect(first).resolves.toEqual({ fleetData: { fleetAssets: [] } });
    const next = requestFleetRefresh(); expect(fetcher).toHaveBeenCalledTimes(2);
    resolve(Response.json({ fleetData: { fleetAssets: [] } })); await next;
  });
  it("releases a failed flight without replacing the last successful view", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status: 503 })).mockResolvedValueOnce(Response.json({ fleetData: { fleetAssets: [] } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(requestFleetRefresh()).rejects.toThrow("Unavailable");
    await expect(requestFleetRefresh()).resolves.toEqual({ fleetData: { fleetAssets: [] } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
