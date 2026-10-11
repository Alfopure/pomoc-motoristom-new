import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { MOBILE_HANDOFF_MAX_RESPONSE_BYTES, type MobileHandoffInput } from "@/lib/mobile-api";
import { MutationError } from "@/server/mutation-error";
import { handoffHash } from "@/server/case-handoff";
import { sealHandoffToken } from "@/server/handoff-secret";
import { getMobileCaseHandoffs, commandMobileCaseHandoff, parseMobileHandoffInput } from "./case-handoff";
import { GET, POST } from "@/app/api/mobile/v1/cases/[id]/handoffs/route";
const mocks = vi.hoisted(() => ({ user: vi.fn(), cookieClient: vi.fn(), cookieActor: vi.fn() }));
vi.mock("./user", () => ({ requireMobileUser: mocks.user }));
vi.mock("./auth", () => ({ mobileEnvironment: () => "test" }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.cookieClient }));
vi.mock("@/server/api-auth", () => ({ requireDefaultMotoristActor: mocks.cookieActor }));
const id = (n: number) => `91000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = { userId: id(1), profileId: id(2), organizationId: id(3), displayName: "Jana", role: "dispatcher" as const };
const caseId = id(4), grantId = id(5), commandId = id(6), previewVersion = "a".repeat(64), origin = "https://test.dispecing.linkapomoci.sk";
const token = "z".repeat(43), expiresAt = "2099-01-01T10:00:00.123456+00:00", createdAt = "2026-10-11T10:00:00.123456+00:00";
const issue: MobileHandoffInput = { action: "issue", commandId, recipientName: "Kolega", recipientPhone: "+421905123456", previewVersion, hours: 24, instructions: "Pri vozidle" };
const target = { commandId, handoffId: grantId, expectedRevision: 1 };
const legacy = { caseNumber: "PM-1", action: "Odťah", contact: { name: "Klient", phone: "+421905111222" }, vehicle: { make: "Škoda", model: "Fabia", plate: "ZA123AB" }, pickup: { address: "Žilina", lat: 0, lng: 0 }, destination: null };
const full = { ...legacy, schemaVersion: 3, vehicle: { ...legacy.vehicle, color: "žltá", driveable: false, conditionFlags: ["immobile"] }, assistance: { name: "Asistencia", reference: "REF-1" },
  replacement: { needed: false, category: "wagon", requestedType: "Veľké auto", preferences: ["automatic"], status: "not_needed", deliveryPlace: "Adresa", vehicle: { make: "VW", model: "Golf", plate: "ZA999AB" } },
  incident: { description: "Porucha", passengersCount: 0, access: "Garáž" }, caseCreatedAt: createdAt, firstCallAt: null };
function grant(overrides: Record<string, unknown> = {}) { return { id: grantId, status: "offered", revision: 1, publishedVersion: 1, recipientName: "Kolega", recipientPhone: "+421905123456", expiresAt, createdAt, openedAt: null, eta: null,
  published: { ...full, instructions: "Pokyny", scheduledAt: null }, events: [{ id: id(7), action: "issue", comment: "", actor: "Dispečing", createdAt }], canRenew: true, recoverable: true, tokenGeneration: 1, createdBy: null, publishedAt: createdAt, ...overrides }; }
function request(input: unknown = issue) { return new Request(`${origin}/api/mobile/v1/cases/${caseId}/handoffs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }); }
function fixture() {
  const rpc = vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code: string } | null }>>().mockResolvedValue({ data: { preview: full, previewVersion, handoffs: [grant()] }, error: null });
  const session = { actor, client: { rpc } as unknown as SupabaseClient<Database> }; mocks.user.mockResolvedValue(session);
  return { rpc, session };
}
function receipt(overrides: Record<string, unknown> = {}) { return { handoff: grant(), commandId, committedRevision: 1, tokenAccepted: false, ...overrides }; }
function recovered(overrides: Record<string, unknown> = {}) { return { handoff: grant(), generation: 1, tokenHash: handoffHash(token), origin,
  envelope: sealHandoffToken(token, { organizationId: actor.organizationId, caseId, handoffId: grantId, generation: 1, tokenHash: handoffHash(token), origin }), ...overrides }; }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("MOTORIST_HANDOFF_V3_ENABLED", "false"); vi.stubEnv("MOTORIST_APP_ENV", "test"); vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("APP_BASE_URL", origin);
  vi.stubEnv("MOTORIST_HANDOFF_KEY_ID", "v1"); vi.stubEnv("MOTORIST_HANDOFF_KEYS", JSON.stringify({ v1: Buffer.alloc(32, 3).toString("base64") }));
});
afterEach(() => vi.unstubAllEnvs());

describe("complete mobile handoff context", () => {
  it("uses only verified user client and explicit actor/org, preserving full V3 zero/false/null data", async () => {
    const { session, rpc } = fixture(); const result = await getMobileCaseHandoffs(session, caseId);
    expect(result.preview).toEqual(full); expect(result.previewVersion).toBe(previewVersion);
    expect(result.handoffs[0]).toMatchObject({ createdBy: null, recoverable: true, canRenew: true, published: { replacement: full.replacement } });
    expect(result.handoffs[0]).not.toHaveProperty("tokenGeneration");
    expect(rpc).toHaveBeenCalledWith("motorist_case_handoff", expect.objectContaining({ p_actor_id: actor.profileId, p_organization_id: actor.organizationId, p_case_id: caseId, p_action: "context" }));
    expect(mocks.cookieClient).not.toHaveBeenCalled(); expect(mocks.cookieActor).not.toHaveBeenCalled();
  });
  it.each([{ lat: 0, lng: null }, { lat: null, lng: 0 }])("preserves independently nullable coordinates %j", async coordinates => {
    const { session, rpc } = fixture(); const preview = { ...full, pickup: { address: "Adresa", ...coordinates } };
    rpc.mockResolvedValue({ data: { preview, previewVersion, handoffs: [] }, error: null });
    expect((await getMobileCaseHandoffs(session, caseId)).preview.pickup).toEqual(preview.pickup);
  });
  it("supports exact legacy snapshot and optional absent grant metadata", async () => {
    const { session, rpc } = fixture(); const old = grant({ published: legacy });
    delete (old as Record<string, unknown>).recoverable; delete (old as Record<string, unknown>).tokenGeneration; delete (old as Record<string, unknown>).createdBy; delete (old as Record<string, unknown>).publishedAt;
    rpc.mockResolvedValue({ data: { preview: legacy, previewVersion, handoffs: [old] }, error: null });
    expect((await getMobileCaseHandoffs(session, caseId)).handoffs[0]).toMatchObject({ published: legacy, recoverable: false, createdBy: null, publishedAt: null });
  });
  it.each([
    { ...full, schemaVersion: 4 }, { ...full, internalNote: "hidden" }, { ...full, contact: { ...full.contact, email: "hidden" } },
    { ...full, vehicle: { ...full.vehicle, conditionFlags: ["unknown"] } }, { ...full, replacement: { ...full.replacement, futureField: true } },
    { ...full, incident: { ...full.incident, passengersCount: -1 } }, { ...full, pickup: { address: "x", lat: 91, lng: 0 } },
    { ...legacy, assistance: full.assistance }, { ...full, assistance: undefined },
    { ...full, contact: { name: "x".repeat(321), phone: "" } }, { ...full, instructions: "x".repeat(2001) },
  ])("rejects unsupported or truncated preview %j", async preview => {
    const { session, rpc } = fixture(); rpc.mockResolvedValue({ data: { preview, previewVersion, handoffs: [] }, error: null });
    await expect(getMobileCaseHandoffs(session, caseId)).rejects.toMatchObject({ status: 503, code: "MOBILE_HANDOFF_SCHEMA_UNSUPPORTED" });
  });
  it("does not silently drop unknown published fields or invalid event data", async () => {
    const { session, rpc } = fixture(); rpc.mockResolvedValue({ data: { preview: full, previewVersion, handoffs: [grant({ published: { ...full, secret: "hidden" } })] }, error: null });
    await expect(getMobileCaseHandoffs(session, caseId)).rejects.toMatchObject({ status: 503 });
    rpc.mockResolvedValue({ data: { preview: full, previewVersion, handoffs: [grant({ events: [{ id: id(7), action: "unknown", comment: "", actor: "A", createdAt }] })] }, error: null });
    await expect(getMobileCaseHandoffs(session, caseId)).rejects.toMatchObject({ status: 503 });
  });
  it("fails explicitly at grant/event caps rather than truncating history", async () => {
    const { session, rpc } = fixture(); rpc.mockResolvedValue({ data: { preview: full, previewVersion, handoffs: Array.from({ length: 51 }, (_, n) => grant({ id: id(n + 100) })) }, error: null });
    await expect(getMobileCaseHandoffs(session, caseId)).rejects.toMatchObject({ code: "MOBILE_HANDOFF_CONTEXT_TOO_LARGE" });
    rpc.mockResolvedValue({ data: { preview: full, previewVersion, handoffs: [grant({ events: Array.from({ length: 201 }, (_, n) => ({ id: id(n + 100), action: "recover", comment: "", actor: "A", createdAt })) })] }, error: null });
    await expect(getMobileCaseHandoffs(session, caseId)).rejects.toMatchObject({ code: "MOBILE_HANDOFF_CONTEXT_TOO_LARGE" });
  });
});

describe("mobile handoff command boundary", () => {
  it.each([{ ...issue, actorId: id(9) }, { ...issue, tokenHash: "x" }, { ...issue, linkOrigin: origin }, { ...issue, expectedRevision: 1 },
    { ...issue, instructions: "a\0b" }, { ...issue, commandId: "bad" }, { ...target, action: "revoke", comment: " " }, { ...target, action: "recover", hours: 24 }])("rejects spoofed/action-inappropriate input %j", value => {
    expect(() => parseMobileHandoffInput(value)).toThrow(MutationError);
  });
  it.each(["\ud800", "\udc00"])("rejects malformed UTF-16 %j before any RPC", async instructions => {
    const { session, rpc } = fixture();
    await expect(commandMobileCaseHandoff(session, request(), caseId, { ...issue, instructions })).rejects.toMatchObject({ status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("uses existing phone/text/date/default normalization exactly", () => {
    expect(parseMobileHandoffInput({ ...issue, recipientName: " Kolega ", recipientPhone: "0905 123 456", scheduledAt: "2026-10-11T12:00:00+02:00", hours: undefined })).toMatchObject({ recipientName: "Kolega", recipientPhone: "+421905123456", hours: 24, scheduledAt: "2026-10-11T10:00:00.000Z" });
  });
  it("keeps a legacy confirmed replay saved without fabricating a new URL", async () => {
    const { session, rpc } = fixture(); rpc.mockResolvedValue({ data: receipt(), error: null });
    expect(await commandMobileCaseHandoff(session, request(), caseId, issue)).toMatchObject({ kind: "mutation", caseId, handoffId: grantId, commandId, action: "issue", committedRevision: 1, currentRevision: 1, link: { status: "unavailable", warning: "link_unavailable" } });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("fresh legacy URL uses canonical configuration, not request host", async () => {
    const { session, rpc } = fixture(); rpc.mockResolvedValue({ data: receipt({ tokenAccepted: true }), error: null });
    const result = await commandMobileCaseHandoff(session, new Request("https://attacker.test"), caseId, issue);
    expect(result.link).toMatchObject({ status: "available", expiresAt, currentRevision: 1 });
    expect(JSON.stringify(result)).toContain(origin + "/handoff#token="); expect(JSON.stringify(result)).not.toContain("attacker.test");
  });
  it.each(["publish", "renew", "extend", "revoke"] as const)("checks exact %s commit revision independently of current state", async action => {
    vi.stubEnv("MOTORIST_HANDOFF_V3_ENABLED", action === "extend" ? "true" : "false");
    const { session, rpc } = fixture(); rpc.mockResolvedValue({ data: receipt({ handoff: grant({ revision: 9 }), committedRevision: 2 }), error: null });
    const input = { ...target, action, ...(action === "publish" ? { previewVersion } : {}), ...(action === "revoke" ? { comment: "Zrušené" } : {}) } as MobileHandoffInput;
    expect(await commandMobileCaseHandoff(session, request(), caseId, input)).toMatchObject({ kind: "mutation", committedRevision: 2, currentRevision: 9 });
    rpc.mockResolvedValue({ data: receipt({ handoff: grant({ revision: 9 }), committedRevision: 3 }), error: null });
    await expect(commandMobileCaseHandoff(session, request(), caseId, input)).rejects.toMatchObject({ status: 503 });
  });
  it.each([{ commandId: id(9) }, { committedRevision: 2 }, { handoff: grant({ revision: 0 }) }, { handoff: grant({ status: "other" }) }, { handoff: grant({ publishedVersion: 0 }) }, { handoff: grant({ publishedVersion: 2_147_483_648 }) }])("refuses unconfirmed mutation identity/revision %j", async patch => {
    const { session, rpc } = fixture(); rpc.mockResolvedValue({ data: receipt(patch), error: null });
    await expect(commandMobileCaseHandoff(session, request(), caseId, issue)).rejects.toMatchObject({ status: 503 });
  });
  it.each([{ expiresAt: "bad" }, { expiresAt: createdAt }, { status: "completed" }, { published: { unknownSchema: true } }])("separates confirmed identity from optional link/current snapshot %j", async patch => {
    const { session, rpc } = fixture(); rpc.mockResolvedValue({ data: receipt({ handoff: grant(patch), tokenAccepted: true }), error: null });
    const result = await commandMobileCaseHandoff(session, request(), caseId, issue);
    expect(result).toMatchObject({ kind: "mutation", committedRevision: 1 });
    expect(result.link.status).toBe("published" in patch ? "available" : "unavailable");
  });
});

describe("enhanced committed link resolution", () => {
  beforeEach(() => vi.stubEnv("MOTORIST_HANDOFF_V3_ENABLED", "true"));
  it.each(["rpc", "envelope", "foreign grant", "generation", "origin", "expiry", "terminal"])("retains committed mutation on later %s failure", async failure => {
    const { session, rpc } = fixture();
    let link = recovered();
    if (failure === "envelope") link = recovered({ envelope: {} });
    if (failure === "foreign grant") link = recovered({ handoff: grant({ id: id(90) }) });
    if (failure === "generation") link = recovered({ generation: 2 });
    if (failure === "origin") link = recovered({ origin: "https://foreign.test" });
    if (failure === "expiry") link = recovered({ handoff: grant({ expiresAt: createdAt }) });
    if (failure === "terminal") link = recovered({ handoff: grant({ status: "cancelled" }) });
    rpc.mockImplementation(async (_name, args) => args.p_action === "issue" ? { data: receipt({ linkGeneration: 1 }), error: null } : failure === "rpc" ? { data: null, error: { code: "PGRST000" } } : { data: link, error: null });
    expect(await commandMobileCaseHandoff(session, request(), caseId, issue)).toMatchObject({ kind: "mutation", committedRevision: 1, link: { status: "unavailable" } });
  });
  it("recovers original generation on exact issue replay while observing a newer grant revision", async () => {
    const { session, rpc } = fixture();
    rpc.mockImplementation(async (_name, args) => args.p_action === "issue" ? { data: receipt({ linkGeneration: 1, handoff: grant({ revision: 2 }) }), error: null } : { data: recovered({ handoff: grant({ revision: 3 }) }), error: null });
    const result = await commandMobileCaseHandoff(session, request(), caseId, issue);
    expect(result).toMatchObject({ kind: "mutation", committedRevision: 1, currentRevision: 2, link: { status: "available", url: `${origin}/handoff#token=${token}`, currentRevision: 3, expiresAt } });
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_action: "link", p_input: { handoffId: grantId, generation: 1, commandId } });
    expect(JSON.stringify(result)).not.toMatch(/envelope|tokenHash|tokenGeneration|linkGeneration/);
  });
  it("returns standalone recover as current-link read, never a mutation receipt", async () => {
    const { session, rpc } = fixture(); rpc.mockResolvedValue({ data: recovered({ handoff: grant({ revision: 9 }) }), error: null });
    const result = await commandMobileCaseHandoff(session, request(), caseId, { ...target, action: "recover" });
    expect(result).toMatchObject({ kind: "link", handoffId: grantId, currentRevision: 9, link: { status: "available" } }); expect(result).not.toHaveProperty("committedRevision");
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_action: "link", p_input: { handoffId: grantId, commandId } });
  });
  it.each(["https://foreign.test", "https://test.dispecing.linkapomoci.sk/path", "https://user:pass@test.dispecing.linkapomoci.sk", "https://test.dispecing.linkapomoci.sk?x=1", "https://test.dispecing.linkapomoci.sk/"])("rejects a cryptographically valid link at unacceptable origin %s while retaining receipt", async linkOrigin => {
    const { session, rpc } = fixture();
    const envelope = sealHandoffToken(token, { organizationId: actor.organizationId, caseId, handoffId: grantId, generation: 1, tokenHash: handoffHash(token), origin: linkOrigin });
    rpc.mockImplementation(async (_name, args) => args.p_action === "issue" ? { data: receipt({ linkGeneration: 1 }), error: null }
      : { data: recovered({ origin: linkOrigin, envelope }), error: null });
    expect(await commandMobileCaseHandoff(session, request(), caseId, issue)).toMatchObject({ kind: "mutation", committedRevision: 1, link: { status: "unavailable" } });
  });
  it("keeps a confirmed receipt when only the later link response exceeds the transport cap", async () => {
    const { session, rpc } = fixture(); rpc.mockImplementation(async (_name, args) => args.p_action === "issue"
      ? { data: receipt({ linkGeneration: 1 }), error: null } : { data: null, error: { code: "MOBILE_RESPONSE_TOO_LARGE" } });
    expect(await commandMobileCaseHandoff(session, request(), caseId, issue)).toMatchObject({ kind: "mutation", committedRevision: 1, link: { status: "unavailable" } });
  });
  it("uses original normalized command across enhanced renew replay, with original committed generation", async () => {
    const { session, rpc } = fixture(); const input: MobileHandoffInput = { ...target, action: "renew", hours: 24 };
    rpc.mockImplementation(async (_name, args) => args.p_action === "context" ? { data: { handoffs: [grant({ tokenGeneration: 2 })] }, error: null }
      : args.p_action === "renew" ? { data: receipt({ committedRevision: 2, handoff: grant({ revision: 3 }), linkGeneration: 2 }), error: null }
      : { data: { ...recovered(), handoff: grant({ revision: 3 }), generation: 2, envelope: sealHandoffToken(token, { organizationId: actor.organizationId, caseId, handoffId: grantId, generation: 2, tokenHash: handoffHash(token), origin }) }, error: null });
    const first = await commandMobileCaseHandoff(session, request(), caseId, input), second = await commandMobileCaseHandoff(session, request(), caseId, input);
    expect(second).toEqual(first); expect(first).toMatchObject({ committedRevision: 2, currentRevision: 3, link: { status: "available" } });
    const writes = rpc.mock.calls.filter(call => call[1].p_action === "renew");
    for (const call of writes) expect(call[1].p_input).toMatchObject({ ...input, secretGeneration: 3 });
    for (const call of rpc.mock.calls.filter(call => call[1].p_action === "link")) expect(call[1].p_input).toMatchObject({ generation: 2 });
  });
  it("pre-RPC key/context failure remains uncertain and does not fabricate a receipt", async () => {
    const { session, rpc } = fixture(); vi.stubEnv("MOTORIST_HANDOFF_KEYS", "{}");
    await expect(commandMobileCaseHandoff(session, request(), caseId, issue)).rejects.toMatchObject({ status: 503 }); expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST000" } });
    await expect(commandMobileCaseHandoff(session, request(), caseId, { ...target, action: "renew" })).rejects.toMatchObject({ status: 503 });
    expect(rpc.mock.calls.map(call => call[1].p_action)).toEqual(["context"]);
  });
});

describe("Bearer handoff route", () => {
  it("authenticates before body parsing with capped user RPC and private headers", async () => {
    fixture(); mocks.user.mockRejectedValue(new MutationError("login", 401));
    const response = await POST(request({ spoof: true }), { params: Promise.resolve({ id: caseId }) });
    expect(response.status).toBe(401); expect(response.headers.get("www-authenticate")).toBe("Bearer"); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.user).toHaveBeenCalledWith(expect.any(Request), { maxResponseBytes: MOBILE_HANDOFF_MAX_RESPONSE_BYTES });
  });
  it("rejects invalid or oversized bodies only after authentication", async () => {
    const { rpc } = fixture();
    for (const body of [{ ...issue, actorId: id(9) }, { ...issue, instructions: "x".repeat(64001) }]) {
      const response = await POST(request(body), { params: Promise.resolve({ id: caseId }) }); expect(response.status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled(); expect(mocks.user).toHaveBeenCalledTimes(2);
  });
  it("keeps generic SQL conflicts explicit and does not retry or reveal provider errors", async () => {
    const { rpc } = fixture(); rpc.mockResolvedValue({ data: null, error: { code: "PT409" } });
    const response = await POST(request(), { params: Promise.resolve({ id: caseId }) }); expect(response.status).toBe(409); expect(rpc).toHaveBeenCalledTimes(1);
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST000" } });
    const unknown = await POST(request(), { params: Promise.resolve({ id: caseId }) });
    expect(unknown.status).toBe(503); expect(await unknown.json()).toMatchObject({ code: "HANDOFF_UNCONFIRMED" });
  });
  it.each(["recover", "extend"] as const)("keeps disabled enhanced action %s disabled without RPC", async action => {
    const { rpc } = fixture(); const response = await POST(request({ ...target, action }), { params: Promise.resolve({ id: caseId }) });
    expect(response.status).toBe(503); expect(rpc).not.toHaveBeenCalled();
  });
  it("returns explicit transport cap code and never claims oversized mutation saved", async () => {
    const { rpc } = fixture(); rpc.mockResolvedValue({ data: null, error: { code: "MOBILE_RESPONSE_TOO_LARGE" } });
    const response = await POST(request(), { params: Promise.resolve({ id: caseId }) });
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ ok: false, code: "MOBILE_RESPONSE_TOO_LARGE" });
  });
  it("returns scoped context and minimal receipt without credentials", async () => {
    const { rpc } = fixture(); const context = await GET(new Request(origin), { params: Promise.resolve({ id: caseId }) });
    expect(context.status).toBe(200); expect(await context.json()).toMatchObject({ environment: "test", profileId: actor.profileId, caseId });
    rpc.mockResolvedValue({ data: receipt(), error: null }); const mutation = await POST(request(), { params: Promise.resolve({ id: caseId }) });
    expect(mutation.status).toBe(200); expect(await mutation.json()).toMatchObject({ kind: "mutation", commandId, committedRevision: 1 });
  });
});
