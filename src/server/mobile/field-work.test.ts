import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), rpc: vi.fn(), from: vi.fn(), legacy: new Set<string>() }));
vi.mock("./auth", () => ({ mobileEnvironment: () => "test", verifyMobileUser: mocks.user, requireMobileActor: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: mocks.rpc, from: mocks.from }) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/server/default-organization", () => ({ resolveDefaultOrganizationId: vi.fn() }));

const work = await import("./field-work");
const { GET: workRoute } = await import("@/app/api/mobile/v1/field/work/route");
const { POST: commandRoute } = await import("@/app/api/mobile/v1/field/operations/[id]/commands/route");
const { POST: trackerRoute, DELETE: untrackRoute } = await import("@/app/api/mobile/v1/field/operations/[id]/tracker/route");
const { POST: trackRoute } = await import("@/app/api/mobile/v1/field/operations/track/route");
const { trackerHash } = await import("./delivery");
const stableTest = { MOBILE_DELIVERY_ENABLED: "true", MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev", VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk",
  APP_BASE_URL: "https://test.dispecing.linkapomoci.sk", SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co" };

const id = (n: number) => `93000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1), USER = id(2), MEMBER = id(3), OP = id(4), CMD = id(5), ORDER = id(6), OTHER = id(7);
const at = "2026-10-28T08:00:00.000000+00:00";
const actor = { userId: USER, memberId: MEMBER, organizationId: ORG, displayName: "Pavol", email: null, version: 3, capabilities: ["deliver", "drive"], roles: ["delivery", "driver"] };
const member = { id: MEMBER, userId: USER, organizationId: ORG, displayName: "Pavol", email: "p@example.test", active: true, version: 3, capabilities: ["deliver", "drive"], roles: ["delivery", "driver"] };
function operation(overrides: Record<string, unknown> = {}) {
  return { id: OP, kind: "transfer", owner: "logistics", ownerId: OP, status: "accepted", revision: 4, assignmentGeneration: 1, caseId: id(20), caseNumber: "PM-2026-7",
    cycleId: id(21), fleetAssetId: id(22), vehicle: "Škoda Octavia BA123XY", from: "Parkovisko", to: "Servis", scheduledAt: at, plannedEndAt: null, confirmedAt: at, startedAt: null,
    assigneeId: MEMBER, assignee: "Pavol", updatedAt: at, evidenceState: "pending", customer: { name: "Ján Klient", phone: "+421900111222" },
    cycle: { id: id(21), revision: 2, fleetAssetId: id(22), returnMode: "collect", returnAt: null, nextOwner: "Interná poznámka", status: "open", returnOperationId: null, readiness: "blocked" },
    evidence: [{ id: id(30), stage: "pickup", authorUserId: USER, observedAt: at, source: "observed", person: "Jozef", note: "", photoReference: `${ORG}/${OP}/${id(31)}.jpg`, odometer: 1200, fuel: "1/2", missingReason: null, damageResolver: null, damageStatus: null }],
    ...overrides };
}
function towingOrder(overrides: Record<string, unknown> = {}, fieldPatch: Record<string, unknown> = {}) {
  return { id: ORDER, number: "OT-2026-0005", sourceCaseId: null, revision: 7, assignmentGeneration: 2, driverId: MEMBER, workStatus: "in_progress", billingStatus: "not_ready", paymentStatus: "unpaid",
    fields: { serviceType: "tow", subjectType: "vehicle", subjectDescription: "VW Golf", pickup: "D1 km 120", destination: "Servis Žilina", plate: "ZA111AA", contact: "+421900222333",
      startedAt: at, startSource: "manual", requester: { name: "Asistencia s.r.o.", phone: "+421" }, customer: { name: "Mária", phone: "+421900333444" }, ...fieldPatch },
    authorizedCollectionCents: 15000, receivedCents: 5000, dueCents: 15000, reconciliationRequired: false, createdAt: at, updatedAt: at,
    attachments: [{ id: id(40), kind: "work", name: "foto.jpg", mimeType: "image/jpeg", size: 1000, status: "ready", createdAt: at }, { id: id(41), kind: "scan", name: "x.pdf", mimeType: "application/pdf", size: 10, status: "abandoned", createdAt: at }],
    payments: [{ id: id(42), receiptId: id(43), amountCents: 5000, method: "cash", driverId: MEMBER, createdAt: at }], ...overrides };
}
function rpcs(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "motorist_towing_actor") return { data: member, error: null };
    if (name === "motorist_field_operations_context" && !handlers[name]) return { data: Object.fromEntries((args.p_operation_ids as string[]).map(item =>
      [item, { legacy: mocks.legacy.has(item), instructions: item === OP ? "Kľúče sú na recepcii." : null }])), error: null };
    const handler = handlers[name];
    if (!handler) return { data: null, error: { code: "PGRST202" } };
    try { return { data: handler(args), error: null }; } catch (error) { return { data: null, error }; }
  });
}
const workspace = (operations: unknown[]) => ({ actor: { userId: USER, organizationId: ORG, canDispatch: false, memberId: MEMBER }, operations, totalCount: operations.length, members: [], fleet: [] });
const bearer = (body?: unknown) => new Request("https://app.test/api", { method: body === undefined ? "GET" : "POST",
  headers: { authorization: "Bearer x", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MOBILE_DELIVERY_ENABLED", "true");
  vi.stubEnv("MOTORIST_TOWING_ENABLED", "true");
  mocks.user.mockResolvedValue({ userId: USER, email: undefined, organizationId: ORG, expectedOrganization: null });
  mocks.legacy.clear();
  const cases = { select: vi.fn(), eq: vi.fn(), in: vi.fn().mockResolvedValue({ data: [], error: null }) };
  cases.select.mockReturnValue(cases); cases.eq.mockReturnValue(cases);
  mocks.from.mockReturnValue(cases);
});
afterEach(() => vi.unstubAllEnvs());

describe("Moja práca: operations", () => {
  it("projects an allowlist: no cycle, owner, file paths or other people", () => {
    const projected = work.projectOperation(operation(), MEMBER, "Kľúče");
    expect(projected).toEqual({ id: OP, kind: "transfer", status: "accepted", revision: 4, caseNumber: "PM-2026-7", vehicle: "Škoda Octavia BA123XY", from: "Parkovisko", to: "Servis",
      scheduledAt: at, plannedEndAt: null, startedAt: null, updatedAt: at, customer: { name: "Ján Klient", phone: "+421900111222" }, instructions: "Kľúče", vehicleConfirmed: true,
      evidenceState: "pending", evidence: [{ id: id(30), stage: "pickup", observedAt: at, source: "observed", person: "Jozef", note: "", photo: true, odometer: 1200, fuel: "1/2", missingReason: null, damageStatus: null }] });
    expect(JSON.stringify(projected)).not.toContain("Interná poznámka");
    expect(JSON.stringify(projected)).not.toContain(ORG);
  });
  it("withholds the customer and instructions once finished, and refuses someone else's work", () => {
    expect(work.projectOperation(operation({ status: "completed" }), MEMBER, "Kľúče")).toMatchObject({ customer: null, instructions: null });
    expect(() => work.projectOperation(operation({ assigneeId: OTHER }), MEMBER)).toThrow();
    expect(() => work.projectOperation(operation({ owner: "towing_order" }), MEMBER)).toThrow();
  });
  it("lists only own open logistics work with branch instructions, without legacy deliveries", async () => {
    mocks.legacy.add(id(10));
    rpcs({ motorist_operations_workspace: () => workspace([operation(), operation({ id: id(8), status: "draft" }), operation({ id: id(9), owner: "towing_order" }), operation({ id: id(10) })]) });
    const list = await work.loadFieldOperations(actor);
    expect(list?.map(item => [item.id, item.instructions])).toEqual([[OP, "Kľúče sú na recepcii."]]);
    expect(mocks.rpc).toHaveBeenCalledWith("motorist_field_operations_context", { p_user_id: USER, p_organization_id: ORG, p_operation_ids: [OP, id(10)] });
    await expect(work.readFieldOperation(actor, id(10))).rejects.toMatchObject({ status: 404, code: "work_in_deliveries" });
    // Without the context RPC (migration not applied) Moja práca says so instead of guessing.
    rpcs({ motorist_operations_workspace: () => workspace([operation()]), motorist_field_operations_context: () => { throw { code: "PGRST202" }; } });
    await expect(work.loadFieldOperations(actor)).rejects.toMatchObject({ status: 503, code: "work_unavailable" });
    expect(mocks.rpc).toHaveBeenCalledWith("motorist_operations_workspace", { p_user_id: USER, p_organization_id: ORG, p_filters: { view: "open", limit: 50, offset: 0, mine: true } });
    expect(await work.loadFieldOperations({ ...actor, capabilities: ["drive"] })).toBeNull();
  });
  it("adds assistance from the authorized operation's case without exposing the case DTO", async () => {
    const query = mocks.from();
    query.in.mockResolvedValue({ data: [{ id: id(20), assistance_name: "Allianz", assistance_case_reference: "AS-42", privateNote: "Do not expose", assistance_reference: "OLD" }], error: null });
    rpcs({ motorist_operations_workspace: () => workspace([operation()]) });
    const result = await work.readFieldOperation(actor, OP);
    expect(result).toMatchObject({ caseNumber: "PM-2026-7", assistance: { name: "Allianz", reference: "AS-42" } });
    expect(query.select).toHaveBeenCalledWith("id,assistance_name:customer_details->>assistanceServiceName,assistance_case_reference:customer_details->>assistanceReference,assistance_reference");
    expect(query.eq).toHaveBeenCalledWith("organization_id", ORG);
    expect(query.in).toHaveBeenCalledWith("id", [id(20)]);
    expect(JSON.stringify(result)).not.toContain("Do not expose");
    expect(JSON.stringify(result)).not.toContain(id(20));
    query.in.mockResolvedValue({ data: [{ id: id(20), assistance_name: null, assistance_case_reference: null, assistance_reference: "LEGACY-9" }], error: null });
    expect(await work.readFieldOperation(actor, OP)).toMatchObject({ assistance: { name: null, reference: "LEGACY-9" } });
    expect(work.projectOperation(operation({ status: "completed" }), MEMBER, null, { name: "A", reference: "AS-42" })).toMatchObject({ assistance: null });
  });
  it("loads the second authorized page within the existing 100-operation bound", async () => {
    rpcs({ motorist_operations_workspace: args => ({ ...workspace([operation({ id: (args.p_filters as Record<string, unknown>).offset === 50 ? OTHER : OP })]), totalCount: 51 }) });
    expect((await work.loadFieldOperations(actor))?.map(op => op.id)).toEqual([OP, OTHER]);
    expect(mocks.rpc).toHaveBeenCalledWith("motorist_operations_workspace", expect.objectContaining({ p_filters: { view: "open", limit: 50, offset: 50, mine: true } }));
  });
  it("opens only a verified physical blocker after a real refusal and keeps planned conflicts separate", async () => {
    const handlers = {
      motorist_operations_workspace: () => workspace([operation()]),
      motorist_operations_command: () => { throw { code: "PT409", message: "Driver physically busy" }; },
      motorist_towing_workspace: () => ({ view: "driver", orders: [towingOrder()], members: [] }),
    };
    rpcs(handlers);
    const response = await commandRoute(bearer({ commandId: CMD, action: "start", expectedRevision: 4, payload: {} }), { params: Promise.resolve({ id: OP }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "work_refused", conflict: { kind: "physical", blocker: { kind: "towing", id: ORDER, number: "OT-2026-0005" } } });
    rpcs({ ...handlers, motorist_towing_workspace: () => ({ view: "driver", orders: [towingOrder({ driverId: OTHER })], members: [] }) });
    await expect(work.commandFieldOperation(actor, OP, { commandId: CMD, action: "start", expectedRevision: 4, payload: {} })).rejects.toMatchObject({ conflict: { kind: "physical", blocker: null } });
    rpcs({ ...handlers, motorist_operations_command: () => { throw { code: "PT409", message: "Capacity conflict" }; } });
    await expect(work.commandFieldOperation(actor, OP, { commandId: CMD, action: "start", expectedRevision: 4, payload: {} })).rejects.toMatchObject({ conflict: { kind: "schedule", blocker: null } });
  });
  it("resolves a towing start blocked by an accessible active logistics operation", async () => {
    rpcs({
      motorist_operations_workspace: () => workspace([operation({ status: "en_route", startedAt: at })]),
      motorist_towing_workspace: () => ({ view: "driver", orders: [towingOrder({ workStatus: "assigned" })], members: [] }),
      motorist_towing_command: () => { throw { code: "PT409", message: "Driver capacity conflict" }; },
    });
    await expect(work.commandFieldTowing(actor, ORDER, { commandId: CMD, type: "start", expectedRevision: 7, assignmentGeneration: 2, payload: {} }))
      .rejects.toMatchObject({ status: 409, code: "work_refused", conflict: { kind: "physical", blocker: { kind: "operation", id: OP, number: "PM-2026-7" } } });
  });
  it("accepts only field steps and complete evidence", () => {
    expect(work.readOperationCommand({ commandId: CMD, action: "accept", expectedRevision: 4, payload: {} })).toEqual({ commandId: CMD, action: "accept", expectedRevision: 4, payload: {} });
    for (const bad of [{ action: "assign" }, { action: "cancel" }, { expectedRevision: 0 }, { payload: { reason: "x" } }, { extra: true }, { commandId: "x" }]) {
      expect(() => work.readOperationCommand({ commandId: CMD, action: "accept", expectedRevision: 4, payload: {}, ...bad })).toThrow();
    }
    const evidence = { stage: "handover", source: "observed", observedAt: "2026-10-28T08:00:00Z", person: "Ján", note: " ok ", photoReference: `${ORG}/${OP}/${id(31)}.jpg`, odometer: 1250, fuel: "1/2", missingReason: null };
    expect(work.readOperationCommand({ commandId: CMD, action: "evidence", expectedRevision: 4, payload: evidence }).payload).toMatchObject({ note: "ok", observedAt: "2026-10-28T08:00:00.000Z" });
    const reject = (patch: Record<string, unknown>) => expect(() => work.readOperationCommand({ commandId: CMD, action: "evidence", expectedRevision: 4, payload: { ...evidence, ...patch } })).toThrow();
    reject({ stage: "inspection" });
    reject({ person: null });
    reject({ odometer: null });
    reject({ photoReference: null });
    reject({ photoReference: "../../x.jpg" });
    reject({ source: "exception" });
    reject({ damageResolver: "Servis" });
    reject({ stage: "damage", note: "Škrabanec" });
    reject({ observedAt: "2099-01-01T00:00:00Z" });
    expect(work.readOperationCommand({ commandId: CMD, action: "evidence", expectedRevision: 4, payload: { ...evidence, person: null, odometer: null, photoReference: null, missingReason: "Klient neprišiel" } }).payload)
      .toMatchObject({ missingReason: "Klient neprišiel" });
    expect(work.readOperationCommand({ commandId: CMD, action: "evidence", expectedRevision: 4, payload: { ...evidence, stage: "damage", note: "Škrabanec", damageResolver: "Servis" } }).payload)
      .toMatchObject({ damageResolver: "Servis" });
  });
  it("commands only own work, replays by id and explains refusals", async () => {
    const receipt = { commandId: CMD, committedRevision: 5, operation: operation({ revision: 5, customer: undefined }) };
    rpcs({ motorist_operations_workspace: () => workspace([operation({ revision: 5 })]), motorist_operations_command: () => receipt });
    const result = await work.commandFieldOperation(actor, OP, { commandId: CMD, action: "start", expectedRevision: 4, payload: {} });
    expect(result).toMatchObject({ commandId: CMD, committedRevision: 5, operation: { revision: 5, customer: { name: "Ján Klient" } } });
    expect(mocks.rpc).toHaveBeenCalledWith("motorist_operations_command", { p_user_id: USER, p_organization_id: ORG, p_command: { commandId: CMD, action: "start", expectedRevision: 4, operationId: OP, payload: {} } });
    rpcs({ motorist_operations_workspace: () => workspace([]) });
    await expect(work.commandFieldOperation(actor, OP, { commandId: CMD, action: "start", expectedRevision: 4, payload: {} })).rejects.toMatchObject({ status: 404 });
    rpcs({ motorist_operations_workspace: () => workspace([operation()]), motorist_operations_command: () => { throw { code: "PT409", message: "Capacity conflict" }; } });
    await expect(work.commandFieldOperation(actor, OP, { commandId: CMD, action: "start", expectedRevision: 4, payload: {} })).rejects.toMatchObject({ status: 409, message: expect.stringContaining("inú potvrdenú jazdu") });
    await expect(work.commandFieldOperation({ ...actor, capabilities: ["drive"] }, OP, { commandId: CMD, action: "start", expectedRevision: 4, payload: {} })).rejects.toMatchObject({ status: 403 });
    // A wrong step is a wrong status, not a lost assignment.
    rpcs({ motorist_operations_workspace: () => workspace([operation()]), motorist_operations_command: () => { throw { code: "22023", message: "Assignment required" }; } });
    await expect(work.commandFieldOperation(actor, OP, { commandId: CMD, action: "start", expectedRevision: 4, payload: {} })).rejects.toMatchObject({ status: 409 });
    // Doklady to a closed jazda go through the web, also for a member with office rights.
    mocks.rpc.mockClear();
    rpcs({ motorist_operations_workspace: () => workspace([operation({ status: "completed" })]) });
    const evidence = { stage: "handover", source: "reported", observedAt: "2026-10-28T08:00:00Z", person: "Ján", note: "", photoReference: null, odometer: null, fuel: null, missingReason: "Bez dokladu" };
    await expect(work.commandFieldOperation(actor, OP, { commandId: CMD, action: "evidence", expectedRevision: 4, payload: evidence })).rejects.toMatchObject({ status: 403 });
    expect(mocks.rpc).not.toHaveBeenCalledWith("motorist_operations_command", expect.anything());
  });
  it("sends delivery completion once without a synthetic arrival and explains missing evidence", async () => {
    rpcs({ motorist_operations_workspace: () => workspace([operation({ kind: "delivery", status: "en_route" })]),
      motorist_operations_command: () => { throw { code: "22023", message: "Handover evidence required" }; } });
    await expect(work.commandFieldOperation(actor, OP, { commandId: CMD, action: "complete", expectedRevision: 4, payload: {} }))
      .rejects.toMatchObject({ status: 400, code: "work_refused", message: expect.stringContaining("doklad odovzdania") });
    const writes = mocks.rpc.mock.calls.filter(([name]) => name === "motorist_operations_command");
    expect(writes).toHaveLength(1);
    expect(writes[0][1].p_command).toMatchObject({ action: "complete", expectedRevision: 4 });
  });
  it("records positions through the operation RPC only", async () => {
    rpcs({ motorist_operation_position: () => ({ stored: true, active: true }) });
    const reading = { lat: 48.1, lng: 17.1, accuracy: 5, recordedAt: "2026-10-28T08:00:00Z" };
    await expect(work.recordOperationPosition(actor, OP, reading)).resolves.toEqual({ stored: true, active: true });
    expect(mocks.rpc).toHaveBeenLastCalledWith("motorist_operation_position", { p_user_id: USER, p_organization_id: ORG, p_operation_id: OP, p_input: { ...reading, recordedAt: "2026-10-28T08:00:00.000Z" } });
    rpcs({});
    await expect(work.recordOperationPosition(actor, OP, reading)).rejects.toMatchObject({ status: 503, code: "work_position_unavailable" });
    await expect(work.recordOperationPosition(actor, OP, { ...reading, lat: 300 })).rejects.toMatchObject({ status: 400 });
  });
  it("issues a background secret whose hash alone reaches the database, and revokes it", async () => {
    const expiresAt = "2026-11-05T08:00:00.000Z";
    rpcs({ motorist_operation_tracker: args => args.p_action === "issue" ? { expiresAt } : { revoked: true } });
    const issued = await work.issueOperationTracker(actor, OP.toUpperCase());
    expect(issued).toEqual({ token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt });
    expect(mocks.rpc).toHaveBeenLastCalledWith("motorist_operation_tracker", { p_user_id: USER, p_organization_id: ORG, p_operation_id: OP, p_action: "issue", p_token_hash: trackerHash(issued.token) });
    await expect(work.revokeOperationTracker(actor, OP)).resolves.toEqual({ revoked: true });
    expect(mocks.rpc).toHaveBeenLastCalledWith("motorist_operation_tracker", { p_user_id: USER, p_organization_id: ORG, p_operation_id: OP, p_action: "revoke", p_token_hash: null });
    await expect(work.issueOperationTracker({ ...actor, capabilities: ["drive"] }, OP)).rejects.toMatchObject({ status: 403 });
    await expect(work.issueOperationTracker(actor, "x")).rejects.toMatchObject({ status: 404 });
  });
  it("maps refusals of the background secret; an older database keeps the open app sending", async () => {
    const refuse = (error: Record<string, unknown>) => rpcs({ motorist_operation_tracker: () => { throw error; } });
    rpcs({});
    await expect(work.issueOperationTracker(actor, OP)).rejects.toMatchObject({ status: 503, code: "work_background_unavailable" });
    refuse({ code: "PT409", message: "Not tracking" });
    await expect(work.issueOperationTracker(actor, OP)).rejects.toMatchObject({ status: 409, code: "work_not_tracking" });
    refuse({ code: "P0002", message: "Operation unavailable" });
    await expect(work.issueOperationTracker(actor, OP)).rejects.toMatchObject({ status: 404 });
    refuse({ code: "42501", message: "Forbidden" });
    await expect(work.revokeOperationTracker(actor, OP)).rejects.toMatchObject({ status: 403 });
    rpcs({ motorist_operation_tracker: () => ({ expiresAt: "soon" }) });
    await expect(work.issueOperationTracker(actor, OP)).rejects.toMatchObject({ status: 503, code: "work_unconfirmed" });
  });
  it("takes background batches by the operation secret alone and says when to stop", async () => {
    const token = "c".repeat(43), positions = [{ lat: 49.2, lng: 18.7, accuracy: null, recordedAt: "2026-10-28T08:00:00Z" }];
    rpcs({ motorist_operation_track: () => ({ stored: 1, active: true }) });
    await expect(work.trackOperationPositions(token, { positions })).resolves.toEqual({ stored: 1, active: true });
    expect(mocks.rpc).toHaveBeenLastCalledWith("motorist_operation_track", { p_token_hash: trackerHash(token), p_positions: [{ ...positions[0], recordedAt: "2026-10-28T08:00:00.000Z" }] });
    for (const bad of [{}, { positions: [] }, { positions: Array.from({ length: 101 }, () => positions[0]) }, { positions: [{ ...positions[0], lat: 91 }] }, { positions, extra: 1 }]) {
      await expect(work.trackOperationPositions(token, bad)).rejects.toMatchObject({ status: 400 });
    }
    rpcs({});
    await expect(work.trackOperationPositions(token, { positions })).rejects.toMatchObject({ status: 503, code: "work_position_unavailable" });
    rpcs({ motorist_operation_track: () => ({ stored: "1", active: true }) });
    await expect(work.trackOperationPositions(token, { positions })).rejects.toMatchObject({ status: 503 });
  });
  it("answers the background route without a session, only with the secret", async () => {
    const send = (headers: Record<string, string>) => trackRoute(new Request("https://x/api/mobile/v1/field/operations/track", { method: "POST",
      headers: { "content-type": "application/json", "x-pm-app-environment": "test", ...headers }, body: JSON.stringify({ positions: [{ lat: 49.2, lng: 18.7, accuracy: 5, recordedAt: "2026-10-28T08:00:00Z" }] }) }));
    expect((await send({})).status).toBe(401);
    expect((await send({ authorization: "Bearer " + "b".repeat(43) })).status).toBe(401);
    for (const [key, value] of Object.entries(stableTest)) vi.stubEnv(key, value);
    rpcs({ motorist_operation_track: () => ({ stored: 0, active: false }) });
    const response = await send({ authorization: "Tracker " + "b".repeat(43) });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ ok: true, apiVersion: 1, environment: "test", stored: 0, active: false });
    expect(mocks.rpc).not.toHaveBeenCalledWith("motorist_towing_actor", expect.anything());
    expect((await send({ authorization: "Tracker " + "b".repeat(43), "x-pm-app-environment": "production" })).status).toBe(409);
    vi.stubEnv("MOBILE_DELIVERY_ENABLED", "");
    expect((await send({ authorization: "Tracker " + "b".repeat(43) })).status).toBe(503);
  });
  it("issues the secret over the member route with the field scope", async () => {
    for (const [key, value] of Object.entries(stableTest)) vi.stubEnv(key, value);
    rpcs({ motorist_operation_tracker: args => args.p_action === "issue" ? { expiresAt: "2026-11-05T08:00:00.000Z" } : { revoked: true } });
    const issued = await trackerRoute(bearer({}), { params: Promise.resolve({ id: OP }) });
    expect(await issued.json()).toMatchObject({ ok: true, apiVersion: 1, environment: "test", memberId: MEMBER, token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expiresAt: "2026-11-05T08:00:00.000Z" });
    const revoked = await untrackRoute(new Request("https://app.test/api", { method: "DELETE", headers: { authorization: "Bearer x" } }), { params: Promise.resolve({ id: OP }) });
    expect(await revoked.json()).toMatchObject({ ok: true, memberId: MEMBER, revoked: true });
  });
});

describe("Moja práca: towing", () => {
  it("reads towing times the RPC writes as Postgres text", () => {
    expect(work.towingTime("2026-10-28 08:00:00.123456+00")).toBe("2026-10-28T08:00:00.123Z");
    expect(work.towingTime("2026-10-28 10:00:00+02")).toBe("2026-10-28T08:00:00.000Z");
    expect(work.towingTime("2026-10-28T08:00:00Z")).toBe("2026-10-28T08:00:00.000Z");
    expect(work.towingTime("2026-10-28T10:00")).toBeNull();
    expect(work.towingTime("zajtra")).toBeNull();
    const started = work.projectTowingOrder(towingOrder({}, { startedAt: "2026-10-28 08:00:00.123456+00" }), MEMBER);
    expect(started.fields.startedAt).toBe("2026-10-28T08:00:00.123Z");
  });
  it("projects only own receipts and the authorized collection amounts", () => {
    const own = { id: id(80), receiptId: id(81), amountCents: 2500, method: "card", driverId: MEMBER, createdAt: at };
    const order = work.projectTowingOrder(towingOrder({ payments: [own, { ...own, id: id(82), driverId: OTHER }] }), MEMBER);
    expect(order).toMatchObject({ authorizedCollectionCents: 15000, dueCents: 15000, payments: [{ id: id(80), receiptId: id(81), amountCents: 2500, method: "card" }] });
    expect(order.payments).toHaveLength(1);
    expect(JSON.stringify(order)).not.toContain(OTHER);
    expect(order).not.toHaveProperty("receivedCents");
  });
  it("accepts exact cash/card receipts only, with current assignment and cash account revision", async () => {
    const body = { commandId: CMD, type: "receive_payment", expectedRevision: 7, assignmentGeneration: 2, payload: { receiptId: id(83), amountCents: 1234, method: "cash", accountRevision: 3 } };
    expect(work.readTowingCommand(body)).toEqual(body);
    expect(work.readTowingCommand({ ...body, payload: { receiptId: id(83), amountCents: 1234, method: "card" } })).toMatchObject({ payload: { method: "card" } });
    for (const payload of [{ ...body.payload, method: "bank" }, { ...body.payload, amountCents: 12.34 }, { ...body.payload, amountCents: 0 }, { ...body.payload, accountRevision: undefined }, { ...body.payload, driverId: OTHER }]) {
      expect(() => work.readTowingCommand({ ...body, payload })).toThrow();
    }
    rpcs({ motorist_towing_command: () => { throw { code: "42501", message: "Towing access denied" }; } });
    await expect(work.commandFieldTowing(actor, ORDER, body)).rejects.toMatchObject({ status: 403 });
  });
  it("validates realized items and keeps payment intent independent from receipts", () => {
    const fields = { paymentIntent: "cash_other", owner: { name: "Ján", address: "Adresa", companyId: "123" }, odometer: "123456", realizedItems: [
      { id: id(84), kind: "tow", description: "Odťah", quantity: "12.5", unit: "km", destination: "Servis" },
      { id: id(85), kind: "repair", description: "Oprava", quantity: "1", unit: "ks" },
    ] };
    const command = work.readTowingCommand({ commandId: CMD, type: "update_order", expectedRevision: 7, assignmentGeneration: 2, payload: { fields } });
    expect(command.payload).toEqual({ fields });
    expect(command.type).toBe("update_order");
    for (const patch of [{ realizedItems: [fields.realizedItems[0], fields.realizedItems[0]] }, { owner: { name: "Ján", taxId: "private" } }, { paymentIntent: "paid" }, { authorizedCollectionCents: 1 }]) {
      expect(() => work.readTowingCommand({ ...command, payload: { fields: { ...fields, ...patch } } })).toThrow();
    }
  });
  it("shows dispatch instructions as read-only work context", () => {
    expect(work.projectTowingOrder(towingOrder({}, { dispatchInstructions: "Kľúče na recepcii" }), MEMBER).fields).toMatchObject({ dispatchInstructions: "Kľúče na recepcii" });
    expect(() => work.readTowingCommand({ commandId: CMD, type: "update_order", expectedRevision: 7, assignmentGeneration: 2, payload: { fields: { dispatchInstructions: "Zmena" } } })).toThrow();
  });
  it("projects own operational contacts without office finance or another driver's order", () => {
    const order = work.projectTowingOrder(towingOrder(), MEMBER);
    expect(order).toMatchObject({ id: ORDER, number: "OT-2026-0005", revision: 7, assignmentGeneration: 2, workStatus: "in_progress",
      fields: { requesterName: "Asistencia s.r.o.", requester: { name: "Asistencia s.r.o.", phone: "+421" }, pickup: "D1 km 120", destination: "Servis Žilina", customer: { name: "Mária", phone: "+421900333444" }, startSource: "manual" } });
    expect(order.attachments.map(item => item.id)).toEqual([id(40)]);
    const json = JSON.stringify(order);
    for (const secret of ["receivedCents", "reconciliationRequired", "billing", "officeNotes", "taxId"]) expect(json).not.toContain(secret);
    expect(() => work.projectTowingOrder(towingOrder({ driverId: OTHER }), MEMBER)).toThrow();
    expect(() => work.projectTowingOrder(towingOrder({ workStatus: "submitted" }), MEMBER)).toThrow();
  });
  it("accepts complete operational fields but denies office fields and missing own assignment", () => {
    const base = { commandId: CMD, type: "update_order", expectedRevision: 7, assignmentGeneration: 2 };
    expect(work.readTowingCommand({ ...base, payload: { fields: { finishedAt: "2026-10-28T09:00:00Z", driverNotes: " hotovo ", photoException: "" } } }).payload)
      .toEqual({ fields: { finishedAt: "2026-10-28T09:00:00Z", driverNotes: "hotovo", photoException: null } });
    expect(work.readTowingCommand({ ...base, payload: { fields: { pickup: " iné ", contact: "+421900111222", branchId: id(90), requester: { name: "Partner", email: "contact@example.invalid" } } } }).payload)
      .toEqual({ fields: { pickup: "iné", contact: "+421900111222", branchId: id(90), requester: { name: "Partner", email: "contact@example.invalid" } } });
    for (const fields of [{ officeNotes: "Private" }, { authorizedCollectionCents: 1000 }, { customer: { name: "Billing identity" } }, { requester: { name: "Partner", taxId: "Private" } }, { branchId: OTHER + "/other" }]) {
      expect(() => work.readTowingCommand({ ...base, payload: { fields } })).toThrow();
    }
    expect(() => work.readTowingCommand({ ...base, payload: { fields: { startedAt: "2026-10-28T10:00:00Z", finishedAt: "2026-10-28T09:00:00Z" } } })).toThrow();
    expect(() => work.readTowingCommand({ ...base, type: "receive_payment", payload: {} })).toThrow();
    expect(() => work.readTowingCommand({ ...base, type: "submit", assignmentGeneration: undefined, payload: {} })).toThrow();
    expect(work.readTowingCommand({ ...base, type: "submit", payload: {} })).toEqual({ ...base, type: "submit", payload: {} });
    // An own unfinished upload can be abandoned, with its reason.
    expect(work.readTowingCommand({ ...base, type: "abandon_attachment", payload: { id: id(40).toUpperCase(), reason: " Nedokončené " } }).payload).toEqual({ id: id(40), reason: "Nedokončené" });
    expect(() => work.readTowingCommand({ ...base, type: "abandon_attachment", payload: { id: id(40) } })).toThrow();
    expect(() => work.readTowingCommand({ ...base, type: "abandon_attachment", payload: { id: id(40), reason: "x", extra: 1 } })).toThrow();
  });
  it("sends driver commands with the assignment generation and explains refusals", async () => {
    rpcs({ motorist_towing_command: () => ({ commandId: CMD, targetId: ORDER, revision: 8 }), motorist_towing_workspace: () => ({ view: "driver", orders: [towingOrder({ revision: 8 })], members: [] }) });
    await expect(work.commandFieldTowing(actor, ORDER, { commandId: CMD, type: "start", expectedRevision: 7, assignmentGeneration: 2, payload: {} }))
      .resolves.toMatchObject({ commandId: CMD, revision: 8, order: { revision: 8 } });
    expect(mocks.rpc).toHaveBeenCalledWith("motorist_towing_command", { p_user_id: USER, p_organization_id: ORG, p_membership_version: 3,
      p_command: { commandId: CMD, type: "start", targetId: ORDER, expectedRevision: 7, assignmentGeneration: 2, payload: {} } });
    // A failed read after the step is not "left the list": the step is confirmed again (it replays).
    rpcs({ motorist_towing_command: () => ({ commandId: CMD, targetId: ORDER, revision: 8 }), motorist_towing_workspace: () => { throw { code: "XX000" }; } });
    await expect(work.commandFieldTowing(actor, ORDER, { commandId: CMD, type: "start", expectedRevision: 7, assignmentGeneration: 2, payload: {} })).rejects.toMatchObject({ status: 503 });
    rpcs({ motorist_towing_command: () => ({ commandId: CMD, targetId: ORDER, revision: 8 }), motorist_towing_workspace: () => ({ view: "driver", orders: [], members: [] }) });
    await expect(work.commandFieldTowing(actor, ORDER, { commandId: CMD, type: "submit", expectedRevision: 7, assignmentGeneration: 2, payload: {} })).resolves.toMatchObject({ order: null });
    rpcs({ motorist_towing_command: () => { throw { code: "22023", message: "Photographs required" }; } });
    await expect(work.commandFieldTowing(actor, ORDER, { commandId: CMD, type: "submit", expectedRevision: 7, assignmentGeneration: 2, payload: {} }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining("fotografiu práce") });
    vi.stubEnv("MOTORIST_TOWING_ENABLED", "");
    await expect(work.readFieldTowing(actor, ORDER)).rejects.toMatchObject({ status: 503, code: "towing_unavailable" });
    expect(await work.loadFieldTowing(actor)).toBeNull();
  });
});

describe("own mobile cash", () => {
  const account = { id: id(90), driverId: MEMBER, balanceCents: 15000, reservedCents: 5000, revision: 3 };
  const handover = { id: id(91), driverId: MEMBER, amountCents: 5000, status: "pending", revision: 1, createdAt: at };
  it("filters other members and office accounts even for a dual-role actor", async () => {
    rpcs({ motorist_towing_workspace: () => ({ view: "driver", orders: [], cashAccounts: [account, { ...account, id: id(92), driverId: null }, { ...account, id: id(93), driverId: OTHER }], handovers: [handover, { ...handover, id: id(94), driverId: OTHER }] }) });
    const result = await work.loadFieldCash({ ...actor, capabilities: [...actor.capabilities, "cash"] });
    expect(result.account).toEqual({ id: account.id, balanceCents: 15000, reservedCents: 5000, revision: 3 });
    expect(result.handovers).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(OTHER);
    await expect(work.loadFieldCash({ ...actor, capabilities: ["deliver"] })).rejects.toMatchObject({ status: 403 });
  });
  it("proposes only own handovers using stable IDs and exact account revision", async () => {
    const command = { commandId: CMD, handoverId: handover.id, type: "propose_handover", expectedRevision: 0, payload: { amountCents: 5000, accountRevision: 3 } };
    rpcs({ motorist_towing_command: () => ({ commandId: CMD, targetId: handover.id, revision: 1 }), motorist_towing_workspace: () => ({ view: "driver", orders: [], cashAccounts: [account], handovers: [handover] }) });
    await expect(work.commandFieldCash(actor, command)).resolves.toMatchObject({ commandId: CMD, revision: 1, cash: { account: { revision: 3 } } });
    expect(mocks.rpc).toHaveBeenCalledWith("motorist_towing_command", expect.objectContaining({ p_command: { commandId: CMD, type: "propose_handover", targetId: handover.id, expectedRevision: 0, payload: command.payload } }));
    for (const bad of [{ ...command, payload: { ...command.payload, driverId: OTHER } }, { ...command, type: "accept_handover" }, { ...command, payload: { ...command.payload, amountCents: 50.1 } }]) expect(() => work.readCashCommand(bad)).toThrow();
  });
});

describe("field work routes", () => {
  it("needs deliver or drive, and one failing source does not hide the other", async () => {
    rpcs({ motorist_operations_workspace: () => workspace([operation()]), motorist_towing_workspace: () => { throw { code: "XX000" }; } });
    const response = await workRoute(bearer());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, memberId: MEMBER, towing: null, unavailable: ["towing"] });
    expect(body.operations).toHaveLength(1);
    mocks.rpc.mockImplementation(async (name: string) => name === "motorist_towing_actor" ? { data: { ...member, capabilities: [], roles: ["branch"] }, error: null } : { data: null, error: null });
    expect((await workRoute(bearer())).status).toBe(403);
  });
  it("answers command refusals as mobile errors", async () => {
    rpcs({ motorist_operations_workspace: () => workspace([operation()]) });
    const response = await commandRoute(bearer({ commandId: CMD, action: "assign", expectedRevision: 4, payload: {} }), { params: Promise.resolve({ id: OP }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
  });
});
