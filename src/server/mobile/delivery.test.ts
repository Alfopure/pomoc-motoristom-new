import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { MobileHandoffInput } from "@/lib/mobile-api";
import { MutationError } from "@/server/mutation-error";

const mocks = vi.hoisted(() => ({ user: vi.fn(), dispatcher: vi.fn(), rpc: vi.fn(), queue: vi.fn(), memberPush: vi.fn() }));
vi.mock("./auth", () => ({ mobileEnvironment: () => "test", verifyMobileUser: mocks.user, requireMobileActor: mocks.dispatcher }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("./push", () => ({ queueMobilePush: mocks.queue, sendMemberPush: mocks.memberPush }));

const { requireMobileFieldActor, requireMobilePerson, mobileDeliveryEnabled } = await import("./field-auth");
const { commandDelivery, loadDeliveries, parseDelivery, readDelivery, recordDeliveryPosition } = await import("./delivery");
const { commandMobileCaseHandoff, getMobileCaseHandoffs, parseMobileHandoffInput } = await import("./case-handoff");
const { GET: deliveriesRoute } = await import("@/app/api/mobile/v1/field/deliveries/route");

const id = (n: number) => `92000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ORG = id(1), USER = id(2), MEMBER = id(3), CASE = id(4), GRANT = id(5), COMMAND = id(6), DISPATCHER = id(7);
const at = "2026-10-22T08:00:00.000000+00:00", later = "2099-01-01T00:00:00.000000+00:00";
const member = { id: MEMBER, userId: USER, organizationId: ORG, displayName: "Pavol", email: "pavol@example.test", active: true, version: 3, capabilities: ["deliver"], roles: ["delivery"] };
const card = { caseNumber: "PM-2026-0042", action: "Pristavenie náhradného vozidla", contact: { name: "Ján Klient", phone: "+421905111222" },
  vehicle: { make: "Škoda", model: "Fabia", plate: "ZA123AB", color: "", driveable: null, conditionFlags: [] }, pickup: { address: "Žilina", lat: 49.2, lng: 18.7 }, destination: null,
  instructions: "Kľúče na vrátnici", scheduledAt: null, schemaVersion: 3, assistance: { name: "", reference: "" },
  replacement: { needed: true, category: "", requestedType: "", preferences: [], status: "assigned", deliveryPlace: "Hlavná 1, Žilina", vehicle: { make: "VW", model: "Golf", plate: "ZA999AB" } },
  incident: { description: "", passengersCount: null, access: "" }, caseCreatedAt: at, firstCallAt: null };
function view(overrides: Record<string, unknown> = {}) {
  return { id: GRANT, status: "offered", revision: 1, publishedVersion: 1, recipientName: "Pavol", expiresAt: later, createdAt: at, openedAt: at, eta: null, createdBy: "Jana", publishedAt: at,
    published: card, events: [{ id: id(8), action: "app", comment: "Pavol", actor: "Dispečing", createdAt: at }], caseNumber: "PM-2026-0042",
    replacementPosition: { lat: 49.21, lng: 18.74, recordedAt: at }, ...overrides };
}
const actor = { userId: USER, memberId: MEMBER, organizationId: ORG, displayName: "Pavol", email: null, version: 3 };
const stableTest = { MOBILE_DELIVERY_ENABLED: "true", MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev", VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk",
  APP_BASE_URL: "https://test.dispecing.linkapomoci.sk", SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MOBILE_DELIVERY_ENABLED", "true");
  mocks.user.mockResolvedValue({ userId: USER, email: undefined, organizationId: ORG, expectedOrganization: null });
  mocks.rpc.mockResolvedValue({ data: member, error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("pristavovač identity", () => {
  it("is off unless switched on, and never on a working-branch Preview", () => {
    expect(mobileDeliveryEnabled({})).toBe(false);
    expect(mobileDeliveryEnabled(stableTest)).toBe(true);
    expect(mobileDeliveryEnabled({ ...stableTest, VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "feature" })).toBe(false);
  });

  it("needs an active field membership of this organization with the delivery capability", async () => {
    await expect(requireMobileFieldActor(new Request("https://x"))).resolves.toEqual({ userId: USER, memberId: MEMBER, organizationId: ORG, displayName: "Pavol", email: "pavol@example.test", version: 3 });
    expect(mocks.rpc).toHaveBeenCalledWith("motorist_towing_actor", { p_user_id: USER });
    for (const patch of [{ capabilities: ["drive"] }, { active: false }, { organizationId: id(99) }, { userId: id(98) }]) {
      mocks.rpc.mockResolvedValueOnce({ data: { ...member, ...patch }, error: null });
      await expect(requireMobileFieldActor(new Request("https://x"))).rejects.toMatchObject({ status: 403, code: "mobile_no_field_access" });
    }
    mocks.rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(requireMobileFieldActor(new Request("https://x"))).rejects.toMatchObject({ status: 403 });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202" } });
    await expect(requireMobileFieldActor(new Request("https://x"))).rejects.toMatchObject({ status: 503, code: "delivery_unavailable" });
    vi.stubEnv("MOBILE_DELIVERY_ENABLED", "");
    await expect(requireMobileFieldActor(new Request("https://x"))).rejects.toMatchObject({ status: 503, code: "delivery_unavailable" });
  });

  it("tries the pristavovač only for a signed-in user without a dispatch profile", async () => {
    mocks.dispatcher.mockRejectedValueOnce(new MutationError("x", 403, "mobile_no_dispatch_profile"));
    await expect(requireMobilePerson(new Request("https://x"))).resolves.toMatchObject({ kind: "field", actor: { memberId: MEMBER } });
    mocks.dispatcher.mockRejectedValueOnce(new MutationError("expired", 401));
    await expect(requireMobilePerson(new Request("https://x"))).rejects.toMatchObject({ status: 401 });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});

describe("pristavovač deliveries", () => {
  it("shows the card while open and translates the history for older apps", () => {
    const parsed = parseDelivery(view());
    expect(parsed).toMatchObject({ id: GRANT, caseNumber: "PM-2026-0042", card: { replacement: { deliveryPlace: "Hlavná 1, Žilina" } }, replacementPosition: { lat: 49.21, lng: 18.74 } });
    expect(parsed.events[0]).toMatchObject({ action: "update", comment: "Odoslané do aplikácie: Pavol" });
    expect(parseDelivery(view({ status: "completed", published: null, events: [], replacementPosition: null })).card).toBeNull();
    for (const patch of [{ extra: 1 }, { status: "other" }, { revision: 0 }, { caseNumber: 7 }, { expiresAt: "soon" }]) expect(() => parseDelivery(view(patch))).toThrow();
  });

  it("lists and reads through the membership-checked function only", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { handoffs: [view()] }, error: null });
    await expect(loadDeliveries(actor)).resolves.toHaveLength(1);
    expect(mocks.rpc).toHaveBeenLastCalledWith("motorist_member_handoff", { p_user_id: USER, p_organization_id: ORG, p_membership_version: 3, p_action: "list", p_input: {} });
    mocks.rpc.mockResolvedValueOnce({ data: { handoff: view() }, error: null });
    await expect(readDelivery(actor, GRANT.toUpperCase())).resolves.toMatchObject({ id: GRANT });
    expect(mocks.rpc).toHaveBeenLastCalledWith("motorist_member_handoff", expect.objectContaining({ p_action: "read", p_input: { handoffId: GRANT } }));
    await expect(readDelivery(actor, "nope")).rejects.toMatchObject({ status: 404 });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0002" } });
    await expect(readDelivery(actor, GRANT)).rejects.toMatchObject({ status: 404 });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "42501" } });
    await expect(loadDeliveries(actor)).rejects.toMatchObject({ status: 403 });
  });

  it("checks a step like the link page and confirms its receipt", async () => {
    const step = { commandId: COMMAND, action: "accept", expectedRevision: 1, publishedVersion: 1 };
    mocks.rpc.mockResolvedValueOnce({ data: { handoff: view({ status: "accepted", revision: 2 }), commandId: COMMAND, committedRevision: 2 }, error: null });
    await expect(commandDelivery(actor, GRANT, step)).resolves.toMatchObject({ commandId: COMMAND, committedRevision: 2, delivery: { status: "accepted" } });
    expect(mocks.rpc).toHaveBeenLastCalledWith("motorist_member_handoff", expect.objectContaining({ p_action: "command", p_input: expect.objectContaining({ handoffId: GRANT, action: "accept", commandId: COMMAND }) }));
    await expect(commandDelivery(actor, GRANT, { ...step, action: "reject" })).rejects.toMatchObject({ status: 400 });
    await expect(commandDelivery(actor, GRANT, { ...step, action: "issue" })).rejects.toMatchObject({ status: 400 });
    await expect(commandDelivery(actor, GRANT, { ...step, extra: true })).rejects.toMatchObject({ status: 400 });
    mocks.rpc.mockResolvedValueOnce({ data: { handoff: view({ status: "accepted", revision: 2 }), commandId: id(77), committedRevision: 2 }, error: null });
    await expect(commandDelivery(actor, GRANT, step)).rejects.toMatchObject({ status: 503 });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "PT409" } });
    await expect(commandDelivery(actor, GRANT, step)).rejects.toMatchObject({ status: 409 });
  });

  it("sends a bounded position and reports whether it was kept", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { stored: true }, error: null });
    await expect(recordDeliveryPosition(actor, GRANT, { lat: 49.2, lng: 18.7, accuracy: 12, recordedAt: at })).resolves.toEqual({ stored: true });
    expect(mocks.rpc).toHaveBeenLastCalledWith("motorist_member_handoff", expect.objectContaining({ p_action: "position", p_input: { handoffId: GRANT, lat: 49.2, lng: 18.7, accuracy: 12, recordedAt: "2026-10-22T08:00:00.000Z" } }));
    for (const bad of [{ lat: 91, lng: 0, accuracy: null, recordedAt: at }, { lat: 1, lng: 0, accuracy: -1, recordedAt: at }, { lat: 1, lng: 0, accuracy: null, recordedAt: "now" }, { lat: 1, lng: 0, accuracy: null, recordedAt: at, speed: 3 }]) {
      await expect(recordDeliveryPosition(actor, GRANT, bad)).rejects.toMatchObject({ status: 400 });
    }
  });

  it("answers the route only for a signed-in pristavovač", async () => {
    mocks.user.mockRejectedValueOnce(new MutationError("Prihláste sa do aplikácie.", 401));
    const denied = await deliveriesRoute(new Request("https://x/api/mobile/v1/field/deliveries"));
    expect(denied.status).toBe(401);
    mocks.rpc.mockResolvedValueOnce({ data: member, error: null }).mockResolvedValueOnce({ data: { handoffs: [] }, error: null });
    const ok = await deliveriesRoute(new Request("https://x/api/mobile/v1/field/deliveries"));
    expect(ok.headers.get("cache-control")).toContain("no-store");
    expect(await ok.json()).toMatchObject({ ok: true, apiVersion: 1, environment: "test", memberId: MEMBER, deliveries: [] });
  });
});

describe("dispatcher sends to the app", () => {
  const dispatcher = { userId: id(20), profileId: DISPATCHER, organizationId: ORG, displayName: "Jana", role: "dispatcher" as const };
  const grant = (overrides: Record<string, unknown> = {}) => ({ id: GRANT, status: "offered", revision: 1, publishedVersion: 1, recipientName: "Pavol", recipientPhone: "+421905000111",
    expiresAt: later, createdAt: at, openedAt: null, eta: null, createdBy: "Jana", publishedAt: at, canRenew: true, recoverable: false, tokenGeneration: 1,
    published: card, events: [], recipientMemberId: null, ...overrides });
  function session(handler: (name: string, args: Record<string, unknown>) => unknown) {
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => handler(name, args));
    return { rpc, session: { actor: dispatcher, client: { rpc } as unknown as SupabaseClient<Database> } };
  }
  const issue = { action: "issue", commandId: COMMAND, recipientName: "Pavol", recipientPhone: "+421905000111", previewVersion: "a".repeat(64), hours: 24, recipientMemberId: MEMBER } as MobileHandoffInput;
  beforeEach(() => {
    // The dedicated stable TEST deployment, where deliveries may run.
    vi.stubEnv("MOTORIST_HANDOFF_V3_ENABLED", "false");
    for (const [key, value] of Object.entries(stableTest)) vi.stubEnv(key, value);
  });

  it("accepts a pristavovač on issue and a separate send", () => {
    expect(parseMobileHandoffInput(issue)).toMatchObject({ action: "issue", recipientMemberId: MEMBER });
    expect(parseMobileHandoffInput({ action: "deliver", commandId: COMMAND, handoffId: GRANT, expectedRevision: 1, recipientMemberId: MEMBER.toUpperCase() }))
      .toEqual({ action: "deliver", commandId: COMMAND, handoffId: GRANT, expectedRevision: 1, recipientMemberId: MEMBER });
    expect(() => parseMobileHandoffInput({ ...issue, recipientMemberId: "pavol" })).toThrow();
    expect(() => parseMobileHandoffInput({ action: "deliver", commandId: COMMAND, handoffId: GRANT, expectedRevision: 1 })).toThrow();
  });

  it("issues, sends to the app once and notifies the pristavovač's phone", async () => {
    const { rpc, session: s } = session(name => name === "motorist_case_handoff"
      ? { data: { handoff: grant(), commandId: COMMAND, committedRevision: 1, tokenAccepted: false }, error: null }
      : { data: { handoff: grant({ recipientMemberId: MEMBER }), assigned: true, memberId: MEMBER }, error: null });
    const result = await commandMobileCaseHandoff(s, new Request("https://test.dispecing.linkapomoci.sk"), CASE, issue);
    expect(result).toMatchObject({ kind: "mutation", delivery: { status: "sent", memberId: MEMBER } });
    expect(rpc).toHaveBeenCalledWith("motorist_case_handoff_app", expect.objectContaining({ p_action: "assign", p_input: { handoffId: GRANT, memberId: MEMBER, commandId: COMMAND } }));
    expect(rpc.mock.calls.find(([name]) => name === "motorist_case_handoff")?.[1].p_input).not.toHaveProperty("recipientMemberId");
    expect(mocks.queue).toHaveBeenCalledOnce();
    await mocks.queue.mock.calls[0][0]();
    expect(mocks.memberPush).toHaveBeenCalledWith(expect.anything(), { organizationId: ORG, memberIds: [MEMBER], title: "Nové pristavenie",
      body: "Prípad PM-2026-0042: Pristavenie náhradného vozidla.", data: { kind: "delivery", id: GRANT } });
    expect(JSON.stringify(mocks.memberPush.mock.calls[0][1])).not.toMatch(/Ján|905111222|ZA123AB/);
  });

  it("keeps the handoff when the app send fails and does not notify a repeated send", async () => {
    const { session: s } = session(name => name === "motorist_case_handoff"
      ? { data: { handoff: grant(), commandId: COMMAND, committedRevision: 1, tokenAccepted: false }, error: null }
      : { data: null, error: { code: "22023" } });
    await expect(commandMobileCaseHandoff(s, new Request("https://test.dispecing.linkapomoci.sk"), CASE, issue)).resolves.toMatchObject({ kind: "mutation", delivery: { status: "failed" } });
    const repeated = session(() => ({ data: { handoff: grant({ recipientMemberId: MEMBER }), assigned: false, memberId: MEMBER }, error: null }));
    await expect(commandMobileCaseHandoff(repeated.session, new Request("https://x"), CASE, { action: "deliver", commandId: COMMAND, handoffId: GRANT, expectedRevision: 1, recipientMemberId: MEMBER }))
      .resolves.toEqual({ kind: "delivery", caseId: CASE, handoffId: GRANT, commandId: COMMAND, memberId: MEMBER, sent: true, currentRevision: 1 });
    expect(mocks.queue).not.toHaveBeenCalled();
    const taken = session(() => ({ data: null, error: { code: "PT409" } }));
    await expect(commandMobileCaseHandoff(taken.session, new Request("https://x"), CASE, { action: "deliver", commandId: COMMAND, handoffId: GRANT, expectedRevision: 1, recipientMemberId: MEMBER }))
      .rejects.toMatchObject({ status: 409, code: "delivery_taken" });
  });

  it("refuses to send where deliveries are off", async () => {
    vi.stubEnv("MOBILE_DELIVERY_ENABLED", "");
    const { rpc, session: s } = session(() => ({ data: null, error: null }));
    await expect(commandMobileCaseHandoff(s, new Request("https://x"), CASE, issue)).rejects.toMatchObject({ status: 503, code: "delivery_unavailable" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("lists pristavovači and their last position beside the handoffs", async () => {
    const { session: s } = session((name, args) => {
      if (name === "motorist_case_handoff") return { data: { preview: card, previewVersion: "a".repeat(64), handoffs: [grant({ recipientMemberId: MEMBER })], enhanced: false }, error: null };
      if (args.p_action === "members") return { data: { members: [{ id: MEMBER, displayName: "Pavol", lastPhone: "+421905000111" }] }, error: null };
      return { data: { positions: [{ handoffId: GRANT, lat: 49.3, lng: 18.8, accuracy: 15, recordedAt: at }] }, error: null };
    });
    const result = await getMobileCaseHandoffs(s, CASE);
    expect(result.delivery).toEqual({ members: [{ id: MEMBER, displayName: "Pavol", lastPhone: "+421905000111" }] });
    expect(result.handoffs[0].app).toEqual({ memberId: MEMBER, lastPosition: { lat: 49.3, lng: 18.8, accuracy: 15, recordedAt: at } });
    // Before the delivery migration the screen stays as it was.
    const old = session((name) => name === "motorist_case_handoff"
      ? { data: { preview: card, previewVersion: "a".repeat(64), handoffs: [grant()], enhanced: false }, error: null } : { data: null, error: { code: "PGRST202" } });
    const plain = await getMobileCaseHandoffs(old.session, CASE);
    expect(plain).not.toHaveProperty("delivery");
    expect(plain.handoffs[0].app).toBeNull();
  });
});
