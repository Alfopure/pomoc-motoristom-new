import { describe, expect, it, vi } from "vitest";
import { createMobileApi, type MobileTransport } from "../lib/api";
import { createCasesApi } from "../cases/api";
const profileId = "00000000-0000-4000-8000-000000000001", organizationId = "00000000-0000-4000-8000-000000000002";
const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "sb_publishable_fixture" };
const scope = { ok: true, apiVersion: 1, environment: "test", profileId, organizationId, checkedAt: "2026-10-12T14:00:00Z" };
describe("draft authority client boundary", () => {
  it("reads only authenticated private scope and drops unknown provider or credential fields", async () => {
    const transport = vi.fn<MobileTransport>(async () => Response.json({ ...scope, access_token: "excluded", provider: "excluded" }));
    expect(await createMobileApi(config, async () => "user-token", transport).draftScope(profileId)).toEqual(scope);
    expect(transport).toHaveBeenCalledWith(config.apiOrigin + "/api/mobile/v1/drafts/scope", expect.objectContaining({ method: "GET", credentials: "omit", headers: { Authorization: "Bearer user-token", "X-PM-App-Environment": "test", Accept: "application/json" } }));
  });
  it.each([{ profileId: organizationId }, { environment: "production" }, { apiVersion: 2 }, { organizationId: "not-id" }, { organizationId: null }, { checkedAt: "1" }, { checkedAt: "2026-02-30T00:00:00Z" }])("rejects malformed/foreign draft scope %j", async change => {
    await expect(createMobileApi(config, async () => "token", async () => Response.json({ ...scope, ...change })).draftScope(profileId)).rejects.toMatchObject({ status: 502 });
  });
  it("does not issue a scope read without a login token", async () => {
    const transport = vi.fn<MobileTransport>(); await expect(createMobileApi(config, async () => null, transport).draftScope(profileId)).rejects.toMatchObject({ status: 401 }); expect(transport).not.toHaveBeenCalled();
  });
  it("threads expected organization into Cases, shared task API and handoff API", async () => {
    const transport = vi.fn<MobileTransport>(async () => Response.json({ error: "intentional fixture rejection" }, { status: 400 }));
    const api = createCasesApi(config, profileId, async () => "token", transport, organizationId);
    await expect(api.create({ contactName: "MOCK" })).rejects.toMatchObject({ status: 400 });
    await expect(api.work.myTasks({ view: "assigned", category: "open", q: "" })).rejects.toMatchObject({ status: 400 });
    await expect(api.handoffs.context(profileId)).rejects.toMatchObject({ status: 400 });
    expect(transport).toHaveBeenCalledTimes(3);
    for (const [, init] of transport.mock.calls) expect(init.headers).toMatchObject({ Authorization: "Bearer token", "X-PM-Expected-Organization": organizationId });
  });
  it("rejects invalid expected organization locally before transport", () => {
    const transport = vi.fn<MobileTransport>(); expect(() => createCasesApi(config, profileId, async () => "token", transport, "invalid")).toThrow(); expect(transport).not.toHaveBeenCalled();
  });
});
