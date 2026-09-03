import "server-only";

import type { Database } from "@/lib/supabase/database.types";
import type { CallbackActorRole, CallbackQueuePayload, CallbackRequestPayload } from "@/lib/telephony/callback-queue";
import { canTakeOverCallback } from "@/lib/telephony/callback-queue";

import { CallActionError, loadSession, startOutboundCall, type CallActionDeps, type CallActor, type StartOutboundResult } from "./call-actions";
import { toJson, type LineRow } from "./state/types";

/**
 * Callback queue service (design §4 Phase 4, plan "fronta spätných volaní").
 *
 * The rows themselves are written by the state machine: `effects.ts`
 * `createCallbackRequest` inserts one whenever a caller asks to be rung back
 * (IVR digit, after hours, park limit, missed call). Nothing consumed them so
 * far, so this module is the dispatcher's half of the promise: read the queue,
 * claim a request, ring the caller back through the ordinary outbound path and
 * close the request when it is settled.
 *
 * Statuses are used as: `open` = nobody took it, `scheduled` = an operator
 * claimed it, `done` / `cancelled` = settled (`resolved_at` stamped). The
 * partial index `callback_requests_open_idx` covers exactly the first two.
 */

type CallbackRow = Database["public"]["Tables"]["motorist_callback_requests"]["Row"];

export const CALLBACK_LIVE_STATUSES = ["open", "scheduled"] as const;
/** How far back the panel shows already settled requests (context only). */
export const CALLBACK_RESOLVED_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CALLBACK_QUEUE_LIMIT = 100;

export type CallbackQueueDeps = {
  admin: CallActionDeps["admin"];
  organizationId: string;
  now?: () => Date;
  logger?: CallActionDeps["logger"];
};

function nowOf(deps: CallbackQueueDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

function readMetadata(row: Pick<CallbackRow, "metadata">): Record<string, unknown> {
  const value = row.metadata;
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

/** `metadata.callback_call` — the outbound session started from this request. */
function readLastCall(row: Pick<CallbackRow, "metadata">): { sessionId: string | null; at: string | null } {
  const call = readMetadata(row).callback_call;
  if (!call || typeof call !== "object" || Array.isArray(call)) return { sessionId: null, at: null };
  const record = call as Record<string, unknown>;
  return {
    sessionId: typeof record.session_id === "string" ? record.session_id : null,
    at: typeof record.at === "string" ? record.at : null,
  };
}

export function toCallbackPayload(
  row: CallbackRow,
  lookup: { line?: Pick<LineRow, "label" | "partner_name"> | null; claimedByName?: string | null },
): CallbackRequestPayload {
  const lastCall = readLastCall(row);
  return {
    id: row.id,
    callerNumber: row.caller_number,
    callerName: row.caller_name,
    source: row.source,
    status: row.status,
    lineId: row.line_id,
    lineLabel: lookup.line?.label ?? null,
    partnerName: lookup.line?.partner_name ?? null,
    caseId: row.case_id,
    sessionId: row.session_id,
    claimedByProfileId: row.claimed_by,
    claimedByName: lookup.claimedByName ?? null,
    claimedAt: row.claimed_at,
    dueAt: row.due_at,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    notes: row.notes,
    lastCallSessionId: lastCall.sessionId,
    lastCalledAt: lastCall.at,
  };
}

/**
 * One flat round trip for the panel: the live queue, the last day of settled
 * requests, and the two lookups they need (line labels, claimant names). No
 * PostgREST embeds, so the offline fake-Supabase harness drives the same code.
 */
export async function loadCallbackQueue(
  deps: CallbackQueueDeps,
  actor: { profileId: string; role: CallbackActorRole },
  options: { configured?: boolean } = {},
): Promise<CallbackQueuePayload> {
  const now = nowOf(deps);
  const { admin, organizationId } = deps;
  const since = new Date(now.getTime() - CALLBACK_RESOLVED_WINDOW_MS).toISOString();

  const [openResult, resolvedResult] = await Promise.all([
    admin
      .from("motorist_callback_requests")
      .select("*")
      .eq("organization_id", organizationId)
      .in("status", [...CALLBACK_LIVE_STATUSES])
      .order("created_at", { ascending: true })
      .limit(CALLBACK_QUEUE_LIMIT),
    admin
      .from("motorist_callback_requests")
      .select("*")
      .eq("organization_id", organizationId)
      .in("status", ["done", "cancelled"])
      .gte("resolved_at", since)
      .order("resolved_at", { ascending: false })
      .limit(20),
  ]);
  if (openResult.error) throw new CallActionError(`Frontu spätných volaní sa nepodarilo načítať: ${openResult.error.message}`, 500);
  if (resolvedResult.error) throw new CallActionError(`Frontu spätných volaní sa nepodarilo načítať: ${resolvedResult.error.message}`, 500);

  const rows = [...(openResult.data ?? []), ...(resolvedResult.data ?? [])] as CallbackRow[];
  const lineIds = [...new Set(rows.map((row) => row.line_id).filter((id): id is string => Boolean(id)))];
  const profileIds = [...new Set(rows.map((row) => row.claimed_by).filter((id): id is string => Boolean(id)))];

  const [lines, profiles] = await Promise.all([
    lineIds.length
      ? admin.from("motorist_telephony_lines").select("id, label, partner_name").eq("organization_id", organizationId).in("id", lineIds)
      : Promise.resolve({ data: [] as Array<{ id: string; label: string; partner_name: string | null }>, error: null }),
    profileIds.length
      ? admin.from("motorist_profiles").select("id, display_name").eq("organization_id", organizationId).in("id", profileIds)
      : Promise.resolve({ data: [] as Array<{ id: string; display_name: string }>, error: null }),
  ]);
  const lineById = new Map((lines.data ?? []).map((line) => [line.id, line]));
  const nameById = new Map((profiles.data ?? []).map((profile) => [profile.id, profile.display_name]));

  const toPayload = (row: CallbackRow) =>
    toCallbackPayload(row, {
      line: row.line_id ? lineById.get(row.line_id) ?? null : null,
      claimedByName: row.claimed_by ? nameById.get(row.claimed_by) ?? null : null,
    });

  return {
    checkedAt: now.toISOString(),
    configured: options.configured ?? true,
    actorProfileId: actor.profileId,
    actorRole: actor.role,
    open: ((openResult.data ?? []) as CallbackRow[]).map(toPayload),
    resolved: ((resolvedResult.data ?? []) as CallbackRow[]).map(toPayload),
  };
}

// --- actions -----------------------------------------------------------------

export type CallbackActionResult = { request: CallbackRequestPayload };
export type CallbackCallResult = CallbackActionResult & { call: StartOutboundResult; linked: boolean };

async function loadRequest(deps: CallbackQueueDeps, id: string): Promise<CallbackRow> {
  const { data, error } = await deps.admin
    .from("motorist_callback_requests")
    .select("*")
    .eq("organization_id", deps.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new CallActionError(`Požiadavku sa nepodarilo načítať: ${error.message}`, 500);
  if (!data) throw new CallActionError("Požiadavka na spätné volanie sa nenašla.", 404, "not_found");
  return data;
}

async function claimantName(deps: CallbackQueueDeps, profileId: string | null): Promise<string | null> {
  if (!profileId) return null;
  const { data } = await deps.admin.from("motorist_profiles").select("display_name").eq("organization_id", deps.organizationId).eq("id", profileId).maybeSingle();
  return data?.display_name ?? null;
}

async function present(deps: CallbackQueueDeps, row: CallbackRow): Promise<CallbackRequestPayload> {
  const line = row.line_id
    ? (await deps.admin.from("motorist_telephony_lines").select("label, partner_name").eq("organization_id", deps.organizationId).eq("id", row.line_id).maybeSingle()).data
    : null;
  return toCallbackPayload(row, { line, claimedByName: await claimantName(deps, row.claimed_by) });
}

function assertLive(row: CallbackRow): void {
  if (row.status === "done" || row.status === "cancelled") {
    throw new CallActionError("Požiadavka je už uzavretá.", 409, "already_resolved");
  }
}

/**
 * Refuses to act on a request another operator holds. Senior dispatchers and
 * above may take it over: a request claimed by someone who went home would
 * otherwise sit in the queue until it aged out with nobody able to touch it.
 */
async function assertClaimable(deps: CallbackQueueDeps, row: CallbackRow, actor: CallActor): Promise<void> {
  if (!row.claimed_by || row.claimed_by === actor.profileId) return;
  if (canTakeOverCallback(actor)) return;
  const name = await claimantName(deps, row.claimed_by);
  throw new CallActionError(`Požiadavku má prevzatú ${name ?? "iný dispečer"}.`, 409, "already_claimed");
}

/**
 * Claim, resolved as a conditional UPDATE rather than read-then-write: two
 * dispatchers pressing the button in the same second must not both believe they
 * own the caller. The loser's update matches no row and is answered with the
 * winner's name.
 */
export async function claimCallbackRequest(deps: CallbackQueueDeps, actor: CallActor, id: string): Promise<CallbackActionResult> {
  const row = await loadRequest(deps, id);
  assertLive(row);
  if (row.claimed_by === actor.profileId) return { request: await present(deps, row) };
  await assertClaimable(deps, row, actor);
  const nowIso = nowOf(deps).toISOString();

  const values = { claimed_by: actor.profileId, claimed_at: nowIso, status: "scheduled" as const };
  const query = deps.admin
    .from("motorist_callback_requests")
    .update(values)
    .eq("organization_id", deps.organizationId)
    .eq("id", id)
    .in("status", [...CALLBACK_LIVE_STATUSES]);
  // Takeover targets the claimant we just read, so it is equally conditional:
  // whoever claims in between wins and the takeover is answered with 409.
  const claimed = await (row.claimed_by ? query.eq("claimed_by", row.claimed_by) : query.is("claimed_by", null)).select("*");
  if (claimed.error) throw new CallActionError(`Prevzatie požiadavky zlyhalo: ${claimed.error.message}`, 500);
  const updated = (claimed.data ?? [])[0] as CallbackRow | undefined;
  if (!updated) {
    const fresh = await loadRequest(deps, id);
    assertLive(fresh);
    if (fresh.claimed_by === actor.profileId) return { request: await present(deps, fresh) };
    const name = await claimantName(deps, fresh.claimed_by);
    throw new CallActionError(`Požiadavku medzitým prevzal ${name ?? "iný dispečer"}.`, 409, "already_claimed");
  }
  return { request: await present(deps, updated) };
}

export async function resolveCallbackRequest(
  deps: CallbackQueueDeps,
  actor: CallActor,
  id: string,
  input: { status: "done" | "cancelled"; notes?: string | null },
): Promise<CallbackActionResult> {
  const row = await loadRequest(deps, id);
  assertLive(row);
  await assertClaimable(deps, row, actor);
  const now = nowOf(deps);
  const notes = typeof input.notes === "string" && input.notes.trim() ? input.notes.trim().slice(0, 500) : null;

  const updated = await deps.admin
    .from("motorist_callback_requests")
    .update({
      status: input.status,
      resolved_at: now.toISOString(),
      claimed_by: row.claimed_by ?? actor.profileId,
      claimed_at: row.claimed_at ?? now.toISOString(),
      notes: notes ?? row.notes,
      metadata: toJson({ ...readMetadata(row), resolved_by: actor.profileId }),
    })
    .eq("organization_id", deps.organizationId)
    .eq("id", id)
    .in("status", [...CALLBACK_LIVE_STATUSES])
    .select("*");
  if (updated.error) throw new CallActionError(`Uzavretie požiadavky zlyhalo: ${updated.error.message}`, 500);
  const result = (updated.data ?? [])[0] as CallbackRow | undefined;
  if (!result) throw new CallActionError("Požiadavka je už uzavretá.", 409, "already_resolved");

  // The state machine also opens a `kind: 'callback'` task on the case; leaving
  // it open after the caller was rung back would keep the case looking unfinished.
  if (input.status === "done" && result.case_id) await closeCallbackTask(deps, actor, result.case_id, now);
  return { request: await present(deps, result) };
}

async function closeCallbackTask(deps: CallbackQueueDeps, actor: CallActor, caseId: string, now: Date): Promise<void> {
  const done = await deps.admin
    .from("motorist_case_tasks")
    .update({ status: "done", completed_by: actor.profileId, completed_at: now.toISOString() })
    .eq("organization_id", deps.organizationId)
    .eq("case_id", caseId)
    .eq("kind", "callback")
    .eq("status", "open");
  if (done.error) deps.logger?.({ level: "warn", scope: "callbacks", message: "callback task close failed", error: done.error.message, caseId });
}

/**
 * Rings the caller back through the ordinary outbound path (`startOutboundCall`:
 * kill switch, rate limit, allowlist, device liveness, reservation) and links
 * the session to the request in both directions.
 *
 * The request stays open: the call being placed is not proof that the caller
 * was reached. The operator closes it with `done` or `cancel`.
 */
export async function callBackRequest(deps: CallActionDeps, actor: CallActor, id: string): Promise<CallbackCallResult> {
  const queueDeps: CallbackQueueDeps = { admin: deps.admin, organizationId: deps.organizationId, now: deps.now, logger: deps.logger };
  const row = await loadRequest(queueDeps, id);
  assertLive(row);
  await assertClaimable(queueDeps, row, actor);
  if (row.claimed_by !== actor.profileId) await claimCallbackRequest(queueDeps, actor, id);

  const call = await startOutboundCall(deps, actor, {
    to: row.caller_number,
    caseId: row.case_id,
    // Call back from the number the caller originally rang, so the partner line
    // they know shows on their phone. A line switched off since then would make
    // `startOutboundCall` refuse the call, so the operator's default is used.
    lineId: await activeLineId(queueDeps, row.line_id),
  });

  const linked = await linkCallToRequest(deps, row, { sessionId: call.sessionId, actor });
  const fresh = await loadRequest(queueDeps, id);
  return { request: await present(queueDeps, fresh), call, linked };
}

async function activeLineId(deps: CallbackQueueDeps, lineId: string | null): Promise<string | null> {
  if (!lineId) return null;
  const { data } = await deps.admin
    .from("motorist_telephony_lines")
    .select("id")
    .eq("organization_id", deps.organizationId)
    .eq("id", lineId)
    .eq("active", true)
    .maybeSingle();
  return data?.id ?? null;
}

/**
 * Best effort on purpose: the call is already live, so a failed bookkeeping
 * write must not be reported as a failed callback. The caller learns about it
 * through `linked: false` and a warning in the log.
 */
async function linkCallToRequest(
  deps: CallActionDeps,
  row: CallbackRow,
  input: { sessionId: string; actor: CallActor },
): Promise<boolean> {
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const metadata = {
    ...readMetadata(row),
    callback_call: { session_id: input.sessionId, at: nowIso, by: input.actor.profileId },
  };
  const updated = await deps.admin
    .from("motorist_callback_requests")
    .update({ metadata: toJson(metadata) })
    .eq("organization_id", deps.organizationId)
    .eq("id", row.id);
  if (updated.error) {
    deps.logger?.({ level: "warn", scope: "callbacks", message: "callback link failed", error: updated.error.message, requestId: row.id });
    return false;
  }
  try {
    const session = await loadSession(deps, input.sessionId);
    const sessionMeta = session.metadata && typeof session.metadata === "object" && !Array.isArray(session.metadata) ? { ...(session.metadata as Record<string, unknown>) } : {};
    const patched = await deps.admin
      .from("motorist_call_sessions")
      .update({ metadata: toJson({ ...sessionMeta, callback_request_id: row.id }) })
      .eq("id", input.sessionId);
    if (patched.error) throw new Error(patched.error.message);
  } catch (error) {
    deps.logger?.({ level: "warn", scope: "callbacks", message: "session link failed", error: error instanceof Error ? error.message : String(error), requestId: row.id });
    return false;
  }
  return true;
}
