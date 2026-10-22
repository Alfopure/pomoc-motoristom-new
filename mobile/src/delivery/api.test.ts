import { describe, expect, it, vi } from "vitest";
import { MobileApiError } from "../lib/api";
import { createDeliveryApi, parseDelivery } from "./api";
import { delivery } from "./fixtures";

const ME = "77777777-7777-4777-8777-777777777777", ID = delivery().id;
const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "unused" };
const scope = { ok: true, apiVersion: 1, environment: "test", memberId: ME, checkedAt: "2026-10-22T10:00:00Z" };
function client(...bodies: { status?: number; body: unknown }[]) {
  const transport = vi.fn(async () => { const next = bodies.shift()!; return new Response(JSON.stringify(next.body), { status: next.status ?? 200 }); });
  return { transport, api: createDeliveryApi(config, async () => "MOCK-token", transport) };
}
const call = (transport: ReturnType<typeof client>["transport"], index = 0) => transport.mock.calls[index] as unknown as [string, RequestInit];

describe("pristavovač API", () => {
  it("reads the member and binds later answers to them", async () => {
    const { api, transport } = client({ body: { ...scope, member: { id: ME, displayName: "MOCK Pristavovač", email: null } } },
      { body: { ...scope, memberId: "88888888-8888-4888-8888-888888888888", deliveries: [] } });
    expect((await api.me()).member.displayName).toBe("MOCK Pristavovač");
    const [url, init] = call(transport);
    expect(url).toBe(config.apiOrigin + "/api/mobile/v1/field/me");
    expect(init).toMatchObject({ method: "GET", credentials: "omit", headers: { Authorization: "Bearer MOCK-token", "X-PM-App-Environment": "test" } });
    await expect(api.list()).rejects.toMatchObject({ status: 502 });
  });

  it("rejects an answer from another environment", async () => {
    const { api } = client({ body: { ...scope, environment: "production", member: { id: ME, displayName: "MOCK", email: null } } });
    await expect(api.me()).rejects.toMatchObject({ status: 502 });
  });

  it("keeps the server's refusal and its code", async () => {
    const { api } = client({ status: 503, body: { error: "Pristavenia v aplikácii nie sú zapnuté.", code: "delivery_unavailable" } });
    const failure = await api.list().catch(error => error);
    expect(failure).toBeInstanceOf(MobileApiError);
    expect(failure).toMatchObject({ status: 503, code: "delivery_unavailable", message: "Pristavenia v aplikácii nie sú zapnuté." });
  });

  it("lists and reads deliveries with their card and the car's GPS", async () => {
    const value = delivery({ replacementPosition: { lat: 49.2, lng: 18.7, recordedAt: "2026-10-22T09:58:00Z" } });
    const { api } = client({ body: { ...scope, deliveries: [value] } }, { body: { ...scope, delivery: value } }, { body: { ...scope, delivery: { ...value, id: "99999999-9999-4999-8999-999999999999" } } });
    expect(await api.list()).toEqual([value]);
    expect(await api.read(ID)).toEqual(value);
    await expect(api.read(ID)).rejects.toMatchObject({ status: 502 });
    await expect(api.read("../me")).rejects.toMatchObject({ status: 404 });
  });

  it("confirms a step only for the command it sent", async () => {
    const accepted = delivery({ status: "accepted", revision: 2 });
    const input = { commandId: "33333333-3333-4333-8333-333333333333", action: "accept" as const, expectedRevision: 1, publishedVersion: 1 };
    const { api, transport } = client({ body: { ...scope, delivery: accepted, commandId: input.commandId, committedRevision: 2 } },
      { body: { ...scope, delivery: accepted, commandId: "other", committedRevision: 2 } });
    expect(await api.command(ID, input)).toEqual(accepted);
    const [url, init] = call(transport);
    expect(url).toBe(config.apiOrigin + "/api/mobile/v1/field/deliveries/" + ID + "/commands");
    expect(JSON.parse(init.body as string)).toEqual(input);
    await expect(api.command(ID, input)).rejects.toMatchObject({ status: 502 });
  });

  it("sends a position and reads whether it was kept", async () => {
    const position = { lat: 49.2, lng: 18.7, accuracy: 15, recordedAt: "2026-10-22T10:00:00Z" };
    const { api, transport } = client({ body: { ...scope, stored: true } }, { body: { ...scope, stored: "yes" } });
    expect(await api.position(ID, position)).toBe(true);
    expect(JSON.parse(call(transport)[1].body as string)).toEqual(position);
    await expect(api.position(ID, position)).rejects.toMatchObject({ status: 502 });
  });

  it("asks to sign in again without a session", async () => {
    const transport = vi.fn();
    await expect(createDeliveryApi(config, async () => null, transport).list()).rejects.toMatchObject({ status: 401 });
    expect(transport).not.toHaveBeenCalled();
  });

  it("reports a broken connection as such", async () => {
    const api = createDeliveryApi(config, async () => "MOCK", vi.fn(async () => { throw new TypeError("network"); }));
    await expect(api.list()).rejects.toMatchObject({ status: 0 });
  });
});

describe("delivery trust boundary", () => {
  it("keeps no customer data once the delivery is closed", () => {
    expect(parseDelivery({ ...delivery({ status: "completed" }), card: null }).card).toBeNull();
  });
  it.each([
    { status: "lost" }, { revision: 0 }, { expiresAt: "soon" }, { events: "none" }, { replacementPosition: { lat: 91, lng: 0, recordedAt: "2026-10-22T10:00:00Z" } },
    { card: { ...delivery().card, secret: true } }, { events: [{ id: "x", action: "accept", comment: "", actor: "", createdAt: "2026-10-22T10:00:00Z" }] },
  ])("rejects a malformed delivery %#", change => {
    expect(() => parseDelivery({ ...delivery(), ...change })).toThrow(MobileApiError);
  });
});
