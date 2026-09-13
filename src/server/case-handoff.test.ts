import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ userRpc: vi.fn(), publicRpc: vi.fn(), actor: vi.fn(), cookieGet: vi.fn(), cookieSet: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ rpc: mocks.userRpc }) }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: mocks.publicRpc }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookieGet, set: mocks.cookieSet }) }));
vi.mock("./api-auth", () => ({ requireDefaultMotoristActor: mocks.actor }));
import { commandCaseHandoff, getCaseHandoffContext, HANDOFF_COOKIE, handoffHash, handoffResponse, publicHandoff, readHandoffBody, validateHandoffCommand } from "./case-handoff";
const grant = "10000000-0000-4000-8000-000000000001", caseId = "20000000-0000-4000-8000-000000000001", commandId = "30000000-0000-4000-8000-000000000001";
const token = "a".repeat(43), session = "b".repeat(43);
const handoff = { id: grant, status: "offered", revision: 1, publishedVersion: 1, published: { caseNumber: "PM-1" } };
const issue = { action: "issue", commandId, recipientName: "Kolega", recipientPhone: "+421907987654", previewVersion: "c".repeat(64), hours: 24, instructions: "Zavolať pri príchode" };
const decision = { action: "accept", commandId, handoffId: grant, expectedRevision: 1, publishedVersion: 1 };
function request(path: string, body?: unknown, headers: HeadersInit = {}) { return new Request(`https://preview.test${path}`, body === undefined ? { headers } : { method: "POST", headers: { Origin: "https://preview.test", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }); }
beforeEach(() => {
  vi.clearAllMocks(); mocks.actor.mockResolvedValue({ organizationId: "org", profileId: "actor" });
  mocks.cookieGet.mockReturnValue({ value: session });
  mocks.userRpc.mockResolvedValue({ data: { handoff, commandId, committedRevision: 1, tokenAccepted: true }, error: null });
  mocks.publicRpc.mockResolvedValue({ data: { handoff, commandId, committedRevision: 1, sessionExpiresAt: "2030-01-01T12:00:00Z" }, error: null });
});

describe("limited handoff HTTP boundary", () => {
  it.each(["https://foreign.test", "null", ""]) ("rejects origin %s before reading private data", async origin => {
    await expect(readHandoffBody(request("/api/public/handoffs/session", { token }, { Origin: origin }))).rejects.toMatchObject({ status: 403 });
    expect(mocks.publicRpc).not.toHaveBeenCalled();
  });
  it("requires JSON, bounds declared and streamed bytes, and rejects primitive bodies", async () => {
    await expect(readHandoffBody(request("/api/public/handoffs/session", {}, { "Content-Type": "text/plain" }))).rejects.toMatchObject({ status: 415 });
    await expect(readHandoffBody(request("/api/public/handoffs/session", {}, { "Content-Length": "17000" }))).rejects.toMatchObject({ status: 413 });
    await expect(readHandoffBody(request("/api/public/handoffs/session", { token: "a".repeat(16_001) }))).rejects.toMatchObject({ status: 413 });
    await expect(readHandoffBody(request("/api/public/handoffs/session", []))).rejects.toMatchObject({ status: 400 });
  });
  it("exchanges a bearer only for a secure purpose-limited cookie, never passing raw secrets to SQL", async () => {
    await publicHandoff(request("/api/public/handoffs/session", { token }), "session");
    expect(mocks.publicRpc).toHaveBeenCalledWith("motorist_public_handoff", { p_action: "session", p_token_hash: handoffHash(token), p_input: { sessionHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(JSON.stringify(mocks.publicRpc.mock.calls)).not.toContain(token);
    expect(mocks.cookieSet).toHaveBeenCalledWith(HANDOFF_COOKIE, expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expect.objectContaining({ httpOnly: true, secure: true, sameSite: "strict", path: "/api/public/handoffs", expires: new Date("2030-01-01T12:00:00Z") }));
    expect(mocks.actor).not.toHaveBeenCalled();
  });
  it("requires the displayed grant ID even for read, not merely a cookie from another tab", async () => {
    await expect(publicHandoff(request("/api/public/handoffs/current"), "read")).rejects.toMatchObject({ status: 400 });
    expect(mocks.publicRpc).not.toHaveBeenCalled();
    await publicHandoff(request(`/api/public/handoffs/current?handoff=${grant}`), "read");
    expect(mocks.publicRpc).toHaveBeenCalledWith("motorist_public_handoff", { p_action: "read", p_token_hash: handoffHash(session), p_input: { handoffId: grant } });
  });
  it("requires the limited credential and rejects a location token or ordinary app cookie", async () => {
    mocks.cookieGet.mockReturnValue(undefined);
    await expect(publicHandoff(request(`/api/public/handoffs/current?handoff=${grant}`, undefined, { Cookie: "sb-session=app-account" }), "read")).rejects.toMatchObject({ status: 404 });
    await expect(publicHandoff(request("/api/public/handoffs/session", { token: "not-a-handoff-token" }), "session")).rejects.toMatchObject({ status: 404 });
    expect(mocks.publicRpc).not.toHaveBeenCalled();
  });
  it("requires internal account authorization despite a valid limited cookie", async () => {
    mocks.actor.mockRejectedValue(Object.assign(new Error("Prihláste sa"), { status: 401 }));
    await expect(getCaseHandoffContext(caseId)).rejects.toMatchObject({ status: 401 });
    expect(mocks.userRpc).not.toHaveBeenCalled();
  });
  it("uses authenticated actor scope, fresh token hashes and an explicit relative handoff URL", async () => {
    const result = await commandCaseHandoff(request(`/api/cases/${caseId}/handoffs`, { ...issue, organizationId: "forged", actorId: "forged", tokenHash: "forged" }), caseId);
    const args = mocks.userRpc.mock.calls[0][1];
    expect(args).toMatchObject({ p_organization_id: "org", p_actor_id: "actor", p_case_id: caseId, p_action: "issue" });
    expect(args.p_input).not.toHaveProperty("organizationId"); expect(args.p_input.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    const url = new URL(result.url!); expect(url.origin).toBe("https://preview.test"); expect(url.pathname).toBe("/handoff"); expect(url.search).toBe("");
    const secret = new URLSearchParams(url.hash.slice(1)).get("token")!; expect(handoffHash(secret)).toBe(args.p_input.tokenHash);
  });
  it("a replay cannot fabricate a fresh valid URL when the first issue response was lost", async () => {
    mocks.userRpc.mockResolvedValue({ data: { handoff, commandId, committedRevision: 1, tokenAccepted: false }, error: null });
    expect(await commandCaseHandoff(request(`/api/cases/${caseId}/handoffs`, issue), caseId)).not.toHaveProperty("url");
  });
  it.each([
    { handoff: { ...handoff, id: caseId }, commandId, committedRevision: 1 },
    { handoff, commandId: caseId, committedRevision: 1 },
    { handoff, commandId, committedRevision: 2 },
    { handoff: { ...handoff, revision: 0 }, commandId, committedRevision: 1 },
    { handoff: { ...handoff, status: "unknown" }, commandId, committedRevision: 1 },
  ])("keeps an invalid or cross-grant receipt uncertain", async data => {
    mocks.publicRpc.mockResolvedValue({ data, error: null });
    await expect(publicHandoff(request("/api/public/handoffs/commands", decision), "command")).rejects.toMatchObject({ status: 503 });
  });
  it.each([["42501", 403], ["P0002", 404], ["PT409", 409], ["PGRST202", 503], ["22023", 400], ["54000", 429]])("returns sanitized error for SQL %s", async (code, status) => {
    mocks.publicRpc.mockResolvedValue({ error: { code, message: "PRIVATE_RECORD_TOKEN_AND_CUSTOMER" } });
    await expect(publicHandoff(request("/api/public/handoffs/commands", decision), "command")).rejects.toMatchObject({ status });
    await expect(publicHandoff(request("/api/public/handoffs/commands", decision), "command")).rejects.not.toMatchObject({ message: "PRIVATE_RECORD_TOKEN_AND_CUSTOMER" });
  });
  it("sets no-store, no-referrer, noindex and frame isolation headers", () => {
    const response = handoffResponse({});
    expect(response.headers.get("Cache-Control")).toContain("no-store"); expect(response.headers.get("Referrer-Policy")).toBe("no-referrer"); expect(response.headers.get("X-Robots-Tag")).toContain("noindex"); expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });
});

describe("handoff commands", () => {
  it.each([{ action: "delete_case" }, { commandId: "bad" }, { handoffId: undefined }, { expectedRevision: 0 }, { expectedRevision: 1.2 }, { publishedVersion: 0 }, { comment: "x".repeat(1001) }])("rejects invalid public decision %j", patch => expect(() => validateHandoffCommand({ ...decision, ...patch }, true)).toThrow());
  it.each(["reject", "blocked", "revoke"])("requires a real %s reason", action => expect(() => validateHandoffCommand({ ...decision, action, comment: "\n\t " }, action !== "revoke")).toThrow("dôvod"));
  it("drops client-injected status, snapshot, organization and token fields", () => {
    expect(validateHandoffCommand({ ...decision, status: "completed", published: { contact: "forged" }, organizationId: "other", tokenHash: "forged" }, true)).toEqual(decision);
  });
  it.each([0, 73, 2.5])("rejects out-of-range TTL %s", hours => expect(() => validateHandoffCommand({ ...issue, hours })).toThrow());
});
