import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as me } from "@/app/api/mobile/v1/me/route";
import { GET as consoleSnapshot } from "@/app/api/mobile/v1/console/route";
import { GET as history } from "@/app/api/mobile/v1/calls/history/route";
import { MutationError } from "@/server/mutation-error";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), active: vi.fn(), history: vi.fn(), admin: {} }));
vi.mock("./auth", () => ({ requireMobileActor: mocks.actor, mobileEnvironment: () => "test" }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => mocks.admin }));
vi.mock("@/server/telephony/active-calls", () => ({ loadActiveCallsCached: mocks.active }));
vi.mock("@/server/telephony/call-history", () => ({ searchTelephonyCallHistory: mocks.history }));
const actor = { userId: "user", profileId: "profile", organizationId: "organization", displayName: "Operátor", role: "dispatcher", email: "operator@example.test" };
const request = (query = "") => new Request("https://app.test/api/mobile/v1/calls/history" + query);
beforeEach(() => { vi.resetAllMocks(); mocks.actor.mockResolvedValue(actor); });
describe("mobile read-only routes", () => {
  it.each([me, consoleSnapshot, history])("denies access before reading any phone data", async route => {
    mocks.actor.mockRejectedValue(new MutationError("denied", 401));
    const response = await route(request());
    expect(response.status).toBe(401); expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.active).not.toHaveBeenCalled(); expect(mocks.history).not.toHaveBeenCalled();
  });
  it("returns a versioned account without provider credentials", async () => {
    const response = await me(request());
    expect(await response.json()).toMatchObject({ apiVersion: 1, environment: "test", profileId: actor.profileId, profile: { id: "profile", displayName: "Operátor", role: "dispatcher" }, capabilities: { voice: false, presenceWrite: false } });
    expect(response.headers.get("Vary")).toContain("Authorization");
  });
  it("reads TEST's development namespace and exposes only own calls once", async () => {
    const call = { sessionId: "own", mine: true, direction: "inbound", state: "talking", callerNumber: "+421900000001", calledNumber: "company", partnerName: "Volajúci", lineLabel: "Linka", startedAt: "2026-10-11T12:00:00Z", legs: [{ callControlId: "private-provider-id" }], caseId: "private-case" };
    mocks.active.mockResolvedValue({ checkedAt: "2026-10-11T12:01:00Z", calls: [call, { ...call, sessionId: "foreign", mine: false }], waiting: [call], ownPresence: { status: "on_call", statusSince: "2026-10-11T12:00:00Z" } });
    const response = await consoleSnapshot(request()); const body = await response.json();
    expect(mocks.active).toHaveBeenCalledWith(expect.objectContaining({ organizationId: actor.organizationId, environment: "development" }), { profileId: actor.profileId, canManageAssignments: false });
    expect(body.activeCalls).toEqual([{ id: "own", direction: "inbound", state: "talking", number: "+421900000001", name: "Volajúci", lineLabel: "Linka", startedAt: "2026-10-11T12:00:00Z" }]);
    expect(body.presence.status).toBe("on_call"); expect(JSON.stringify(body)).not.toMatch(/private-provider|private-case/);
  });
  it("uses authorized search and returns a minimal outgoing history DTO", async () => {
    mocks.history.mockResolvedValue({ searchAvailable: true, calls: [{ id: "call", direction: "outbound", status: "ended", callerNumber: "company-number", calledNumber: "+421900000002", destinationNumber: "+421900000003", lineLabel: "Linka", startedAt: "2026-10-11T12:00:00Z", durationSeconds: 34, providerCallId: "private-provider", recordingId: "private-recording", summary: "private-summary", history: ["private-event"] }], nextCursor: "cursor" });
    const response = await history(request("?category=outbound&q=900")); const body = await response.json();
    expect(mocks.history).toHaveBeenCalledWith(actor, expect.objectContaining({ category: "outbound", q: "900", limit: 25 }));
    expect(body.calls[0].number).toBe("+421900000003"); expect(body.nextCursor).toBe("cursor");
    expect(JSON.stringify(body)).not.toMatch(/private-|company-number/);
  });
  it("rejects invalid filters without querying call history", async () => {
    expect((await history(request("?category=invalid"))).status).toBe(400);
    expect(mocks.history).not.toHaveBeenCalled();
  });
  it("does not present an unfiltered fallback as filtered history", async () => {
    mocks.history.mockResolvedValue({ searchAvailable: false, calls: [{ id: "must-not-leak" }], nextCursor: null });
    const response = await history(request("?category=missed"));
    expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("must-not-leak");
  });
  it("does not include raw provider/database errors", async () => {
    mocks.history.mockRejectedValue(new Error("secret-provider-database-detail"));
    const response = await history(request());
    expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("secret-provider");
  });
});
