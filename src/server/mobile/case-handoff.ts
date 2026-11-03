import "server-only";
import { handoffEventLabels, handoffStates, type HandoffPublished } from "@/domain/case-handoff";
import { MOBILE_HANDOFF_MAX_EVENTS, MOBILE_HANDOFF_MAX_GRANTS, type MobileCaseHandoffs, type MobileDeliveryMember, type MobileHandoffApp, type MobileHandoffDelivered, type MobileHandoffGrant, type MobileHandoffInput, type MobileHandoffLink, type MobileHandoffMutation, type MobileHandoffRecovered, type MobileScope } from "@/lib/mobile-api";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isHistoryTimestamp } from "@/lib/telephony/call-history-query";
import { isUuid } from "@/lib/telephony/uuid";
import { getCaseHandoffContext, prepareCaseHandoffCommand, recoverCaseHandoffLink, validateHandoffCommand, type HandoffSession, type ResolvedHandoffLink } from "@/server/case-handoff";
import { handoffOrigin } from "@/server/handoff-secret";
import { MutationError } from "@/server/mutation-error";
import { readMobileJsonBody } from "./body";
import { deliveryUnavailable, missingSchema, mobileDeliveryEnabled } from "./field-auth";
import { queueMobilePush, sendMemberPush } from "./push";

const unavailableLink = { status: "unavailable", warning: "link_unavailable" } as const;
function unconfirmed(): never { throw new MutationError("Výsledok odovzdania sa nepodarilo potvrdiť. Overte tú istú požiadavku.", 503, "HANDOFF_UNCONFIRMED"); }
function schema(): never { throw new MutationError("Mobilná aplikácia nedokáže zobraziť celý náhľad. Otvorte webovú kartu prípadu.", 503, "MOBILE_HANDOFF_SCHEMA_UNSUPPORTED"); }
function oversized(): never { throw new MutationError("Odovzdanie má príliš veľa údajov pre mobilnú aplikáciu. Otvorte webovú kartu prípadu.", 503, "MOBILE_HANDOFF_CONTEXT_TOO_LARGE"); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) schema();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) schema();
  return result;
}
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== "string" || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) schema();
}
function timestamp(value: unknown, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== "string" || value.length > 64 || !isHistoryTimestamp(value)) schema();
}
function integer(value: unknown, min = 1, max = 2_147_483_647): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) schema();
}
function choice(value: unknown, values: readonly string[]): asserts value is string {
  if (typeof value !== "string" || !values.includes(value)) schema();
}
function choices(value: unknown, allowed: readonly string[]): void {
  if (!Array.isArray(value) || value.length > allowed.length || new Set(value).size !== value.length) schema();
  value.forEach(item => choice(item, allowed));
}
function vehicle(value: unknown, enhanced = false): void {
  const item = record(value, ["make", "model", "plate", ...(enhanced ? ["color", "driveable", "conditionFlags"] : [])]);
  text(item.make, 160);
  text(item.model, 160);
  text(item.plate, 80);
  if (enhanced) {
    text(item.color, 160);
    if (item.driveable !== null && typeof item.driveable !== "boolean") schema();
    choices(item.conditionFlags, ["immobile", "locked", "no_keys", "blocked_wheel", "after_accident", "overturned", "in_ditch"]);
  }
}
function place(value: unknown): void {
  if (value === null) return;
  const item = record(value, ["address", "lat", "lng"]);
  text(item.address, 2000);
  if (item.lat !== null && (typeof item.lat !== "number" || !Number.isFinite(item.lat) || Math.abs(item.lat) > 90)) schema();
  if (item.lng !== null && (typeof item.lng !== "number" || !Number.isFinite(item.lng) || Math.abs(item.lng) > 180)) schema();
}
export function parseHandoffSnapshot(value: unknown): HandoffPublished { return snapshot(value); }
function snapshot(value: unknown): HandoffPublished {
  const version = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).schemaVersion : undefined;
  if (version !== undefined && version !== 3) schema();
  const enhanced = version === 3;
  const item = record(value, ["caseNumber", "action", "contact", "vehicle", "pickup", "destination", "instructions", "scheduledAt",
    ...(enhanced ? ["schemaVersion", "assistance", "replacement", "incident", "caseCreatedAt", "firstCallAt"] : [])]);
  text(item.caseNumber, 160);
  text(item.action, 200);
  const contact = record(item.contact, ["name", "phone"]);
  text(contact.name, 320);
  text(contact.phone, 80);
  vehicle(item.vehicle, enhanced);
  place(item.pickup);
  place(item.destination);
  if ("instructions" in item) text(item.instructions, 2000);
  if ("scheduledAt" in item) timestamp(item.scheduledAt, true);
  if (enhanced) {
    const assistance = record(item.assistance, ["name", "reference"]);
    text(assistance.name, 160);
    text(assistance.reference, 160);
    const replacement = record(item.replacement, ["needed", "category", "requestedType", "preferences", "status", "deliveryPlace", "vehicle"]);
    if (replacement.needed !== null && typeof replacement.needed !== "boolean") schema();
    choice(replacement.category, ["", "small_car", "wagon", "suv", "van"]);
    text(replacement.requestedType, 160);
    choices(replacement.preferences, ["automatic", "manual", "suv", "wagon", "van", "ev"]);
    choice(replacement.status, ["not_needed", "not_provided", "assigned", "provided", "pending"]);
    text(replacement.deliveryPlace, 500);
    if (replacement.vehicle !== null) vehicle(replacement.vehicle);
    const incident = record(item.incident, ["description", "passengersCount", "access"]);
    text(incident.description, 1000);
    text(incident.access, 500);
    if (incident.passengersCount !== null) integer(incident.passengersCount, 0, 50);
    timestamp(item.caseCreatedAt, true);
    timestamp(item.firstCallAt, true);
  }
  // Every returned field is validated; never shorten a preview then publish unseen text.
  return item as unknown as HandoffPublished;
}
/** History for the phone; sending to the app is recorded as an ordinary update. */
export function parseHandoffEvents(value: unknown): MobileHandoffGrant["events"] {
  if (!Array.isArray(value)) schema();
  if (value.length > MOBILE_HANDOFF_MAX_EVENTS) oversized();
  const seen = new Set<string>();
  return value.map(item => {
    const event = record(item, ["id", "action", "comment", "actor", "createdAt"]);
    if (typeof event.id !== "string" || !isUuid(event.id) || seen.has(event.id)) schema();
    seen.add(event.id);
    choice(event.action, Object.keys(handoffEventLabels));
    text(event.comment, 1000);
    text(event.actor, 320);
    timestamp(event.createdAt);
    return event as MobileHandoffGrant["events"][number];
  });
}
function grant(value: unknown): MobileHandoffGrant {
  const item = record(value, ["id", "status", "revision", "publishedVersion", "recipientName", "recipientPhone", "expiresAt", "createdAt", "openedAt", "eta", "createdBy", "publishedAt", "canRenew", "recoverable", "tokenGeneration", "published", "events"]);
  if (typeof item.id !== "string" || !isUuid(item.id)) schema();
  choice(item.status, handoffStates);
  integer(item.revision);
  integer(item.publishedVersion);
  text(item.recipientName, 160);
  text(item.recipientPhone, 30);
  timestamp(item.expiresAt);
  timestamp(item.createdAt);
  timestamp(item.openedAt, true);
  timestamp(item.eta, true);
  if (item.createdBy != null) text(item.createdBy, 320);
  if (item.publishedAt !== undefined) timestamp(item.publishedAt, true);
  if (typeof item.canRenew !== "boolean" || (item.recoverable !== undefined && typeof item.recoverable !== "boolean")) schema();
  if (item.tokenGeneration !== undefined) integer(item.tokenGeneration);
  const events = parseHandoffEvents(item.events);
  return { id: item.id, status: item.status as MobileHandoffGrant["status"], revision: item.revision, publishedVersion: item.publishedVersion,
    recipientName: item.recipientName, recipientPhone: item.recipientPhone, expiresAt: item.expiresAt as string, createdAt: item.createdAt as string,
    openedAt: item.openedAt as string | null, eta: item.eta as string | null, createdBy: item.createdBy as string | null | undefined ?? null,
    publishedAt: item.publishedAt as string | null | undefined ?? null, canRenew: item.canRenew, recoverable: item.recoverable === true,
    published: item.published === null ? null : snapshot(item.published), events, app: null };
}
export async function getMobileCaseHandoffs(session: HandoffSession, caseId: string): Promise<Omit<MobileCaseHandoffs, keyof MobileScope>> {
  const data = record(await getCaseHandoffContext(caseId, session), ["preview", "previewVersion", "handoffs", "enhanced"]);
  if (typeof data.previewVersion !== "string" || !/^[a-f0-9]{64}$/.test(data.previewVersion) || typeof data.enhanced !== "boolean" || !Array.isArray(data.handoffs)) schema();
  if (data.handoffs.length > MOBILE_HANDOFF_MAX_GRANTS) oversized();
  const handoffs = data.handoffs.map(grant);
  if (new Set(handoffs.map(item => item.id)).size !== handoffs.length) schema();
  const delivery = await getHandoffDeliveryContext(session, caseId);
  if (delivery) for (const item of handoffs) item.app = delivery.app.get(item.id) ?? null;
  return { caseId, previewVersion: data.previewVersion, preview: snapshot(data.preview), handoffs, enhanced: data.enhanced,
    ...(delivery ? { delivery: { members: delivery.members } } : {}) };
}
/** Who can receive in the app, which handoffs are in someone's app and where that
 * pristavovač is. Optional: a database without deliveries, or a failed read, simply
 * leaves the screen as it was. Strict web reads reject partial identities so an
 * unavailable assignment cannot appear unassigned. Mobile keeps its optional fallback. */
export async function getHandoffDeliveryContext(session: HandoffSession, caseId: string, strict = false): Promise<{ members: MobileDeliveryMember[]; app: Map<string, MobileHandoffApp> } | null> {
  if (!mobileDeliveryEnabled()) return null;
  const scope = { p_organization_id: session.actor.organizationId, p_actor_id: session.actor.profileId, p_case_id: caseId, p_input: {} };
  try {
    const [members, assigned] = await Promise.all([
      session.client.rpc("motorist_case_handoff_app", { ...scope, p_action: "members" }),
      session.client.rpc("motorist_case_handoff_app", { ...scope, p_action: "app" }),
    ]);
    if (members.error || assigned.error) return null;
    const list = (members.data as { members?: unknown } | null)?.members, entries = (assigned.data as { handoffs?: unknown } | null)?.handoffs;
    if (!Array.isArray(list) || !Array.isArray(entries) || list.length > 200) return null;
    const parsed: MobileDeliveryMember[] = list.flatMap(item => {
      const member = item as Record<string, unknown>;
      return typeof member.id === "string" && isUuid(member.id) && typeof member.displayName === "string" && member.displayName.length <= 160
        && (member.lastPhone === null || typeof member.lastPhone === "string" && member.lastPhone.length <= 30)
        ? [{ id: member.id.toLowerCase(), displayName: member.displayName, lastPhone: member.lastPhone as string | null }] : [];
    });
    if (strict && (parsed.length !== list.length || new Set(parsed.map(member => member.id)).size !== parsed.length)) return null;
    const app = new Map<string, MobileHandoffApp>();
    for (const item of entries) {
      const entry = item as Record<string, unknown>, point = entry.position as Record<string, unknown> | null | undefined;
      if (typeof entry.handoffId !== "string" || !isUuid(entry.handoffId) || typeof entry.memberId !== "string" || !isUuid(entry.memberId)) {
        if (strict) return null;
        continue;
      }
      if (strict && app.has(entry.handoffId.toLowerCase())) return null;
      const located = point && typeof point.lat === "number" && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90 && typeof point.lng === "number" && Number.isFinite(point.lng)
        && Math.abs(point.lng) <= 180 && typeof point.recordedAt === "string" && isHistoryTimestamp(point.recordedAt)
        ? { lat: point.lat, lng: point.lng, accuracy: typeof point.accuracy === "number" && Number.isFinite(point.accuracy) && point.accuracy >= 0 ? point.accuracy : null, recordedAt: point.recordedAt }
        : null;
      app.set(entry.handoffId.toLowerCase(), { memberId: entry.memberId.toLowerCase(), lastPosition: located });
    }
    return { members: parsed, app };
  } catch { return null; }
}
function deliveryError(error: { code?: string; message?: string }): MutationError {
  if (missingSchema(error.code)) return deliveryUnavailable();
  if (error.code === "PT409" && error.message === "Handoff changed") return new MutationError("Odovzdanie sa medzitým zmenilo. Obnovte údaje a skúste to znova.", 409, "handoff_changed");
  if (error.code === "PT409") return new MutationError("Odovzdanie už dostal iný pristavovač.", 409, "delivery_taken");
  if (error.code === "22023") return new MutationError("Vybraný pristavovač nemá aktívny prístup do aplikácie.", 400, "delivery_member_unavailable");
  if (error.code === "P0002") return new MutationError("Odovzdanie už nečaká na prijatie. Obnovte údaje.", 404);
  if (error.code === "42501") return new MutationError("Na toto odovzdanie nemáte oprávnenie.", 403);
  return new MutationError("Odoslanie do aplikácie sa nepodarilo overiť. Skúste znova.", 503, "delivery_unconfirmed");
}
/** Sends a confirmed handoff to a pristavovač in the app; the first time also to their phone. */
export async function sendHandoffToApp(session: HandoffSession, caseId: string, handoffId: string, memberId: string, commandId: string, expectedRevision: number): Promise<{ currentRevision: number }> {
  if (!mobileDeliveryEnabled()) throw deliveryUnavailable();
  const { data, error } = await session.client.rpc("motorist_case_handoff_app", { p_organization_id: session.actor.organizationId, p_actor_id: session.actor.profileId,
    p_case_id: caseId, p_action: "assign", p_input: { handoffId, memberId, commandId, expectedRevision } });
  if (error) throw deliveryError(error);
  const result = data as { assigned?: unknown; memberId?: unknown; handoff?: { id?: unknown; revision?: unknown; published?: unknown } } | null;
  if (typeof result?.assigned !== "boolean" || typeof result.memberId !== "string" || result.memberId.toLowerCase() !== memberId || result.handoff?.id !== handoffId
    || typeof result.handoff.revision !== "number" || !Number.isSafeInteger(result.handoff.revision) || result.handoff.revision < expectedRevision || result.handoff.revision > 2_147_483_647) throw deliveryError({});
  if (result.assigned === true) {
    const card = result.handoff.published as { caseNumber?: unknown; action?: unknown } | null | undefined;
    const known = typeof card?.caseNumber === "string" && typeof card.action === "string";
    const organizationId = session.actor.organizationId;
    queueMobilePush(() => sendMemberPush(createSupabaseAdminClient(), { organizationId, memberIds: [memberId], title: "Nové pristavenie",
      body: known ? ("Prípad " + card!.caseNumber + ": " + card!.action + ".").slice(0, 200) : "Máte nové pristavenie.", data: { kind: "delivery", id: handoffId } }));
  }
  return { currentRevision: result.handoff.revision };
}
const fields = {
  issue: ["recipientName", "recipientPhone", "previewVersion", "instructions", "scheduledAt", "hours", "recipientMemberId"],
  deliver: ["handoffId", "expectedRevision", "recipientMemberId"],
  publish: ["handoffId", "expectedRevision", "previewVersion", "instructions", "scheduledAt"],
  renew: ["handoffId", "expectedRevision", "hours"], extend: ["handoffId", "expectedRevision", "hours"],
  revoke: ["handoffId", "expectedRevision", "comment"], recover: ["handoffId", "expectedRevision"],
} as const;
export function parseMobileHandoffInput(value: unknown): MobileHandoffInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MutationError("Neplatná požiadavka odovzdania.", 400);
  const input = value as Record<string, unknown>;
  const action = input.action;
  if (typeof action !== "string" || !Object.hasOwn(fields, action)) throw new MutationError("Neplatná akcia odovzdania.", 400);
  const allowed: readonly string[] = ["action", "commandId", ...fields[action as keyof typeof fields]];
  if (Object.keys(input).some(key => !allowed.includes(key)) || Object.values(input).some(value => typeof value === "string" && (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || Buffer.from(value, "utf8").toString("utf8") !== value))) throw new MutationError("Neplatné údaje odovzdania.", 400);
  const { recipientMemberId, ...rest } = input;
  if (recipientMemberId !== undefined && (typeof recipientMemberId !== "string" || !isUuid(recipientMemberId))) throw new MutationError("Vyberte pristavovača zo zoznamu.", 400);
  const member = typeof recipientMemberId === "string" ? { recipientMemberId: recipientMemberId.toLowerCase() } : {};
  if (action === "deliver") {
    if (!member.recipientMemberId || typeof rest.commandId !== "string" || !isUuid(rest.commandId) || typeof rest.handoffId !== "string" || !isUuid(rest.handoffId)
      || typeof rest.expectedRevision !== "number" || !Number.isSafeInteger(rest.expectedRevision) || rest.expectedRevision < 1 || rest.expectedRevision > 2_147_483_647) throw new MutationError("Neplatná požiadavka odovzdania.", 400);
    return { action: "deliver", commandId: rest.commandId.toLowerCase(), handoffId: rest.handoffId.toLowerCase(), expectedRevision: rest.expectedRevision, recipientMemberId: member.recipientMemberId };
  }
  return { ...validateHandoffCommand(rest), ...member } as MobileHandoffInput;
}
export async function readMobileHandoffInput(request: Request): Promise<MobileHandoffInput> { return parseMobileHandoffInput(await readMobileJsonBody(request)); }
function availableLink(result: ResolvedHandoffLink, expectedId: string, minimumRevision: number, origin: string): Extract<MobileHandoffLink, { status: "available" }> {
  const current = result?.handoff;
  if (!current || current.id !== expectedId || !Number.isSafeInteger(current.revision) || current.revision < minimumRevision || current.revision > 2_147_483_647
    || !["offered", "accepted", "en_route", "arrived"].includes(current.status) || !isHistoryTimestamp(current.expiresAt) || Date.parse(current.expiresAt) <= Date.now()) unconfirmed();
  let url: URL;
  try { url = new URL(result.url); } catch { return unconfirmed(); }
  if (url.origin !== origin || url.username || url.password || url.search || url.pathname !== "/handoff" || !/^#token=[A-Za-z0-9_-]{43}$/.test(url.hash)
    || result.url !== `${origin}/handoff${url.hash}`) unconfirmed();
  return { status: "available", url: result.url, expiresAt: current.expiresAt, currentRevision: current.revision };
}
export async function commandMobileCaseHandoff(session: HandoffSession, request: Request, caseId: string, raw: MobileHandoffInput): Promise<Omit<MobileHandoffMutation, keyof MobileScope> | Omit<MobileHandoffRecovered, keyof MobileScope> | Omit<MobileHandoffDelivered, keyof MobileScope>> {
  const command = parseMobileHandoffInput(raw);
  const memberId = "recipientMemberId" in command ? command.recipientMemberId : undefined;
  if (memberId && !mobileDeliveryEnabled()) throw deliveryUnavailable();
  if (command.action === "deliver") {
    const sent = await sendHandoffToApp(session, caseId, command.handoffId, command.recipientMemberId, command.commandId, command.expectedRevision);
    return { kind: "delivery", caseId, handoffId: command.handoffId, commandId: command.commandId, memberId: command.recipientMemberId, sent: true, currentRevision: sent.currentRevision };
  }
  try {
    if (command.action === "recover") {
      const origin = handoffOrigin(request);
      const recovered = await recoverCaseHandoffLink(caseId, command.handoffId, command.commandId, session);
      const link = availableLink(recovered, command.handoffId, 1, origin);
      return { kind: "link", caseId, handoffId: command.handoffId, commandId: command.commandId, currentRevision: link.currentRevision, link };
    }
    const wantsLink = command.action === "issue" || command.action === "renew";
    const origin = wantsLink ? handoffOrigin(request) : undefined;
    const { receipt, resolveLink } = await prepareCaseHandoffCommand(request, caseId, command, session, origin);
    const expectedCommit = command.action === "issue" ? 1 : command.expectedRevision + 1;
    if (receipt.commandId !== command.commandId || receipt.committedRevision !== expectedCommit || receipt.handoff.revision < expectedCommit
      || receipt.handoff.revision > 2_147_483_647 || receipt.handoff.publishedVersion > 2_147_483_647 || (command.action !== "issue" && receipt.handoff.id !== command.handoffId)) unconfirmed();
    let link: MobileHandoffLink = wantsLink ? unavailableLink : { status: "not_requested" };
    if (wantsLink && resolveLink && origin) {
      try {
        link = availableLink(await resolveLink(), receipt.handoff.id, receipt.handoff.revision, origin);
      } catch {
        // Confirmed mutation survives a separate URL/read/decryption failure.
        link = unavailableLink;
      }
    }
    // The handoff exists either way; a failed send to the app is reported, the link still works.
    let delivery: MobileHandoffMutation["delivery"];
    if (command.action === "issue" && memberId) {
      try { await sendHandoffToApp(session, caseId, receipt.handoff.id, memberId, command.commandId, expectedCommit); delivery = { status: "sent", memberId }; }
      catch { delivery = { status: "failed", memberId }; }
    }
    return { kind: "mutation", caseId, handoffId: receipt.handoff.id, commandId: command.commandId, action: command.action,
      committedRevision: expectedCommit, currentRevision: receipt.handoff.revision, refreshRequired: true, link, ...(delivery ? { delivery } : {}) };
  } catch (error) {
    if (error instanceof MutationError && (error.status < 500 || error.code)) throw error;
    return unconfirmed();
  }
}
