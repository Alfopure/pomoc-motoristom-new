import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wiring test for the two read-only statistics routes.
 *
 * Both are wrappers, so what is asserted is what only the wrapper knows: the
 * role list (the wallboard hangs on a wall — the page gate is a hint, this is
 * the boundary), that the wallboard is served through the *cached* loader
 * rather than one database pass per screen, that the payload carries the
 * organisation's configured flag, and that a failure comes back as a Slovak
 * message instead of a stack trace.
 */

const loadTelephonyStatsCached = vi.fn();
const loadQaDashboard = vi.fn();
const requireDefaultMotoristActor = vi.fn();
const createTelephonyDeps = vi.fn(async () => DEPS);

vi.mock("@/server/api-auth", () => ({
  requireDefaultMotoristActor: (...args: unknown[]) => requireDefaultMotoristActor(...args),
}));

vi.mock("@/server/telephony/stats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/stats")>();
  return { ...actual, loadTelephonyStatsCached: (...args: unknown[]) => loadTelephonyStatsCached(...args) };
});

vi.mock("@/server/telephony/qa", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/qa")>();
  return { ...actual, loadQaDashboard: (...args: unknown[]) => loadQaDashboard(...args) };
});

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: (...args: unknown[]) => createTelephonyDeps(...(args as [])) };
});

const ACTOR = { userId: "user-1", profileId: "profile-1", organizationId: "org-1", displayName: "Miro", role: "manager" as const };
const DEPS = { admin: "admin-client", organizationId: "org-1", now: "now-fn", logger: "logger-fn", config: { configured: false } } as never;
const SENIOR_ROLES = ["senior_dispatcher", "manager", "admin"];

beforeEach(() => {
  vi.clearAllMocks();
  requireDefaultMotoristActor.mockResolvedValue(ACTOR);
});

describe("GET /api/telephony/stats", () => {
  it("is senior dispatcher and above and answers from the shared snapshot", async () => {
    loadTelephonyStatsCached.mockResolvedValue({ checkedAt: "2026-09-03T10:00:00.000Z", live: { waiting: [] } });
    const { GET } = await import("./route");

    const response = await GET();

    expect(response.status).toBe(200);
    expect(requireDefaultMotoristActor).toHaveBeenCalledWith(SENIOR_ROLES);
    expect(createTelephonyDeps).toHaveBeenCalledWith({ organizationId: "org-1" });
    // The provider being switched off does not hide the numbers; it is reported.
    expect(loadTelephonyStatsCached).toHaveBeenCalledWith(
      { admin: "admin-client", organizationId: "org-1", now: "now-fn", logger: "logger-fn" },
      { configured: false },
    );
    // A per-reader answer must never land in a shared cache.
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("answers a failure in Slovak", async () => {
    loadTelephonyStatsCached.mockRejectedValue(new Error("relation does not exist"));
    const { GET } = await import("./route");

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "Štatistiky sa nepodarilo načítať." });
  });
});

describe("GET /api/telephony/qa/dashboard", () => {
  it("keeps the senior-and-above gate the scored dashboard had", async () => {
    loadQaDashboard.mockResolvedValue({ lookbackDays: 30, recordingEnabled: false });
    const { GET } = await import("../qa/dashboard/route");

    const response = await GET();

    expect(response.status).toBe(200);
    expect(requireDefaultMotoristActor).toHaveBeenCalledWith(SENIOR_ROLES);
    expect(loadQaDashboard).toHaveBeenCalledWith({ admin: "admin-client", organizationId: "org-1", now: "now-fn" });
    expect(await response.json()).toMatchObject({ recordingEnabled: false });
  });

  it("answers a failure in Slovak", async () => {
    loadQaDashboard.mockRejectedValue(new Error("boom"));
    const { GET } = await import("../qa/dashboard/route");

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "QA prehľad sa nepodarilo načítať." });
  });
});
