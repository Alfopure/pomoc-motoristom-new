import { describe, expect, it, vi } from "vitest";
import { fetchAppStatus } from "./app-status";
import type { MobileTransport } from "./api";

const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "fixture" };
const good = { ok: true, apiVersion: 1, environment: "test", minimumVersion: "1.0.1", updateUrl: "https://apps.apple.com/app/id1" };
const answer = (body: unknown, status = 200) => vi.fn<MobileTransport>().mockResolvedValue(Response.json(body, { status }));

describe("release gate read", () => {
  it("reads the public status without credentials", async () => {
    const transport = answer(good);
    expect(await fetchAppStatus(config, transport)).toEqual({ minimumVersion: "1.0.1", updateUrl: "https://apps.apple.com/app/id1" });
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://test.dispecing.linkapomoci.sk/api/mobile/v1/app-status");
    expect(init?.credentials).toBe("omit"); expect(JSON.stringify(init?.headers)).not.toContain("Authorization");
  });
  it("drops unsafe values and never blocks on a failure", async () => {
    expect(await fetchAppStatus(config, answer({ ...good, minimumVersion: "2.0.0-rc", updateUrl: "http://x.example" }))).toEqual({ minimumVersion: null, updateUrl: null });
    expect(await fetchAppStatus(config, answer({ ...good, environment: "production" }))).toBeNull();
    expect(await fetchAppStatus(config, answer(good, 500))).toBeNull();
    expect(await fetchAppStatus(config, vi.fn<MobileTransport>().mockRejectedValue(new TypeError("offline")))).toBeNull();
  });
});
