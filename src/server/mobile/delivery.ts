import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { handoffStates } from "@/domain/case-handoff";
import type { Json } from "@/lib/supabase/database.types";
import type { MobileDelivery, MobileDeliveryAction, MobileDeliveryCommand, MobileDeliveryPositionInput } from "@/lib/mobile-api";
import { isHistoryTimestamp } from "@/lib/telephony/call-history-query";
import { isUuid } from "@/lib/telephony/uuid";
import { validateHandoffCommand } from "@/server/case-handoff";
import { MutationError } from "@/server/mutation-error";
import { parseHandoffEvents, parseHandoffSnapshot } from "./case-handoff";
import { deliveryUnavailable, fieldAdmin, missingSchema, type MobileFieldActor } from "./field-auth";

/** The pristavovač's deliveries: only handoffs a dispatcher sent to them in the app,
 * through a service-role function that re-checks the membership every time. */
const ACTIONS: readonly MobileDeliveryAction[] = ["accept", "reject", "en_route", "arrived", "complete", "update", "blocked"];

function unconfirmed(): never { throw new MutationError("Pristavenie sa nepodarilo overiť. Skúste znova.", 503, "delivery_unconfirmed"); }
function deliveryError(error: { code?: string; message?: string }): never {
  const code = error.code ?? "";
  if (missingSchema(code)) throw deliveryUnavailable();
  if (code === "42501") throw new MutationError("Nemáte prístup k pristaveniam.", 403, "mobile_no_field_access");
  if (code === "P0002") throw new MutationError("Pristavenie už nie je dostupné. Dispečer ho mohol zrušiť alebo mu skončila platnosť.", 404);
  if (code === "PT409" && error.message === "Not tracking") throw new MutationError("Polohu môžete posielať od svojho kroku v pristavení, kým je otvorené.", 409, "delivery_not_tracking");
  // A database with the first delivery migration only knows no background secret yet.
  if (code === "22023" && error.message === "Invalid command") throw new MutationError("Zdieľanie polohy na pozadí ešte nie je v tomto prostredí zapnuté.", 503, "delivery_background_unavailable");
  if (["PT409", "23505", "40001"].includes(code)) throw new MutationError("Pristavenie sa medzitým zmenilo. Načítajte ho znova a rozhodnite sa.", 409);
  if (["22023", "22P02", "23514", "22007", "22008"].includes(code)) throw new MutationError("Skontrolujte údaje a dôvod.", 400);
  return unconfirmed();
}
async function call(actor: MobileFieldActor, action: string, input: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await fieldAdmin().rpc("motorist_member_handoff", { p_user_id: actor.userId, p_organization_id: actor.organizationId,
    p_membership_version: actor.version, p_action: action, p_input: input as Json });
  if (error) deliveryError(error);
  return data;
}

function position(value: unknown): MobileDelivery["replacementPosition"] {
  if (value === null || value === undefined) return null;
  const item = value as Record<string, unknown>;
  const lat = Number(item.lat), lng = Number(item.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || typeof item.recordedAt !== "string" || !isHistoryTimestamp(item.recordedAt)) return null;
  return { lat, lng, recordedAt: item.recordedAt };
}
/** Every field the phone shows is checked; customer data only while the delivery is open. */
export function parseDelivery(value: unknown): MobileDelivery {
  const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : unconfirmed();
  const allowed = ["id", "status", "revision", "publishedVersion", "expiresAt", "createdAt", "openedAt", "eta", "createdBy", "published", "events", "caseNumber", "replacementPosition", "tracking"];
  if (Object.keys(item).some(key => !allowed.includes(key))) unconfirmed();
  const integer = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 2_147_483_647;
  const date = (v: unknown, nullable = false) => nullable && v === null || typeof v === "string" && isHistoryTimestamp(v);
  if (typeof item.id !== "string" || !isUuid(item.id) || typeof item.status !== "string" || !(handoffStates as readonly string[]).includes(item.status)
    || !integer(item.revision) || !integer(item.publishedVersion) || typeof item.caseNumber !== "string" || item.caseNumber.length > 160
    || !date(item.expiresAt) || !date(item.createdAt) || !date(item.openedAt, true) || !date(item.eta, true)
    || item.createdBy != null && (typeof item.createdBy !== "string" || item.createdBy.length > 320) || typeof item.tracking !== "boolean") unconfirmed();
  const open = ["offered", "accepted", "en_route", "arrived"].includes(item.status) && Date.parse(item.expiresAt as string) > Date.now();
  return {
    id: item.id.toLowerCase(), status: item.status as MobileDelivery["status"], revision: item.revision as number, publishedVersion: item.publishedVersion as number,
    caseNumber: item.caseNumber, expiresAt: item.expiresAt as string, createdAt: item.createdAt as string, openedAt: item.openedAt as string | null,
    eta: item.eta as string | null, createdBy: (item.createdBy as string | null | undefined) ?? null,
    // The database already withholds them once the delivery closes; never pass them on regardless.
    card: !open || item.published === null || item.published === undefined ? null : parseHandoffSnapshot(item.published),
    events: parseHandoffEvents(item.events ?? []), replacementPosition: open ? position(item.replacementPosition) : null,
    tracking: open && item.tracking === true,
  };
}

export async function loadDeliveries(actor: MobileFieldActor): Promise<MobileDelivery[]> {
  const data = await call(actor, "list", {}) as { handoffs?: unknown } | null;
  if (!Array.isArray(data?.handoffs) || data.handoffs.length > 100) unconfirmed();
  // One delivery that cannot be shown must not hide the others.
  const deliveries = data.handoffs.flatMap(item => { try { return [parseDelivery(item)]; } catch { return []; } });
  if (deliveries.length < data.handoffs.length) console.warn(JSON.stringify({ event: "mobile.delivery", skipped: data.handoffs.length - deliveries.length }));
  return deliveries;
}
function deliveryId(value: string): string {
  if (!isUuid(value)) throw new MutationError("Pristavenie sa nenašlo.", 404);
  return value.toLowerCase();
}
export async function readDelivery(actor: MobileFieldActor, id: string): Promise<MobileDelivery> {
  const handoffId = deliveryId(id);
  const data = await call(actor, "read", { handoffId }) as { handoff?: unknown } | null;
  const delivery = parseDelivery(data?.handoff);
  if (delivery.id !== handoffId) unconfirmed();
  return delivery;
}

export function readDeliveryCommand(value: unknown): MobileDeliveryCommand {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const keys = ["commandId", "action", "expectedRevision", "publishedVersion", "comment", "eta"];
  if (!body || Object.keys(body).some(key => !keys.includes(key)) || !ACTIONS.includes(body.action as MobileDeliveryAction)) throw new MutationError("Neplatný krok pristavenia.", 400);
  return body as MobileDeliveryCommand;
}
export async function commandDelivery(actor: MobileFieldActor, id: string, value: unknown): Promise<{ delivery: MobileDelivery; commandId: string; committedRevision: number }> {
  const handoffId = deliveryId(id);
  // The same checks as the link page: reasons, revisions, ETA and text limits.
  const command = validateHandoffCommand({ ...readDeliveryCommand(value), handoffId }, true);
  const data = await call(actor, "command", { ...command }) as { handoff?: unknown; commandId?: unknown; committedRevision?: unknown } | null;
  const delivery = parseDelivery(data?.handoff);
  if (delivery.id !== handoffId || data?.commandId !== command.commandId || typeof data.committedRevision !== "number" || !Number.isSafeInteger(data.committedRevision)
    || data.committedRevision < 1 || delivery.revision < data.committedRevision) unconfirmed();
  return { delivery, commandId: command.commandId, committedRevision: data.committedRevision };
}

export function readDeliveryPosition(value: unknown): MobileDeliveryPositionInput {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!body || Object.keys(body).some(key => !["lat", "lng", "accuracy", "recordedAt"].includes(key))
    || typeof body.lat !== "number" || !Number.isFinite(body.lat) || Math.abs(body.lat) > 90
    || typeof body.lng !== "number" || !Number.isFinite(body.lng) || Math.abs(body.lng) > 180
    || body.accuracy !== null && (typeof body.accuracy !== "number" || !Number.isFinite(body.accuracy) || body.accuracy < 0 || body.accuracy > 100_000)
    || typeof body.recordedAt !== "string" || !isHistoryTimestamp(body.recordedAt)) throw new MutationError("Neplatná poloha.", 400);
  return { lat: body.lat, lng: body.lng, accuracy: body.accuracy as number | null, recordedAt: new Date(body.recordedAt).toISOString() };
}
/** Stored only while the pristavovač who took the delivery in the app is on it; the
 * database decides and throttles. `active` false tells the phone to stop. */
export async function recordDeliveryPosition(actor: MobileFieldActor, id: string, value: unknown): Promise<{ stored: boolean; active: boolean }> {
  const handoffId = deliveryId(id), input = readDeliveryPosition(value);
  const data = await call(actor, "position", { handoffId, ...input }) as { stored?: unknown; active?: unknown } | null;
  if (typeof data?.stored !== "boolean" || typeof data.active !== "boolean") unconfirmed();
  return { stored: data.stored, active: data.active };
}

/** A secret for one delivery, so the phone can send its position in the background
 * (app closed, phone locked) without the sign-in session. Only its hash reaches the
 * database; it ends with the delivery, a new secret or the pristavovač's logout. */
export const trackerHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
export async function issueDeliveryTracker(actor: MobileFieldActor, id: string): Promise<{ token: string; expiresAt: string }> {
  const handoffId = deliveryId(id), token = randomBytes(32).toString("base64url");
  const data = await call(actor, "tracker", { handoffId, tokenHash: trackerHash(token) }) as { expiresAt?: unknown } | null;
  if (typeof data?.expiresAt !== "string" || !isHistoryTimestamp(data.expiresAt)) unconfirmed();
  return { token, expiresAt: data.expiresAt };
}
export async function revokeDeliveryTracker(actor: MobileFieldActor, id: string): Promise<{ revoked: boolean }> {
  const data = await call(actor, "untrack", { handoffId: deliveryId(id) }) as { revoked?: unknown } | null;
  if (data?.revoked !== true) unconfirmed();
  return { revoked: true };
}

/** `Authorization: Tracker <secret>`; anything else is not signed in. */
export function readTrackerToken(request: Request): string {
  const match = /^Tracker ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new MutationError("Chýba oprávnenie na odoslanie polohy.", 401);
  return match[1];
}
/** What the phone kept since its last send, oldest first; at most 100 readings. */
export function readTrackPositions(value: unknown): MobileDeliveryPositionInput[] {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!body || Object.keys(body).some(key => key !== "positions") || !Array.isArray(body.positions) || body.positions.length < 1 || body.positions.length > 100) {
    throw new MutationError("Neplatné polohy.", 400);
  }
  return body.positions.map(readDeliveryPosition);
}
export async function trackDeliveryPositions(token: string, value: unknown): Promise<{ stored: number; active: boolean }> {
  const positions = readTrackPositions(value);
  const { data, error } = await fieldAdmin().rpc("motorist_handoff_track", { p_token_hash: trackerHash(token), p_positions: positions as unknown as Json });
  if (error) deliveryError(error);
  const result = data as { stored?: unknown; active?: unknown } | null;
  if (typeof result?.stored !== "number" || !Number.isSafeInteger(result.stored) || result.stored < 0 || typeof result.active !== "boolean") unconfirmed();
  return { stored: result.stored, active: result.active };
}
