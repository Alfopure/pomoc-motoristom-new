import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_APP_ORIGIN, TEST_SUPABASE_REF, TEST_VERCEL_PROJECT_ID } from "@/lib/app-environment";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), actor: vi.fn(), queue: vi.fn(), push: vi.fn(), admin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("./api-auth", () => ({ requireDefaultMotoristActor: mocks.actor }));
vi.mock("./mobile/push", () => ({ queueMobilePush: mocks.queue, sendMemberPush: mocks.push }));
import { getHandoffDeliveryContext } from "./mobile/case-handoff";
import type { HandoffSession } from "./case-handoff";
import { GET, POST } from "@/app/api/cases/[id]/handoffs/route";
const id = (n: number) => `92000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const caseId = id(1), handoffId = id(2), commandId = id(3), memberId = id(4), organizationId = id(5), profileId = id(6);
const params = { params: Promise.resolve({ id: caseId }) };
const handoff = { id: handoffId, status: "offered", revision: 1, publishedVersion: 1, published: { caseNumber: "PM-1", action: "Pristavenie" } };
const issue = { action: "issue", commandId, recipientName: "Kolega", recipientPhone: "+421905123456", previewVersion: "a".repeat(64) };
const deliver = { action: "deliver", commandId, handoffId, expectedRevision: 1, recipientMemberId: memberId };
function request(body?: unknown, headers: HeadersInit = {}) {
  return new Request(`${TEST_APP_ORIGIN}/api/cases/${caseId}/handoffs`, body === undefined ? {} : { method: "POST", headers: { Origin: TEST_APP_ORIGIN, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({ MOTORIST_HANDOFF_V3_ENABLED: "false", MOBILE_DELIVERY_ENABLED: "true", MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev", VERCEL_PROJECT_ID: TEST_VERCEL_PROJECT_ID, APP_BASE_URL: TEST_APP_ORIGIN, NEXT_PUBLIC_SUPABASE_URL: `https://${TEST_SUPABASE_REF}.supabase.co` })) vi.stubEnv(key, value);
  mocks.actor.mockResolvedValue({ organizationId, profileId });
  mocks.admin.mockReturnValue({});
  mocks.rpc.mockImplementation(async (_name, args) => {
    if (args.p_action === "context") return { data: { preview: {}, previewVersion: "a".repeat(64), handoffs: [handoff] }, error: null };
    if (args.p_action === "members") return { data: { members: [{ id: memberId, displayName: "Ján", lastPhone: null }] }, error: null };
    if (args.p_action === "app") return { data: { handoffs: [{ handoffId, memberId, position: { lat: 48, lng: 17, recordedAt: "2026-10-23T10:00:00Z" } }] }, error: null };
    if (args.p_action === "assign") return { data: { assigned: true, memberId, handoff: { ...handoff, revision: 2 } }, error: null };
    return { data: { handoff, commandId, committedRevision: 1, tokenAccepted: true }, error: null };
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("cookie web handoff delivery adapter", () => {
  it("authenticates before reading handoffs, recipients or locations, without bearer bypass", async () => {
    mocks.actor.mockRejectedValue(Object.assign(new Error("Prihláste sa"), { status: 401 }));
    await GET(request(), params);
    await POST(request(deliver, { Authorization: "Bearer mobile-token" }), params);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["", "null", "https://foreign.test"])("rejects Origin %s before actor and database access", async Origin => {
    expect((await POST(request(deliver, { Origin }), params)).status).toBe(403);
    expect(mocks.actor).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("adds eligible members and latest location using the authenticated organization", async () => {
    const result = await (await GET(request(), params)).json();
    expect(result.delivery.members).toEqual([{ id: memberId, displayName: "Ján", lastPhone: null }]);
    expect(result.handoffs[0].app).toMatchObject({ memberId, lastPosition: { lat: 48, lng: 17 } });
    for (const [, args] of mocks.rpc.mock.calls) expect(args).toMatchObject({ p_organization_id: organizationId, p_actor_id: profileId, p_case_id: caseId });
  });
  it.each(["members error", "app error", "missing schema", "throw", "malformed members", "malformed assignments", "invalid member", "duplicate member", "invalid assignment", "duplicate assignment"])("reports enabled delivery reads as retryable on %s", async failure => {
    const initial = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name, args) => {
      if (args.p_action === "members") {
        if (failure === "throw") throw new Error("private connection detail");
        if (failure === "members error" || failure === "missing schema") return { data: null, error: { code: failure === "missing schema" ? "PGRST202" : "PGRST000", message: "private detail" } };
        if (failure === "malformed members") return { data: { members: {} }, error: null };
        if (failure === "invalid member") return { data: { members: [{ id: "bad", displayName: "Ján", lastPhone: null }] }, error: null };
        if (failure === "duplicate member") return { data: { members: Array(2).fill({ id: memberId, displayName: "Ján", lastPhone: null }) }, error: null };
      }
      if (args.p_action === "app") {
        if (failure === "app error") return { data: null, error: { code: "PGRST000", message: "private detail" } };
        if (failure === "malformed assignments") return { data: { handoffs: {} }, error: null };
        if (failure === "invalid assignment") return { data: { handoffs: [{ handoffId, memberId: "bad" }] }, error: null };
        if (failure === "duplicate assignment") return { data: { handoffs: Array(2).fill({ handoffId, memberId }) }, error: null };
      }
      return initial(name, args);
    });
    const response = await GET(request(), params);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Údaje o pristavovačoch sa nepodarilo načítať. Skúste to znova." });
    expect(mocks.queue).not.toHaveBeenCalled();
  });
  it("preserves the mobile helper's optional fallback unless strict web reads are requested", async () => {
    const initial = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name, args) => args.p_action === "members"
      ? { data: { members: [{ id: "bad", displayName: "Ján", lastPhone: null }] }, error: null }
      : initial(name, args));
    const session = { actor: { organizationId, profileId }, client: { rpc: mocks.rpc } } as unknown as HandoffSession;
    expect(await getHandoffDeliveryContext(session, caseId)).toMatchObject({ members: [] });
    expect(await getHandoffDeliveryContext(session, caseId, true)).toBeNull();
  });
  it.each(["feature off", "ordinary Preview"])("does not read or assign app resources for %s", async mode => {
    vi.stubEnv(mode === "feature off" ? "MOBILE_DELIVERY_ENABLED" : "VERCEL_ENV", mode === "feature off" ? "false" : "preview");
    const response = await GET(request(), params);
    expect(response.status).toBe(200);
    const context = await response.json();
    expect(context).not.toHaveProperty("delivery");
    mocks.rpc.mockClear();
    expect((await POST(request({ ...issue, recipientMemberId: memberId }), params)).status).toBe(503);
    expect((await POST(request(deliver), params)).status).toBe(503);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.queue).not.toHaveBeenCalled();
  });
  it.each([{ ...deliver, recipientMemberId: "bad" }, { ...deliver, expectedRevision: 0 }, { ...deliver, expectedRevision: 2147483648 }, { ...deliver, organizationId: id(9) }, { ...issue, recipientMemberId: memberId, actorId: id(9) }])("rejects invalid identity/revision or injected fields before mutation", async body => {
    expect((await POST(request(body), params)).status).toBe(400); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([["42501", 403], ["22023", 400], ["PT409", 409]])("uses the RPC authorization/membership conflict for %s", async (code, status) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "private" } });
    const response = await POST(request(deliver), params);
    expect(response.status).toBe(status); expect(JSON.stringify(await response.json())).not.toContain("private"); expect(mocks.queue).not.toHaveBeenCalled();
  });
  it("returns the distinct delivery acknowledgement and queues push only on the first assignment", async () => {
    const expected = { commandId, handoffId, memberId, sent: true, currentRevision: 2 };
    expect(await (await POST(request(deliver), params)).json()).toEqual(expected);
    expect(mocks.rpc).toHaveBeenCalledWith("motorist_case_handoff_app", expect.objectContaining({ p_action: "assign", p_input: { handoffId, memberId, commandId, expectedRevision: 1 } }));
    expect(mocks.queue).toHaveBeenCalledTimes(1);
    await mocks.queue.mock.calls[0][0]();
    expect(mocks.push).toHaveBeenCalledWith({}, expect.objectContaining({ organizationId, memberIds: [memberId], data: { kind: "delivery", id: handoffId } }));
    mocks.rpc.mockResolvedValue({ data: { assigned: false, memberId, handoff: { ...handoff, revision: 2 } }, error: null });
    expect(await (await POST(request(deliver), params)).json()).toEqual(expected);
    expect(mocks.queue).toHaveBeenCalledTimes(1);
  });
  it("retains a committed issue and link when app assignment fails, with stable retry identity", async () => {
    const initial = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name, args) => args.p_action === "assign" ? { data: null, error: { code: "22023" } } : initial(name, args));
    const result = await (await POST(request({ ...issue, recipientMemberId: memberId }), params)).json();
    expect(result).toMatchObject({ handoff: { id: handoffId }, commandId, committedRevision: 1, delivery: { status: "failed", memberId } });
    expect(result.url).toContain("/handoff#token=");
    expect(mocks.rpc.mock.calls.find(([, args]) => args.p_action === "assign")![1].p_input).toEqual({ handoffId, memberId, commandId, expectedRevision: 1 });
  });
  it("adds app assignment to an issue without changing the legacy receipt contract", async () => {
    const result = await (await POST(request({ ...issue, recipientMemberId: memberId }), params)).json();
    expect(result).toMatchObject({ handoff: { id: handoffId }, commandId, committedRevision: 1, delivery: { status: "sent", memberId } });
  });
  it("keeps the committed receipt and app assignment when optional link recovery fails", async () => {
    vi.stubEnv("MOTORIST_HANDOFF_V3_ENABLED", "true");
    vi.stubEnv("MOTORIST_HANDOFF_KEY_ID", "v1");
    vi.stubEnv("MOTORIST_HANDOFF_KEYS", JSON.stringify({ v1: Buffer.alloc(32, 3).toString("base64") }));
    const initial = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name, args) => {
      if (args.p_action === "issue") return { data: { handoff, commandId, committedRevision: 1, linkGeneration: 1 }, error: null };
      if (args.p_action === "link") return { data: null, error: { code: "PGRST000" } };
      return initial(name, args);
    });
    const response = await POST(request({ ...issue, recipientMemberId: memberId }), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ commandId, committedRevision: 1, delivery: { status: "sent", memberId }, linkWarning: "link_unavailable" });
    expect(mocks.rpc.mock.calls.map(([, args]) => args.p_action)).toEqual(["issue", "link", "assign"]);
  });
  it.each([
    { assigned: true, memberId: id(99), handoff },
    { assigned: true, memberId, handoff: { ...handoff, id: id(99) } },
    { memberId, handoff },
    { assigned: true, memberId, handoff: { ...handoff, revision: 2147483648 } },
  ])("does not acknowledge an unconfirmed assignment response", async data => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    expect((await POST(request(deliver), params)).status).toBe(503);
    expect(mocks.queue).not.toHaveBeenCalled();
  });
  it("preserves legacy link issuance without touching delivery resources", async () => {
    const result = await (await POST(request(issue), params)).json();
    expect(result).toMatchObject({ handoff: { id: handoffId }, commandId, committedRevision: 1 });
    expect(result.url).toContain("/handoff#token="); expect(result).not.toHaveProperty("delivery");
    expect(mocks.rpc.mock.calls.map(([, args]) => args.p_action)).toEqual(["issue"]);
  });
});
