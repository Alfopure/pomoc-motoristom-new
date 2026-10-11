import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { CaseDraft } from "./draft";
import { createCasesApi } from "./api";
import type { MobileTransport } from "../lib/api";

const profileId = "00000000-0000-4000-8000-000000000001", caseId = "00000000-0000-4000-8000-000000000002";
const otherId = "00000000-0000-4000-8000-000000000003";
const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "sb_publishable_fixture" };
const scope = { ok: true, apiVersion: 1, environment: "test", profileId, checkedAt: "2026-10-11T12:00:00Z" };
const item = { id: caseId, caseNumber: "2026-001", status: "new", statusLabel: "Nové", priority: "normal", priorityLabel: "Bežná",
  owner: { id: profileId, name: "Dispečer", mine: true }, contact: { name: "Kontakt", phone: "+421900000001" }, vehicle: { licensePlate: "BA123AB", description: "Škoda Octavia" },
  pickupAddress: "Bratislava", destinationAddress: null, summary: "Porucha", createdAt: scope.checkedAt, updatedAt: scope.checkedAt };
const selection = { ownership: "mine" as const, category: "open" as const, q: "" };
const list = { ...scope, cases: [item], selection, nextCursor: null };
const detail = { ...scope, case: { ...item, mainNote: "Poznámka", incidentDescription: "Defekt", jobTypeLabels: ["Odťah"], timeline: [
  { id: otherId, title: "Vytvorené", body: null, createdAt: scope.checkedAt, actorName: "Dispečer" },
] } };
const created = { ...scope, caseId, caseNumber: item.caseNumber, warnings: [{ code: "missing_contact", field: "contactName", message: "Doplňte kontakt." }] };
function fixture(body: unknown = list) {
  const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json(body));
  return { transport, api: createCasesApi(config, profileId, async () => "user-token", transport) };
}
afterEach(() => vi.useRealTimers());

describe("mobile cases contract", () => {
  it("sends only bearer auth with scoped filters, literal search and opaque pagination", async () => {
    const q = "2026%,.'()";
    const f = fixture({ ...list, selection: { ownership: "all", category: "all", q } });
    await f.api.list({ ownership: "all", category: "all", q: " " + q + " ", cursor: "opaque+/=" });
    const [url, init] = f.transport.mock.calls[0], params = new URL(url).searchParams;
    expect(params.get("q")).toBe(q); expect(params.get("cursor")).toBe("opaque+/="); expect(params.get("limit")).toBe("25");
    expect(init).toMatchObject({ method: "GET", credentials: "omit", headers: { Authorization: "Bearer user-token", "X-PM-App-Environment": "test" } });
  });
  it.each([{ environment: "production" }, { profileId: otherId }, { apiVersion: 2 }, { ok: false }, { checkedAt: "invalid" }])("rejects a foreign/invalid scope %j", async change => {
    await expect(fixture({ ...list, ...change }).api.list(selection)).rejects.toMatchObject({ status: 502 });
  });
  it.each([{ ownership: "all" }, { category: "all" }, { q: "ignored search" }])("rejects a response for another selection %j", async change => {
    await expect(fixture({ ...list, selection: { ...selection, ...change } }).api.list(selection)).rejects.toMatchObject({ status: 502 });
  });
  it("rejects oversized, duplicate, malformed and repeating pages", async () => {
    await expect(fixture({ ...list, cases: Array.from({ length: 26 }, () => item) }).api.list(selection)).rejects.toMatchObject({ status: 502 });
    await expect(fixture({ ...list, cases: [item, item] }).api.list(selection)).rejects.toMatchObject({ status: 502 });
    await expect(fixture({ ...list, cases: [{ ...item, contact: { name: "Name", phone: {} } }] }).api.list(selection)).rejects.toMatchObject({ status: 502 });
    await expect(fixture({ ...list, nextCursor: "same" }).api.list({ ...selection, cursor: "same" })).rejects.toMatchObject({ status: 502 });
  });
  it("projects the readable fields without leaking extra provider fields from responses", async () => {
    const f = fixture({ ...list, cases: [{ ...item, providerCredential: "must-not-reach-ui", contact: { ...item.contact, privateNote: "omit" } }] });
    expect((await f.api.list(selection)).cases).toEqual([item]);
  });
  it("validates selected detail identity and nested timeline", async () => {
    expect(await fixture(detail).api.detail(caseId)).toEqual(detail);
    await expect(fixture(detail).api.detail(otherId)).rejects.toMatchObject({ status: 502 });
    await expect(fixture({ ...detail, case: { ...detail.case, timeline: [{ ...detail.case.timeline[0], actorName: 42 }] } }).api.detail(caseId)).rejects.toMatchObject({ status: 502 });
    const f = fixture(detail); await expect(f.api.detail("../../other")).rejects.toMatchObject({ status: 404 }); expect(f.transport).not.toHaveBeenCalled();
  });
  it("submits incomplete drafts once and keeps committed warnings and identity", async () => {
    const f = fixture(created); expect(await f.api.create({})).toEqual(created);
    expect(f.transport).toHaveBeenCalledTimes(1); expect(f.transport.mock.calls[0][1]).toMatchObject({ method: "POST", body: "{}", credentials: "omit" });
  });
  it("never reports a successful save from an unverifiable response", async () => {
    await expect(fixture({ ...created, caseId: "" }).api.create({ contactName: "Kontakt" })).rejects.toMatchObject({ status: 502 });
    await expect(fixture({ ...created, warnings: [{ code: "x", field: "note" }] }).api.create({})).rejects.toMatchObject({ status: 502 });
    await expect(fixture({ ...created, environment: "production" }).api.create({})).rejects.toMatchObject({ status: 502 });
  });
  it("times out a create without resending it or inventing a saved identity", async () => {
    vi.useFakeTimers();
    const transport = vi.fn<MobileTransport>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const api = createCasesApi(config, profileId, async () => "token", transport);
    const request = expect(api.create({ contactName: "Kontakt" })).rejects.toMatchObject({ status: 0 });
    await vi.advanceTimersByTimeAsync(20_000); await request; expect(transport).toHaveBeenCalledTimes(1);
  });
  it("cancels inactive case reads without caching another screen's response", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const transport = vi.fn<MobileTransport>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const api = createCasesApi(config, profileId, async () => "token", transport), key = ["mobile", "test", "user", "cases", profileId, "list"];
    try {
      const request = queryClient.fetchQuery({ queryKey: key, queryFn: ({ signal }) => api.list(selection, signal) }).catch(() => undefined);
      await Promise.resolve(); await queryClient.cancelQueries({ queryKey: key.slice(0, 5) }); await request;
      expect(transport.mock.calls[0][1].signal?.aborted).toBe(true); expect(queryClient.getQueryData(key)).toBeUndefined();
      expect(queryClient.getQueryData(["mobile", "test", "other-user", "cases", profileId, "list"])).toBeUndefined();
    } finally { queryClient.clear(); }
  });
  it("does not contact cases without authentication", async () => {
    const transport = vi.fn<MobileTransport>();
    await expect(createCasesApi(config, profileId, async () => null, transport).create({})).rejects.toMatchObject({ status: 401 });
    expect(transport).not.toHaveBeenCalled();
  });
  it("does not use a pre-failure list request that completes late as proof for a create retry", async () => {
    let resolveList!: (value: Response) => void;
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const transport = vi.fn<MobileTransport>().mockImplementation((_url, init) => init.method === "GET"
      ? new Promise(resolve => { resolveList = resolve; }) : Promise.reject(new TypeError("Connection interrupted")));
    const api = createCasesApi(config, profileId, async () => "token", transport), draft = new CaseDraft(api);
    try {
      const beforeFailure = api.list(selection); await Promise.resolve(); now.mockReturnValue(2000);
      await draft.submit(); expect(draft.snapshot().status).toBe("uncertain"); now.mockReturnValue(3000);
      resolveList(Response.json(list)); const oldPage = await beforeFailure;
      expect(oldPage.requestedAt).toBe(1000); draft.reviewList(oldPage.requestedAt); draft.allowRetry();
      expect(draft.snapshot().status).toBe("uncertain");
      transport.mockResolvedValue(Response.json(list));
      const newPage = await api.list(selection); draft.reviewList(newPage.requestedAt); draft.allowRetry();
      expect(draft.snapshot().status).toBe("editing");
    } finally { now.mockRestore(); draft.dispose(); }
  });

});
