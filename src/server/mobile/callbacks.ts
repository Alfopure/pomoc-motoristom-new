import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { callbackDeadline, callbackPermissions, CALLBACK_OVERDUE_MINUTES, CALLBACK_SOURCE_LABELS, type CallbackRequestPayload } from "@/lib/telephony/callback-queue";
import { callbackOriginDetail } from "@/lib/telephony/callback-origin";
import { confirmedCallbackTarget } from "@/lib/telephony/callback-target";
import { isUuid } from "@/lib/telephony/uuid";
import { MOBILE_CALLBACK_NOTE_LIMIT, type MobileCallbackCounts, type MobileCallbackRequest, type MobileCallbackResolveInput, type MobileCallbacks, type MobileCallbackSummary, type MobileCallTarget } from "@/lib/mobile-callbacks";
import type { MobileDraftScope } from "@/lib/mobile-api";
import type { MotoristActor } from "@/server/api-auth";
import { resolveCallbackTarget } from "@/server/callback-targets";
import { MutationError } from "@/server/mutation-error";
import { CALLBACK_LIVE_STATUSES, claimCallbackRequest, loadCallbackQueue, resolveCallbackRequest, type CallbackQueueDeps } from "@/server/telephony/callbacks";
import type { CallActor } from "@/server/telephony/call-actions";

const STATUSES = ["open", "scheduled", "done", "cancelled"] as const;
const ORIGINS = ["requested", "missed", "manual", "unknown"] as const;
function unavailable(): never { throw new MutationError("Spätné volania sa nepodarilo overiť.", 503); }
function text(value: unknown, max: number, multiline = false): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return unavailable();
  const clean = value.replace(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, "").trim();
  const bounded = clean.slice(0, max).replace(/[\ud800-\udbff]$/, "");
  try { encodeURIComponent(bounded); } catch { return unavailable(); }
  return bounded || null;
}
function timestamp(value: unknown, required = false): string | null {
  if ((value === null || value === undefined) && !required) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return unavailable();
  return value;
}
function identifier(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !isUuid(value)) return unavailable();
  return value.toLowerCase();
}
/** A SIP address, "anonymous" or malformed stored value is not a number to ring back. */
function callerNumber(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 80) return null;
  const result = value.trim();
  return /^\+?[0-9][0-9 ()-]{1,78}[0-9]$/.test(result) ? result : null;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return unavailable();
  return value as number;
}
function callActor(actor: MotoristActor): CallActor {
  return { profileId: actor.profileId, role: actor.role, displayName: actor.displayName };
}
function queueDeps(actor: MotoristActor): CallbackQueueDeps {
  return { admin: createSupabaseAdminClient(), organizationId: actor.organizationId };
}

/** Same rules as the web queue: the server decides, the client only renders. */
export function mobileCallbackRequest(payload: CallbackRequestPayload, actor: Pick<MotoristActor, "profileId" | "role">): MobileCallbackRequest {
  const id = identifier(payload.id);
  if (!id || !(STATUSES as readonly string[]).includes(payload.status)) return unavailable();
  const claimantId = identifier(payload.claimedByProfileId);
  const self = actor.profileId.toLowerCase();
  const permissions = callbackPermissions({ ...payload, claimedByProfileId: claimantId }, { profileId: self, role: actor.role });
  const origin = payload.origin && (ORIGINS as readonly string[]).includes(payload.origin.kind) ? payload.origin : null;
  const deadline = payload.status === "done" || payload.status === "cancelled" ? null : callbackDeadline(payload);
  const number = callerNumber(payload.callerNumber);
  return {
    id, number, name: text(payload.callerName, 200), status: payload.status,
    origin: origin?.kind ?? "unknown",
    originDetail: origin ? text(callbackOriginDetail(origin), 300) : null,
    sourceLabel: CALLBACK_SOURCE_LABELS[payload.source] ?? "Spätné volanie",
    lineLabel: text(payload.lineLabel, 200), partnerName: text(payload.partnerName, 200),
    caseId: identifier(payload.caseId),
    claimant: claimantId ? { id: claimantId, name: text(payload.claimedByName, 200), mine: claimantId === self } : null,
    claimedAt: timestamp(payload.claimedAt),
    deadlineAt: deadline === null ? null : new Date(deadline).toISOString(),
    createdAt: timestamp(payload.createdAt, true)!, resolvedAt: timestamp(payload.resolvedAt),
    notes: text(payload.notes, MOBILE_CALLBACK_NOTE_LIMIT, true), lastCalledAt: timestamp(payload.lastCalledAt),
    actions: {
      claim: permissions.canClaim, takeover: permissions.canClaim && claimantId !== null && claimantId !== self,
      call: permissions.canCall && number !== null, resolve: permissions.canResolve,
      blockedReason: text(permissions.blockedReason, 300),
    },
  };
}

export function parseCallbackListQuery(params: URLSearchParams): { cursor: string | null } {
  const keys = [...params.keys()];
  if (keys.some(key => key !== "cursor") || params.getAll("cursor").length > 1) throw new MutationError("Neplatný výber spätných volaní.", 400);
  const cursor = params.get("cursor");
  if (cursor !== null && (!cursor || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor))) throw new MutationError("Zoznam spätných volaní sa zmenil. Obnovte ho od začiatku.", 400);
  return { cursor };
}

function counts(openTotal: unknown, totals: Record<string, unknown> | undefined): MobileCallbackCounts {
  if (!totals) return unavailable();
  return { open: count(openTotal), requested: count(totals.requested), missed: count(totals.missed), manual: count(totals.manual), unknown: count(totals.unknown) };
}

export async function loadMobileCallbacks(actor: MotoristActor, cursor: string | null): Promise<Omit<MobileCallbacks, keyof MobileDraftScope>> {
  const queue = await loadCallbackQueue(queueDeps(actor), { profileId: actor.profileId, role: actor.role }, { cursor });
  const open = queue.open.map(item => mobileCallbackRequest(item, actor)), live = new Set(open.map(item => item.id));
  return {
    counts: counts(queue.openTotal, queue.totalsByOrigin),
    open,
    // Settled requests are first-page context; a later page repeats nothing. The two
    // reads are independent, so a request settled in between appears only as open.
    resolved: cursor ? [] : queue.resolved.map(item => mobileCallbackRequest(item, actor)).filter(item => !live.has(item.id)),
    nextCursor: queue.nextCursor ?? null,
    resetPage: queue.resetPage === true,
  };
}

/** Cheap console counters; every count is an independent exact read. */
export async function loadMobileCallbackSummary(actor: MotoristActor, now = new Date()): Promise<MobileCallbackSummary["counts"]> {
  const admin = createSupabaseAdminClient();
  const live = () => admin.from("motorist_callback_requests").select("id", { count: "exact", head: true })
    .eq("organization_id", actor.organizationId).in("status", [...CALLBACK_LIVE_STATUSES]);
  const legacyCutoff = new Date(now.getTime() - CALLBACK_OVERDUE_MINUTES * 60_000).toISOString();
  const [page, mine, unclaimed, overdue, overdueWithoutDue] = await Promise.all([
    admin.rpc("motorist_callback_queue_page_v1", { p_organization_id: actor.organizationId, p_limit: 1 }),
    live().eq("claimed_by", actor.profileId),
    live().is("claimed_by", null),
    live().lte("due_at", now.toISOString()),
    live().is("due_at", null).lte("created_at", legacyCutoff),
  ]);
  if (page.error || mine.error || unclaimed.error || overdue.error || overdueWithoutDue.error) unavailable();
  const data = page.data as { openTotal?: unknown; totalsByOrigin?: Record<string, unknown> } | null;
  if (!data || typeof data !== "object") return unavailable();
  const totals = counts(data.openTotal, data.totalsByOrigin);
  // Separate reads can straddle a new request; no subset may exceed the open total.
  const bounded = (value: number) => Math.min(value, totals.open);
  return { ...totals, mine: bounded(count(mine.count)), unclaimed: bounded(count(unclaimed.count)),
    overdue: bounded(count(overdue.count) + count(overdueWithoutDue.count)) };
}

export function parseCallbackId(value: string): string {
  if (!isUuid(value)) throw new MutationError("Požiadavka na spätné volanie sa nenašla.", 404);
  return value.toLowerCase();
}

export async function claimMobileCallback(actor: MotoristActor, id: string): Promise<MobileCallbackRequest> {
  const result = await claimCallbackRequest(queueDeps(actor), callActor(actor), parseCallbackId(id));
  return mobileCallbackRequest(result.request, actor);
}

export function parseCallbackResolve(value: unknown): MobileCallbackResolveInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MutationError("Neplatné uzavretie požiadavky.", 400);
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => key !== "status" && key !== "notes") || (body.status !== "done" && body.status !== "cancelled")) {
    throw new MutationError("Neplatné uzavretie požiadavky.", 400);
  }
  if (body.notes !== undefined && body.notes !== null && typeof body.notes !== "string") throw new MutationError("Neplatná poznámka.", 400);
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  if (notes.length > MOBILE_CALLBACK_NOTE_LIMIT) throw new MutationError(`Poznámka môže mať najviac ${MOBILE_CALLBACK_NOTE_LIMIT} znakov.`, 400);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(notes)) throw new MutationError("Neplatná poznámka.", 400);
  return { status: body.status, notes: notes || null };
}

export async function resolveMobileCallback(actor: MotoristActor, id: string, input: MobileCallbackResolveInput): Promise<MobileCallbackRequest> {
  const result = await resolveCallbackRequest(queueDeps(actor), callActor(actor), parseCallbackId(id), input);
  return mobileCallbackRequest(result.request, actor);
}

export function parseCallTargetQuery(params: URLSearchParams): string {
  if ([...params.keys()].some(key => key !== "number") || params.getAll("number").length !== 1) throw new MutationError("Neplatné telefónne číslo.", 400);
  const number = (params.get("number") ?? "").trim();
  if (!number || number.length > 100 || /[\u0000-\u001f\u007f]/.test(number)) throw new MutationError("Neplatné telefónne číslo.", 400);
  return number;
}

/** Display/confirmation contract only. Dialing revalidates the same verification. */
export async function resolveMobileCallTarget(actor: MotoristActor, number: string): Promise<MobileCallTarget["target"]> {
  const target = await resolveCallbackTarget(createSupabaseAdminClient(), actor.organizationId, number);
  if (!["original", "verified_alternative", "blocked"].includes(target.status)) return unavailable();
  const originalNumber = text(target.originalNumber, 100) ?? number;
  const names = { sourceName: text(target.sourceName, 200), targetName: text(target.targetName, 200) };
  if (target.status === "original") return { status: "original", originalNumber, dialNumber: originalNumber, ...names, verificationId: null };
  if (target.status === "blocked") return { status: "blocked", originalNumber, dialNumber: null, ...names, verificationId: null };
  const dialNumber = confirmedCallbackTarget(target, target.verificationId);
  if (!dialNumber || !target.verificationId || !isUuid(target.verificationId)) throw new MutationError("Overené náhradné číslo už nie je dostupné.", 409);
  return { status: "verified_alternative", originalNumber, dialNumber, ...names, verificationId: target.verificationId };
}
