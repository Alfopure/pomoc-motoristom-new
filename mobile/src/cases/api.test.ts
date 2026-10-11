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
const editable = { contactName: "Kontakt", contactPhone: "+421900000001", licensePlate: "BA123AB", vehicleMake: "Škoda", vehicleModel: "Octavia",
  manualPickupAddress: "Bratislava", manualDestinationAddress: "", incidentDescription: "Defekt", note: "Poznámka", priority: "normal", jobTypes: ["tow"], status: "new" };
const statusOptions = ["open", "completed_assisted", "completed_no_assistance", "waiting_for_docs", "cancelled", "futile_trip"].map(value => ({ value, label: value }));
const detail = { ...scope, case: { ...item, editable, statusOptions, mainNote: "Poznámka", incidentDescription: "Defekt", jobTypeLabels: ["Odťah"], timeline: [
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
    await expect(fixture({ ...list, cases: [{ ...item, priority: ["normal"] }] }).api.list(selection)).rejects.toMatchObject({ status: 502 });
    await expect(fixture({ ...list, cases: [item, item] }).api.list(selection)).rejects.toMatchObject({ status: 502 });
    await expect(fixture({ ...list, cases: [{ ...item, contact: { name: "Name", phone: {} } }] }).api.list(selection)).rejects.toMatchObject({ status: 502 });
    await expect(fixture({ ...list, nextCursor: "same" }).api.list({ ...selection, cursor: "same" })).rejects.toMatchObject({ status: 502 });
  });
  it("projects the readable fields without leaking extra provider fields from responses", async () => {
    const f = fixture({ ...list, cases: [{ ...item, providerCredential: "must-not-reach-ui", contact: { ...item.contact, privateNote: "omit" } }] });
    expect((await f.api.list(selection)).cases).toEqual([item]);
  });
  it("sends and verifies a specific dispatcher filter and projects only that owner's rows", async () => {
    const filter = { ...selection, ownership: "all" as const, ownerId: otherId };
    const f = fixture({ ...list, selection: filter, cases: [{ ...item, owner: { id: otherId, name: "Kolegyňa", mine: false } }] });
    expect((await f.api.list(filter)).selection).toEqual(filter);
    expect(new URL(f.transport.mock.calls[0][0]).searchParams.get("ownerId")).toBe(otherId);
    await expect(fixture({ ...list, selection: filter }).api.list(filter)).rejects.toMatchObject({ status: 502 });
  });
  it.each([undefined, null, profileId, "invalid"])("rejects missing or mismatched selected dispatcher echo %j", async ownerId => {
    await expect(fixture({ ...list, selection: { ...selection, ownership: "all", ownerId } }).api.list({ ...selection, ownership: "all", ownerId: otherId })).rejects.toMatchObject({ status: 502 });
  });
  it.each([undefined, null])("accepts legacy unselected owner echo %j without sending an empty filter", async ownerId => {
    const f = fixture({ ...list, selection: { ...selection, ownerId } });
    expect((await f.api.list(selection)).selection.ownerId).toBeNull();
    expect(new URL(f.transport.mock.calls[0][0]).searchParams.has("ownerId")).toBe(false);
  });
  it.each([{ ownership: "mine" as const, ownerId: otherId }, { ownership: "all" as const, ownerId: "" }, { ownership: "all" as const, ownerId: "invalid" }])("rejects invalid outgoing dispatcher selection %j", async change => {
    const f = fixture(); await expect(f.api.list({ ...selection, ...change })).rejects.toMatchObject({ status: 400 }); expect(f.transport).not.toHaveBeenCalled();
  });
  it("loads active and inactive organization dispatcher choices without extra fields", async () => {
    const choices = [{ id: profileId, name: "Dispečer", active: true }, { id: otherId, name: "Kolegyňa", active: false }];
    const f = fixture({ ...scope, dispatchers: choices.map(item => ({ ...item, privateField: "omit" })) });
    expect(await f.api.dispatchers()).toEqual({ ...scope, dispatchers: choices });
    expect(f.transport.mock.calls[0][0]).toBe(config.apiOrigin + "/api/mobile/v1/cases/dispatchers");
  });
  it.each([
    [{ id: otherId, name: "", active: true }], [{ id: otherId, name: " ", active: true }], [{ id: "wrong", name: "Name", active: true }],
    [{ id: otherId, name: "Name", active: "true" }], [{ id: otherId, name: "Name", active: true }, { id: otherId, name: "Other", active: false }],
    Array.from({ length: 201 }, () => ({ id: otherId, name: "Name", active: true })),
  ].map(dispatchers => ({ dispatchers })))("rejects malformed, duplicate or oversized dispatcher choices %#", async ({ dispatchers }) => {
    await expect(fixture({ ...scope, dispatchers }).api.dispatchers()).rejects.toMatchObject({ status: 502 });
  });
  it.each([{ environment: "production" }, { profileId: otherId }, { ok: false }])("rejects foreign dispatcher scope %j", async change => {
    await expect(fixture({ ...scope, ...change, dispatchers: [] }).api.dispatchers()).rejects.toMatchObject({ status: 502 });
  });
  it("validates selected detail identity and nested timeline", async () => {
    expect(await fixture(detail).api.detail(caseId)).toEqual(detail);
    await expect(fixture(detail).api.detail(otherId)).rejects.toMatchObject({ status: 502 });
    await expect(fixture({ ...detail, case: { ...detail.case, timeline: [{ ...detail.case.timeline[0], actorName: 42 }] } }).api.detail(caseId)).rejects.toMatchObject({ status: 502 });
    const f = fixture(detail); await expect(f.api.detail("../../other")).rejects.toMatchObject({ status: 404 }); expect(f.transport).not.toHaveBeenCalled();
  });
  it("validates raw editor fields, options and identity without reversing display labels", async () => {
    for (const change of [{ editable: undefined }, { editable: { ...editable, vehicleMake: null } }, { editable: { ...editable, status: "open" } },
      { editable: { ...editable, jobTypes: ["tow", "tow"] } }, { editable: { ...editable, jobTypes: [["tow"]] } }, { statusOptions: [statusOptions[0]] }, { statusOptions: [...statusOptions.slice(0, 5), statusOptions[0]] }]) {
      await expect(fixture({ ...detail, case: { ...detail.case, ...change } }).api.detail(caseId)).rejects.toMatchObject({ status: 502 });
    }
    expect((await fixture({ ...detail, case: { ...detail.case, editable: { ...editable, providerSecret: "omit" } } }).api.detail(caseId)).case.editable).toEqual(editable);
  });
  it("sends PATCH once and verifies exact mutation receipt and opaque revision", async () => {
    const input = { note: "Changed", mutationId: otherId, expectedUpdatedAt: "2026-10-11T12:00:00.123456Z" };
    const receipt = { ...scope, caseId, mutationId: otherId, committedRevision: "2026-10-11T12:01:00.654321Z", warnings: [], refreshRequired: true };
    const f = fixture(receipt); expect(await f.api.update(caseId, input)).toEqual(receipt);
    expect(f.transport).toHaveBeenCalledTimes(1); expect(f.transport.mock.calls[0][1]).toMatchObject({ method: "PATCH", body: JSON.stringify(input), credentials: "omit" });
    for (const change of [{ caseId: otherId }, { mutationId: profileId }, { committedRevision: "bad" }, { refreshRequired: false }, { warnings: null }, { profileId: otherId }]) {
      await expect(fixture({ ...receipt, ...change }).api.update(caseId, input)).rejects.toMatchObject({ status: 502 });
    }
  });
  it("retains typed revision conflict code and other environment denials", async () => {
    for (const code of ["CASE_REVISION_CONFLICT", "mobile_environment_mismatch", "CASE_MUTATION_MISMATCH"]) {
      const f = fixture(); f.transport.mockResolvedValue(Response.json({ error: "Failure", code }, { status: 409 }));
      await expect(f.api.update(caseId, { mutationId: otherId, expectedUpdatedAt: scope.checkedAt, note: "x" })).rejects.toMatchObject({ status: 409, code });
    }
  });
  it("posts a timeline note once and requires the exact scoped event receipt", async () => {
    const input = { mutationId: otherId, note: "Nový záznam" };
    const receipt = { ...scope, caseId, mutationId: otherId, eventId: otherId, warnings: [], refreshRequired: true };
    const f = fixture(receipt); expect(await f.api.addNote(caseId, input)).toEqual(receipt);
    expect(f.transport).toHaveBeenCalledTimes(1); expect(f.transport.mock.calls[0][0]).toBe(config.apiOrigin + "/api/mobile/v1/cases/" + caseId + "/notes");
    expect(f.transport.mock.calls[0][1]).toMatchObject({ method: "POST", body: JSON.stringify(input), credentials: "omit" });
    for (const change of [{ caseId: otherId }, { mutationId: profileId }, { eventId: profileId }, { refreshRequired: false }, { warnings: null }, { environment: "production" }]) {
      await expect(fixture({ ...receipt, ...change }).api.addNote(caseId, input)).rejects.toMatchObject({ status: 502 });
    }
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
