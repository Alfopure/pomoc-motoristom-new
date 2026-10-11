import { describe, expect, it, vi } from "vitest";
import { createVoiceApi } from "./api";
import type { MobileTransport } from "../lib/api";
const id = "00000000-0000-4000-8000-000000000001";
const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "fixture" };
const scope = { ok: true, apiVersion: 1, environment: "test", profileId: "operator" };
const token = { ...scope, token: "provider-token", deviceSessionId: id, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
describe("native voice transport", () => {
  it("uses the user JWT and mobile lease on POST, without cookies", async () => {
    const fetch = vi.fn<MobileTransport>().mockResolvedValue(Response.json(token));
    await createVoiceApi(config, "operator", async () => "user-token", fetch).token(id);
    expect(fetch).toHaveBeenCalledWith(config.apiOrigin + "/api/mobile/v1/voice/token", expect.objectContaining({ method: "POST", credentials: "omit", headers: expect.objectContaining({ Authorization: "Bearer user-token", "X-PM-App-Environment": "test" }), body: JSON.stringify({ deviceSessionId: id, takeover: false }) }));
  });
  it.each([{ ...token, environment: "production" }, { ...token, profileId: "someone-else" }, { ...token, expiresAt: "invalid" }, { ...token, deviceSessionId: "invalid" }, null])("rejects unsafe token contracts %#", async body => {
    const fetch = vi.fn<MobileTransport>().mockResolvedValue(Response.json(body));
    await expect(createVoiceApi(config, "operator", async () => "user-token", fetch).token()).rejects.toMatchObject({ status: 502 });
  });
  it("preserves 202 pending termination and the stale-lease error code", async () => {
    const fetch = vi.fn<MobileTransport>().mockResolvedValueOnce(Response.json({ ...scope, sessionId: id, terminationPending: true }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: false, error: "stale", code: "native_lease_stale" }, { status: 409 }));
    const api = createVoiceApi(config, "operator", async () => "user-token", fetch);
    expect(await api.end(id, id)).toEqual({ terminationPending: true });
    await expect(api.authorize(id, { providerLegId: id })).rejects.toMatchObject({ status: 409, code: "native_lease_stale" });
  });
});
