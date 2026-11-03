import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { DeliveryAccess, deliveryMember, deliverySharing, refreshDeliveryAccess } from "./access";
import { createDeliveryApi } from "./api";
import { delivery } from "./fixtures";
import { moduleAccess } from "../shell/modules";

const MEMBER = "77777777-7777-4777-8777-777777777777";
const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "unused" };
const scope = { ok: true, apiVersion: 1, environment: "test", memberId: MEMBER, checkedAt: "2026-10-22T10:00:00Z" };
const clients: QueryClient[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.clear()); });

function workspace() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  const access = new DeliveryAccess(), requests: string[] = [];
  const server = { identity: false, list: false, unavailable: false };
  const api = createDeliveryApi(config, async () => "MOCK", async url => {
    const path = String(url).split("/field/")[1];
    requests.push(path);
    if (server.unavailable) return Response.json({ error: "Temporarily unavailable" }, { status: 503 });
    if (!(path === "me" ? server.identity : server.list)) return Response.json({ error: "No field access" }, { status: 403 });
    return Response.json(path === "me"
      ? { ...scope, member: { id: MEMBER, displayName: "Pristavovač", email: null } }
      : { ...scope, deliveries: [delivery({ status: "accepted", tracking: true })] });
  }, () => true, access);
  const me = new QueryObserver(client, { queryKey: ["mobile", "test", "user", "field", "me"], queryFn: ({ signal }) => api.me(signal), enabled: false });
  const list = new QueryObserver(client, { queryKey: ["mobile", "test", "user", "field", "deliveries"], queryFn: ({ signal }) => api.list(signal), enabled: false });
  const refresh = () => refreshDeliveryAccess(() => me.refetch(), () => list.refetch());
  const member = () => access.snapshot() ? null : deliveryMember(me.getCurrentResult().data, me.getCurrentResult().error, list.getCurrentResult().error);
  return { server, requests, me, list, refresh, member, modules: () => moduleAccess("admin", Boolean(member())) };
}

describe("manual delivery access refresh", () => {
  it("shows a newly granted module after a previous refusal without replacing the account or cache", async () => {
    const app = workspace();
    expect(await app.refresh()).toBe("refused");
    expect(app.requests).toEqual(["me"]);
    expect(app.modules()).not.toContain("pristavenia");

    app.server.identity = app.server.list = true;
    expect(await app.refresh()).toBe("refreshed");
    expect(app.requests).toEqual(["me", "me", "deliveries"]);
    expect(app.member()).toBe(MEMBER);
    expect(app.modules()).toContain("pristavenia");
    expect(app.list.getCurrentResult().data).toHaveLength(1);
  });

  it("removes a revoked module and sharing even though the previous identity and list remain cached", async () => {
    const app = workspace();
    app.server.identity = app.server.list = true;
    await app.refresh();
    expect(app.modules()).toContain("pristavenia");
    app.server.identity = app.server.list = false;

    expect(await app.refresh()).toBe("refused");
    expect(app.me.getCurrentResult().data?.memberId).toBe(MEMBER);
    expect(app.list.getCurrentResult().data).toHaveLength(1);
    expect(app.member()).toBeNull();
    expect(app.modules()).not.toContain("pristavenia");
    expect(deliverySharing(app.member(), app.list.getCurrentResult().data, app.list.getCurrentResult().error)).toBeNull();
    expect(app.requests).toEqual(["me", "deliveries", "me"]);
  });

  it("refreshes the previously refused list after re-verifying identity", async () => {
    const app = workspace();
    app.server.identity = true;
    expect(await app.refresh()).toBe("refused");
    expect(app.me.getCurrentResult().isSuccess).toBe(true);
    expect(app.list.getCurrentResult().error).toMatchObject({ status: 403 });
    expect(app.member()).toBeNull();

    app.server.list = true;
    expect(await app.refresh()).toBe("refreshed");
    expect(app.requests).toEqual(["me", "deliveries", "me", "deliveries"]);
    expect(app.modules()).toContain("pristavenia");
  });

  it("does not turn a failed refresh after a refusal into a grant", async () => {
    const app = workspace();
    await app.refresh();
    app.server.identity = app.server.list = app.server.unavailable = true;
    expect(await app.refresh()).toBe("failed");
    expect(app.requests).toEqual(["me", "me"]);
    expect(app.modules()).not.toContain("pristavenia");
  });
});
