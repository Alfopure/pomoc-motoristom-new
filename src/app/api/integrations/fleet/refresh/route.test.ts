import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/server/api-auth", () => ({ motoristAccessGuard: vi.fn() }));
vi.mock("@/server/integrations/fleet-refresh", () => ({ refreshFleetSources: vi.fn() }));
vi.mock("@/data/dispatch-repository", () => ({ loadDispatchData: vi.fn() }));
import { motoristAccessGuard } from "@/server/api-auth";
import { refreshFleetSources } from "@/server/integrations/fleet-refresh";
import { loadDispatchData } from "@/data/dispatch-repository";
import { POST } from "./route";

beforeEach(() => vi.resetAllMocks());
it.each([401, 403])("stops before contacting providers when the session/CSRF guard denies %s", async (status) => {
  vi.mocked(motoristAccessGuard).mockResolvedValue(new Response("denied", { status }));
  const request = new Request("https://dispatch.example/api/integrations/fleet/refresh", { method: "POST" });
  expect((await POST(request)).status).toBe(status);
  expect(motoristAccessGuard).toHaveBeenCalledWith({ request });
  expect(refreshFleetSources).not.toHaveBeenCalled();
  expect(loadDispatchData).not.toHaveBeenCalled();
});
it("returns fresh stored fleet data even when another instance owns the refresh lease", async () => {
  vi.mocked(motoristAccessGuard).mockResolvedValue(null);
  vi.mocked(refreshFleetSources).mockResolvedValue({ skipped: true, warnings: [], commanderVehicles: false, commanderPositions: false, swhouse: false, occupancy: false, webdispecink: false, autoPaired: 0 });
  vi.mocked(loadDispatchData).mockResolvedValue({ fleetAssets: [] } as unknown as Awaited<ReturnType<typeof loadDispatchData>>);
  const response = await POST(new Request("https://dispatch.example", { method: "POST" }));
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect((await response.json()).summary.skipped).toBe(true);
});
it("does not leak vendor errors or replace data with demo vehicles on failure", async () => {
  vi.mocked(motoristAccessGuard).mockResolvedValue(null);
  vi.mocked(refreshFleetSources).mockRejectedValue(new Error("secret-credential"));
  const response = await POST(new Request("https://dispatch.example", { method: "POST" }));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("secret-credential");
  expect(loadDispatchData).not.toHaveBeenCalled();
});
