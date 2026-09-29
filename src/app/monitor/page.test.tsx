import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const io = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/server/api-auth", () => ({ getDefaultMotoristAuthState: io.auth }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/components/monitor/MonitorScreen", () => ({ MonitorScreen: () => null }));
vi.mock("@/components/auth/MotoristLogin", () => ({ MotoristLogin: () => null }));
vi.mock("@/server/app-version", () => ({ getAppVersion: () => "monitor-build" }));
import { MonitorScreen } from "@/components/monitor/MonitorScreen";
import { MotoristLogin } from "@/components/auth/MotoristLogin";
import MonitorPage from "./page";

beforeEach(() => { io.auth.mockReset(); vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("DIAGNOSTICS_PANEL_ENABLED", "true"); vi.stubEnv("DIAGNOSTICS_SENTRY_DASHBOARD_URL", ""); vi.stubEnv("DIAGNOSTICS_UPTIME_DASHBOARD_URL", ""); });
afterEach(() => vi.unstubAllEnvs());
describe("monitor page access", () => {
  it.each(["unauthenticated", "insufficient_role"])("does not render diagnostics for %s", async reason => {
    io.auth.mockResolvedValue({ authorized: false, reason, message: "Prístup nie je povolený." });
    expect((await MonitorPage()).type).toBe(MotoristLogin);
    expect(io.auth).toHaveBeenCalledWith(["manager", "admin"]);
  });
  it("passes only the authorized identity and version to the separate screen", async () => {
    io.auth.mockResolvedValue({ authorized: true, profile: { profileId: "profile", organizationId: "org", email: "private@example.test", role: "manager" } });
    const page = await MonitorPage();
    expect(page.type).toBe(MonitorScreen);
    expect(page.props).toEqual({ appVersion: "monitor-build", identity: { profileId: "profile", organizationId: "org" }, externalLinks: { vercel: "https://vercel.com/alfopures-projects/pomoc-motoristom-dispatching", supabase: "https://supabase.com/dashboard/project/nzpnqdstvkfncflgqlny", sentry: undefined, uptime: undefined } });
  });
  it("authenticates before the panel kill switch and never mounts the poller when disabled", async () => {
    vi.stubEnv("DIAGNOSTICS_PANEL_ENABLED", "false");
    io.auth.mockResolvedValue({ authorized: false, message: "Prihláste sa." });
    expect((await MonitorPage()).type).toBe(MotoristLogin);
    io.auth.mockResolvedValue({ authorized: true });
    const page = await MonitorPage();
    expect(page.type).toBe("main");
    expect(renderToStaticMarkup(page)).toContain("Monitor prevádzky je vypnutý");
    expect(io.auth).toHaveBeenLastCalledWith(["manager", "admin"]);
  });
});
