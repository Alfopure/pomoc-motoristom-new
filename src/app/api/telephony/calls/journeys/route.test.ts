import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { MutationError } from "@/server/mutation-error";
const actor = vi.hoisted(() => ({ read: vi.fn() }));
let fake: ReturnType<typeof createFakeSupabase>;
vi.mock("@/server/api-auth", () => ({ requireDefaultMotoristActor: actor.read }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => fake.admin }));
import { GET } from "./route";
import { GET as detail } from "../[id]/journey/route";
const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => {
  fake = createFakeSupabase();
  actor.read.mockReset().mockResolvedValue({ organizationId: id, profileId: id, role: "dispatcher" });
});
describe("journey route access", () => {
  it("uses the normal dispatcher role gate and uncached private responses without provider setup", async () => {
    const response = await GET(new Request("https://test.local/api/telephony/calls/journeys"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(actor.read).toHaveBeenCalledWith(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    expect(await response.json()).toMatchObject({ ok: true, calls: [] });
    expect(fake.db.log.every(entry => entry.operation === "select")).toBe(true);
  });
  it.each([401, 403])("denies %s before any database read", async status => {
    actor.read.mockRejectedValue(new MutationError("Prístup odmietnutý.", status));
    expect((await GET(new Request("https://test.local/api/telephony/calls/journeys"))).status).toBe(status);
    expect((await detail(new Request("https://test.local/api/telephony/calls/a/journey"), { params: Promise.resolve({ id }) })).status).toBe(status);
    expect(fake.db.log).toHaveLength(0);
  });
  it("does not accept a caller-controlled organization and cannot read another organization", async () => {
    fake.db.seed("motorist_call_sessions", [{ id, organization_id: "other", state: "ringing", ended_at: null }]);
    fake.db.seed("motorist_calls", [{ id, organization_id: "other", session_id: id }]);
    const response = await detail(new Request("https://test.local/api/telephony/calls/a/journey?identity=session&organizationId=other"), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(404);
  });
});
