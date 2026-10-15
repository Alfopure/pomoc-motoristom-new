import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { createMobileApi, MobileApiError, usableMobileIdentity, type MobileTransport } from "./api";

const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "sb_publishable_fixture" };
const scope = { ok: true, apiVersion: 1, environment: "test", profileId: "profile", checkedAt: "2026-10-11T12:00:00Z" };
const me = { ...scope, profile: { id: "profile", displayName: "Test", email: null, role: "dispatcher" }, capabilities: { voice: false, presenceWrite: false } };
describe("native API transport", () => {
  it("searches the scoped colleague directory by GET without registering a device", async () => {
    const row = { profileId: "00000000-0000-4000-8000-000000000001", displayName: "Jana", status: "paused", canCall: true, reason: null };
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, colleagues: [row], hasMore: false }));
    const value = await createMobileApi(config, async () => "token", transport).voiceColleagues("profile", " Jana ");
    expect(value.colleagues).toEqual([row]);
    expect(transport).toHaveBeenCalledWith(config.apiOrigin + "/api/mobile/v1/voice/colleagues?q=Jana", expect.objectContaining({ method: "GET", credentials: "omit" }));
  });
  it.each([
    { profileId: "invalid" }, { displayName: "" }, { displayName: "x".repeat(121) }, { displayName: "Jana\nNew" },
    { status: "unknown" }, { canCall: "true" }, { canCall: true, reason: "busy" }, { status: "offline", canCall: true },
    { canCall: false, reason: null }, { reason: "unknown" },
    { status: ["available"] }, { canCall: false, reason: ["offline"] },
  ])("rejects an unsafe colleague row %#", async changes => {
    const row = { profileId: "00000000-0000-4000-8000-000000000001", displayName: "Jana", status: "available", canCall: true, reason: null, ...changes };
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, colleagues: [row], hasMore: false }));
    await expect(createMobileApi(config, async () => "token", transport).voiceColleagues("profile", "")).rejects.toMatchObject({ status: 502 });
  });
  it("refuses duplicate directory identities and malformed pagination or scope", async () => {
    const row = { profileId: "00000000-0000-4000-8000-000000000001", displayName: "Jana", status: "available", canCall: true, reason: null };
    for (const change of [{ colleagues: [row, row] }, { colleagues: Array.from({ length: 51 }, () => row) }, { hasMore: "false" }, { environment: "production" }, { profileId: "other" }]) {
      const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, colleagues: [row], hasMore: false, ...change }));
      await expect(createMobileApi(config, async () => "token", transport).voiceColleagues("profile", "")).rejects.toMatchObject({ status: 502 });
    }
  });
  it("reads phone configuration without registering a phone or sending cookies", async () => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, nativeCallingEnabled: false, backgroundIncomingEnabled: false }));
    const result = await createMobileApi(config, async () => "current-token", transport).voiceReadiness("profile");
    expect(result.nativeCallingEnabled).toBe(false);
    expect(transport).toHaveBeenCalledWith(config.apiOrigin + "/api/mobile/v1/voice/readiness", expect.objectContaining({ method: "GET", credentials: "omit" }));
  });
  it.each([
    { nativeCallingEnabled: "true", backgroundIncomingEnabled: false },
    { nativeCallingEnabled: true, backgroundIncomingEnabled: null },
    { nativeCallingEnabled: false, backgroundIncomingEnabled: true },
    { nativeCallingEnabled: true, backgroundIncomingEnabled: true, environment: "production" },
    { nativeCallingEnabled: true, backgroundIncomingEnabled: true, profileId: "someone-else" },
  ])("refuses unsafe phone configuration %#", async changes => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, ...changes }));
    await expect(createMobileApi(config, async () => "token", transport).voiceReadiness("profile")).rejects.toMatchObject({ status: 502 });
  });
  it("uses the fresh user token, explicit environment and no cookies", async () => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json(me));
    await createMobileApi(config, async () => "current-token", transport).me();
    expect(transport).toHaveBeenCalledWith(config.apiOrigin + "/api/mobile/v1/me", expect.objectContaining({ method: "GET", credentials: "omit", headers: expect.objectContaining({ Authorization: "Bearer current-token", "X-PM-App-Environment": "test" }) }));
  });
  it("does not make anonymous data requests", async () => {
    const transport = vi.fn<MobileTransport>();
    await expect(createMobileApi(config, async () => null, transport).me()).rejects.toMatchObject({ status: 401 }); expect(transport).not.toHaveBeenCalled();
  });
  it.each([{ environment: "production" }, { apiVersion: 2 }, { profileId: "other-profile" }])("refuses mixed-scope console data %j", async changes => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, presence: { status: "available", since: null }, activeCalls: [], capabilities: { voice: false, presenceWrite: false }, ...changes }));
    await expect(createMobileApi(config, async () => "token", transport).console("profile")).rejects.toMatchObject({ status: 502 });
  });
  it("cannot enable a missing native phone engine through a backend flag", async () => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...me, capabilities: { voice: true, presenceWrite: true } }));
    await expect(createMobileApi(config, async () => "token", transport).me()).rejects.toMatchObject({ status: 502 });
  });
  it("rejects array-valued profile and presence enums", async () => {
    const transport = vi.fn<MobileTransport>().mockResolvedValueOnce(Response.json({ ...me, profile: { ...me.profile, role: ["dispatcher"] } }))
      .mockResolvedValueOnce(Response.json({ ...scope, presence: { status: ["available"], since: null }, activeCalls: [], capabilities: me.capabilities }));
    const api = createMobileApi(config, async () => "token", transport);
    await expect(api.me()).rejects.toMatchObject({ status: 502 });
    await expect(api.console("profile")).rejects.toMatchObject({ status: 502 });
  });
  it("rejects array-valued call directions before exposing history or active calls", async () => {
    const call = { id: "call", direction: ["internal"], number: "+421900000001", name: "Kolega", startedAt: scope.checkedAt,
      status: "completed", state: "bridged", lineLabel: "Dispečing", operatorName: null, answeredAt: null, endedAt: null, durationSeconds: null };
    const transport = vi.fn<MobileTransport>().mockResolvedValueOnce(Response.json({ ...scope, calls: [call], nextCursor: null }))
      .mockResolvedValueOnce(Response.json({ ...scope, presence: { status: "available", since: null }, activeCalls: [call], capabilities: me.capabilities }));
    const api = createMobileApi(config, async () => "token", transport);
    await expect(api.history("profile", { category: "all", q: "" })).rejects.toMatchObject({ status: 502 });
    await expect(api.console("profile")).rejects.toMatchObject({ status: 502 });
  });
  it("preserves the exact next-page cursor and applies filters on the server", async () => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ...scope, calls: [], nextCursor: null }));
    const cursor = "%7B%22id%22%3A%22test%22%7D";
    await createMobileApi(config, async () => "token", transport).history("profile", { category: "missed", q: "+421", cursor });
    const params = new URL(transport.mock.calls[0][0] as string).searchParams;
    expect(params.get("cursor")).toBe(cursor); expect(params.get("q")).toBe("+421"); expect(params.get("category")).toBe("missed");
  });
  it("preserves denial and network errors without returning stale success", async () => {
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json({ ok: false, error: "Access removed" }, { status: 403 }));
    const api = createMobileApi(config, async () => "token", transport);
    await expect(api.me()).rejects.toMatchObject({ status: 403, message: "Access removed" });
    transport.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api.me()).rejects.toBeInstanceOf(MobileApiError);
  });
  it("passes cancellation to the native request", async () => {
    const controller = new AbortController();
    const transport = vi.fn<MobileTransport>().mockImplementation(async (_url, init) => { expect(init.signal?.aborted).toBe(true); throw new DOMException("Aborted", "AbortError"); });
    controller.abort(); await expect(createMobileApi(config, async () => "token", transport).me(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it.each([
    { status: 0, retained: true }, { status: 503, retained: true }, { status: 504, retained: true },
    { status: 401, retained: false }, { status: 403, retained: false }, { status: 409, retained: false },
    { status: 502, retained: false },
  ])("keeps call identity only for a transient same-user refresh ($status)", async ({ status, retained }) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = ["mobile", "test", "user", "me"];
    const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json(me));
    const api = createMobileApi(config, async () => "token", transport);
    try {
      const identity = await client.fetchQuery({ queryKey: key, queryFn: () => api.me() });
      if (status === 0) transport.mockRejectedValue(new TypeError("Network changed"));
      else if (status === 502) transport.mockResolvedValue(Response.json({ ...me, environment: "production" }));
      else transport.mockResolvedValue(Response.json({ ok: false, error: "Refresh failed" }, { status }));
      await expect(client.fetchQuery({ queryKey: key, queryFn: () => api.me() })).rejects.toMatchObject({ status });
      expect(client.getQueryData(key)).toBe(identity);
      expect(usableMobileIdentity(client.getQueryData(key), client.getQueryState(key)?.error)).toBe(retained ? identity : null);
      expect(usableMobileIdentity(client.getQueryData(["mobile", "test", "another-user", "me"]), client.getQueryState(key)?.error)).toBeNull();
    } finally { client.clear(); }
  });
  it("cannot grant access on an initial failure or an unclassified error", async () => {
    expect(usableMobileIdentity(undefined, new MobileApiError("Unavailable", 503))).toBeNull();
    expect(usableMobileIdentity(undefined, null)).toBeNull();
    const identity = await createMobileApi(config, async () => "token", async () => Response.json(me)).me();
    expect(usableMobileIdentity(identity, new Error("Unexpected failure"))).toBeNull();
  });
});
