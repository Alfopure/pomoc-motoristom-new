import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDispatchData } from "@/data/dispatch-repository";
import { loadCaseDetail } from "@/data/case-detail-repository";
import { updateCase, MutationError } from "@/server/motorist-mutations";
import { GET, PATCH } from "./route";
vi.mock("@/data/dispatch-repository", () => ({ loadDispatchData: vi.fn() }));
vi.mock("@/data/case-detail-repository", () => ({ loadCaseDetail: vi.fn() }));
vi.mock("@/server/api-auth", () => ({ assertSameOriginRequest: vi.fn(), requireDefaultMotoristActor: vi.fn(async () => ({ profileId: "actor", organizationId: "org" })) }));
vi.mock("@/server/motorist-mutations", async importOriginal => ({ ...await importOriginal<typeof import("@/server/motorist-mutations")>(), updateCase: vi.fn() }));
const legacy = vi.mocked(loadDispatchData), read = vi.mocked(loadCaseDetail), save = vi.mocked(updateCase);
const context = { params: Promise.resolve({ id: "case-1" }) };
const request = () => new Request("https://example.test/api/cases/case-1", { method: "PATCH", headers: { "x-case-response": "detail-v2" }, body: JSON.stringify({ priority: "urgent", expectedUpdatedAt: "revision", mutationId: "key" }) });
const receipt = { caseRow: { id: "case-1", updated_at: "committed" }, warnings: [] } as unknown as Awaited<ReturnType<typeof updateCase>>;
afterEach(() => { vi.clearAllMocks(); read.mockReset(); save.mockReset(); legacy.mockReset(); });
describe("narrow case API", () => {
  it("returns only the authorized requested card on GET", async () => {
    read.mockResolvedValue({ id: "case-1", updatedAt: "revision" } as Awaited<ReturnType<typeof loadCaseDetail>>);
    const req = new Request("https://example.test/api/cases/case-1", { headers: { "x-case-response": "detail-v2" } });
    const response = await GET(req, context);
    expect(read).toHaveBeenCalledExactlyOnceWith("case-1", { profileId: "actor", organizationId: "org" }, req.signal);
    expect(await response.json()).toEqual({ caseDetail: { id: "case-1", updatedAt: "revision" } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(save).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  });
  it("acknowledges the exact mutation and returns the canonical card", async () => {
    save.mockResolvedValue(receipt);
    read.mockResolvedValue({ id: "case-1", updatedAt: "committed" } as Awaited<ReturnType<typeof loadCaseDetail>>);
    const response = await PATCH(request(), context);
    expect(await response.json()).toEqual({ caseId: "case-1", committedRevision: "committed", mutationId: "key", warnings: [], caseDetail: { id: "case-1", updatedAt: "committed" } });
    expect(save).toHaveBeenCalledExactlyOnceWith("case-1", expect.objectContaining({ mutationId: "key" }), "actor", "org");
    expect(legacy).not.toHaveBeenCalled();
  });
  it("never turns a committed write into 5xx when its read fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    save.mockResolvedValue(receipt); read.mockRejectedValue(new Error("read failed"));
    const response = await PATCH(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ caseId: "case-1", committedRevision: "committed", mutationId: "key", refreshRequired: true, warnings: [] });
    expect(save).toHaveBeenCalledTimes(1); log.mockRestore();
  });
  it.each([[409, "CASE_REVISION_CONFLICT"], [422, "CASE_MUTATION_MISMATCH"]] as const)("preserves %s %s without a post-save read", async (status, code) => {
    save.mockRejectedValue(new MutationError("Keep draft", status, code));
    const response = await PATCH(request(), context);
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: "Keep draft", code });
    expect(read).not.toHaveBeenCalled();
  });
  it("preserves the full response for an already-open legacy browser", async () => {
    legacy.mockResolvedValue({ source: "supabase", dispatchCases: [] } as unknown as Awaited<ReturnType<typeof loadDispatchData>>);
    save.mockResolvedValue(receipt);
    const req = request(); req.headers.delete("x-case-response");
    const response = await PATCH(req, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ committedRevision: "committed", dispatchData: { source: "supabase", dispatchCases: [] } });
    expect(read).not.toHaveBeenCalled();
  });
  it("preserves a legacy commit acknowledgement when the compatibility read fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    save.mockResolvedValue(receipt); legacy.mockRejectedValue(new Error("unavailable"));
    const req = request(); req.headers.delete("x-case-response");
    const response = await PATCH(req, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ committedRevision: "committed", refreshRequired: true });
    log.mockRestore();
  });
  it("returns a bounded read failure instead of mock data", async () => {
    read.mockRejectedValue(new MutationError("Unavailable", 503));
    expect((await GET(new Request("https://example.test", { headers: { "x-case-response": "detail-v2" } }), context)).status).toBe(503);
  });
});
