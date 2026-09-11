import { MutationError } from "@/server/mutation-error";
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/server/api-auth", () => ({ requireDefaultMotoristActor: vi.fn(), assertSameOriginRequest: vi.fn() }));
vi.mock("@/server/integrations/fleet-refresh", () => ({ refreshFleetSources: vi.fn() }));
vi.mock("@/data/dispatch-repository", () => ({ loadFleetData: vi.fn() }));
import { requireDefaultMotoristActor, assertSameOriginRequest } from "@/server/api-auth";
import { refreshFleetSources } from "@/server/integrations/fleet-refresh";
import { loadFleetData } from "@/data/dispatch-repository";
import { POST } from "./route";

beforeEach(() => vi.resetAllMocks());
it.each([401, 403])("stops before contacting providers when the session/CSRF guard denies %s", async (status) => {
  vi.mocked(requireDefaultMotoristActor).mockRejectedValue(new MutationError("Denied", status));
  const request = new Request("https://dispatch.example/api/integrations/fleet/refresh", { method: "POST" });
  expect((await POST(request)).status).toBe(status);
  expect(assertSameOriginRequest).toHaveBeenCalledWith(request);
  expect(refreshFleetSources).not.toHaveBeenCalled();
  expect(loadFleetData).not.toHaveBeenCalled();
});
it("returns fresh stored fleet data even when another instance owns the refresh lease", async () => {
  vi.mocked(requireDefaultMotoristActor).mockResolvedValue({ organizationId: "org", profileId: "actor" } as Awaited<ReturnType<typeof requireDefaultMotoristActor>>);
  vi.mocked(refreshFleetSources).mockResolvedValue({ skipped: true, warnings: [], commanderVehicles: false, commanderPositions: false, swhouse: false, occupancy: false, webdispecink: false, autoPaired: 0 });
  vi.mocked(loadFleetData).mockResolvedValue({ fleetAssets: [] } as unknown as Awaited<ReturnType<typeof loadFleetData>>);
  const response = await POST(new Request("https://dispatch.example", { method: "POST" }));
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect((await response.json()).summary.skipped).toBe(true);
});
it("does not leak vendor errors or replace data with demo vehicles on failure", async () => {
  vi.mocked(requireDefaultMotoristActor).mockResolvedValue({ organizationId: "org", profileId: "actor" } as Awaited<ReturnType<typeof requireDefaultMotoristActor>>);
  vi.mocked(refreshFleetSources).mockRejectedValue(new Error("secret-credential"));
  const response = await POST(new Request("https://dispatch.example", { method: "POST" }));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("secret-credential");
  expect(loadFleetData).not.toHaveBeenCalled();
});
