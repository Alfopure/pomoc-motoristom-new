import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createFakeSupabase } from "@/test/fake-supabase";
import { getMobileCaseOverview } from "./case-overview";

const actor = { userId: "user", profileId: "profile", organizationId: "org", displayName: "Actor", role: "dispatcher" as const };
afterEach(() => vi.restoreAllMocks());
describe("mobile case overview exact open counts", () => {
  it("counts full scoped data beyond a page, excluding every closed status but retaining waiting for docs", async () => {
    const f = createFakeSupabase();
    f.db.seed("motorist_cases", [
      ...Array.from({ length: 31 }, (_, n) => ({ id: String(n), organization_id: "org", owner_id: "profile", status: "open", priority: "normal" })),
      { id: "waiting", organization_id: "org", owner_id: null, status: "waiting_for_docs", priority: "urgent" },
      { id: "colleague", organization_id: "org", owner_id: "other", status: "in_progress", priority: "urgent" },
      { id: "foreign", organization_id: "foreign", owner_id: "profile", status: "open", priority: "urgent" },
      ...["completed_assisted", "completed_no_assistance", "rejected", "cancelled", "futile_trip"].map(status => ({ id: status, organization_id: "org", owner_id: "profile", status, priority: "urgent" })),
    ]);
    expect(await getMobileCaseOverview(actor, undefined, f.admin)).toEqual({ open: 33, mine: 31, unassigned: 1, urgent: 2 });
    expect(f.db.log).toHaveLength(4);
    expect(f.db.log.every(x => x.table === "motorist_cases" && x.operation === "select" && x.filters?.includes("eq(organization_id)"))).toBe(true);
  });
  it("returns actual zeros for an empty scoped result", async () => {
    expect(await getMobileCaseOverview(actor, undefined, createFakeSupabase().admin)).toEqual({ open: 0, mine: 0, unassigned: 0, urgent: 0 });
  });
  it("never turns a database failure into partial or zero counts", async () => {
    const f = createFakeSupabase(); f.db.failNext("motorist_cases", "select", "PRIVATE DB ERROR");
    await expect(getMobileCaseOverview(actor, undefined, f.admin)).rejects.toMatchObject({ status: 503 });
  });
  it("uses the installed SDK to send four HEAD exact-count requests with scoped filters and one 8000ms abort", async () => {
    const requests: { url: URL; init: RequestInit }[] = [];
    const client = createClient<Database>("https://fixture.invalid", "fixture-public-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async (input, init) => {
        requests.push({ url: new URL(String(input)), init: init ?? {} });
        return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
      } },
    });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const caller = new AbortController();
    await getMobileCaseOverview(actor, caller.signal, client);
    expect(timeout).toHaveBeenCalledWith(8000);
    expect(requests).toHaveLength(4);
    for (const { url, init } of requests) {
      expect(init.method).toBe("HEAD");
      expect(new Headers(init.headers).get("Prefer")).toBe("count=exact");
      expect(url.pathname).toBe("/rest/v1/motorist_cases");
      expect(url.searchParams.get("select")).toBe("id");
      expect(url.searchParams.get("organization_id")).toBe("eq.org");
      expect(url.searchParams.getAll("status")).toEqual(["neq.completed_assisted", "neq.completed_no_assistance", "neq.rejected", "neq.cancelled", "neq.futile_trip"]);
      expect(url.searchParams.has("limit")).toBe(false);
    }
    expect(requests.map(({ url }) => url.searchParams.get("owner_id"))).toEqual([null, "eq.profile", "is.null", null]);
    expect(requests.map(({ url }) => url.searchParams.get("priority"))).toEqual([null, null, null, "eq.urgent"]);
    expect(new Set(requests.map(({ init }) => init.signal)).size).toBe(1);
    caller.abort(); expect(requests.every(({ init }) => init.signal?.aborted)).toBe(true);
  });
  it("cancels all in-flight SDK reads at the shared deadline and fails without a partial result", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let calls = 0;
    const client = createClient<Database>("https://fixture.invalid", "fixture-public-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async (_input, init) => {
        calls++;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Deadline", "AbortError")), { once: true });
        });
      } },
    });
    const outcome = getMobileCaseOverview(actor, undefined, client);
    const rejected = expect(outcome).rejects.toMatchObject({ status: 503 });
    await vi.waitFor(() => expect(calls).toBe(4));
    deadline.abort();
    await rejected;
    expect(calls).toBe(4);
  });
  it("rejects an already cancelled request instead of producing counts", async () => {
    await expect(getMobileCaseOverview(actor, AbortSignal.abort(), createFakeSupabase().admin)).rejects.toMatchObject({ status: 503 });
  });
  it.each([null, undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "4"])("rejects missing or invalid exact count %s", async count => {
    const read = { select: () => read, eq: () => read, neq: () => read, is: () => read, abortSignal: () => read,
      then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data: null, error: null, count }).then(resolve) };
    const admin = { from: () => read } as unknown as SupabaseClient<Database>;
    await expect(getMobileCaseOverview(actor, undefined, admin)).rejects.toMatchObject({ status: 503 });
  });
  it("accepts independent observations without inventing cross-count consistency", async () => {
    let next = 0;
    const counts = [0, 2, 3, 4];
    const admin = { from: () => {
      const count = counts[next++];
      const read = { select: () => read, eq: () => read, neq: () => read, is: () => read, abortSignal: () => read,
        then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data: null, error: null, count }).then(resolve) };
      return read;
    } } as unknown as SupabaseClient<Database>;
    expect(await getMobileCaseOverview(actor, undefined, admin)).toEqual({ open: 0, mine: 2, unassigned: 3, urgent: 4 });
  });
});
