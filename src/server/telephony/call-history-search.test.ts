import { expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { parseCallHistoryQuery } from "@/lib/telephony/call-history-query";
import { searchTelephonyCallHistory } from "./call-history";

it("keeps an explicitly limited authorized history when the additive RPC is absent", async () => {
  const fake = createFakeSupabase();
  const rpc = vi.spyOn(fake.admin, "rpc").mockResolvedValue({ data: null, error: { code: "PGRST202", message: "missing" } } as never);
  const result = await searchTelephonyCallHistory({ organizationId: "org", profileId: "actor" }, parseCallHistoryQuery(new URLSearchParams({ q: "old caller" })), fake.admin);
  expect(result).toMatchObject({ searchAvailable: false, calls: [], nextCursor: null });
  expect(rpc).toHaveBeenCalledOnce();
  expect(fake.db.log).toContainEqual(expect.objectContaining({ table: "motorist_calls", filters: expect.arrayContaining(["eq(organization_id)"]) }));
});

it.each(["42501", "XX000"])("does not bypass an RPC authorization/server failure (%s)", async code => {
  const fake = createFakeSupabase();
  vi.spyOn(fake.admin, "rpc").mockResolvedValue({ data: null, error: { code, message: "denied" } } as never);
  await expect(searchTelephonyCallHistory({ organizationId: "org", profileId: "actor" }, parseCallHistoryQuery(new URLSearchParams()), fake.admin)).rejects.toThrow();
  expect(fake.db.log).toEqual([]);
});
