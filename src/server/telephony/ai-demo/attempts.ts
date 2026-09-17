import type { SupabaseClient } from "@supabase/supabase-js";

import type { AiDemoState, Database } from "@/lib/supabase/database.types";

import { toJson } from "../state/types";

import { AI_DEMO_LIMITS } from "./config";
import type { AiDemoLeg } from "./flag";
import { AI_DEMO_TOKEN_PATTERN, tokenFromHeader } from "./identity";

/**
 * Persistence for the AI demo.
 *
 * Every state change is a conditional update — `update … where id = $1 and
 * state in (…)` — and a `null` result means somebody else already moved the
 * row. That is the whole concurrency design: two simultaneous webhooks, a
 * webhook racing the cron, or a redelivered event all collapse into "one of us
 * won, the other is a no-op", with no lease to acquire and no lock to hold.
 *
 * Nothing in here decides anything. The rules live in the orchestrator; this
 * file only makes them atomic.
 */

type AdminClient = SupabaseClient<Database>;
export type AiDemoAttempt = Database["public"]["Tables"]["motorist_ai_demo_attempts"]["Row"];
type AttemptPatch = Database["public"]["Tables"]["motorist_ai_demo_attempts"]["Update"];

const TABLE = "motorist_ai_demo_attempts";

/** PostgREST for "table or column is not in the schema cache" — the migration is not applied. */
export const MIGRATION_MISSING_CODES = new Set(["PGRST205", "PGRST204", "42P01"]);

export class AiDemoMigrationMissingError extends Error {
  constructor() {
    super("ai_demo_migration_missing");
    this.name = "AiDemoMigrationMissingError";
  }
}

/** Keeps the Postgres code reachable; `23505` is a routing decision, not a crash. */
export class AiDemoQueryError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message);
    this.name = "AiDemoQueryError";
  }
}

function raise(error: { code?: string | null; message?: string } | null): void {
  if (!error) return;
  if (error.code && MIGRATION_MISSING_CODES.has(error.code)) throw new AiDemoMigrationMissingError();
  throw new AiDemoQueryError(error.message ?? "ai_demo_query_failed", error.code ?? null);
}

/**
 * Every state in which an attempt still owns provider resources.
 *
 * Listed positively rather than as "not terminal": the partial unique index
 * uses the same idea, and a query that names its states cannot drift when a
 * state is added.
 */
export const AI_DEMO_OPEN_STATES: readonly AiDemoState[] = [
  "requested", "sip_dialing", "ai_offered", "ai_accepted", "mobile_dialing", "bridged", "talking", "ending",
];

/** `true` when the table is absent; lets a caller fall back to the human path. */
export function isMigrationMissing(error: unknown): boolean {
  if (error instanceof AiDemoMigrationMissingError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && MIGRATION_MISSING_CODES.has(code);
}

export type InsertAttemptInput = {
  organizationId: string;
  environment: "production" | "development";
  actorProfileId: string;
  requestId: string | null;
  scenario: string;
  targetNumber: string;
  fromNumber: string;
  correlationToken: string;
  sipDialCommandId: string;
  requestedAt: Date;
  deadlineAt: Date;
  metadata?: Record<string, unknown>;
};

export type InsertAttemptResult = { attempt: AiDemoAttempt } | { conflict: "busy" | "duplicate" };

/**
 * Creates the row that authorises exactly one demo.
 *
 * It is written *before* any provider call, so the failure mode of a crash is
 * an abandoned row the cron tidies up — never a billable leg nobody knows
 * about. The two partial unique indexes turn "one at a time" and "a replayed
 * request must not dial twice" into database facts rather than a read-then-act
 * race between two browser tabs.
 */
export async function insertAttempt(admin: AdminClient, input: InsertAttemptInput): Promise<InsertAttemptResult> {
  const { data, error } = await admin
    .from(TABLE)
    .insert({
      organization_id: input.organizationId,
      direction: "outbound",
      environment: input.environment,
      actor_profile_id: input.actorProfileId,
      request_id: input.requestId,
      scenario: input.scenario,
      target_number: input.targetNumber,
      from_number: input.fromNumber,
      correlation_token: input.correlationToken,
      sip_dial_command_id: input.sipDialCommandId,
      state: "requested",
      requested_at: input.requestedAt.toISOString(),
      deadline_at: input.deadlineAt.toISOString(),
      ...(input.metadata ? { metadata: toJson(input.metadata) } : {}),
    })
    .select()
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      const message = `${error.message} ${error.details ?? ""}`;
      return { conflict: message.includes("request") ? "duplicate" : "busy" };
    }
    raise(error);
  }
  if (!data) throw new Error("ai_demo_insert_returned_nothing");
  return { attempt: data as AiDemoAttempt };
}

export async function findByRequestId(admin: AdminClient, organizationId: string, actorProfileId: string, requestId: string): Promise<AiDemoAttempt | null> {
  const { data, error } = await admin
    .from(TABLE)
    .select()
    .eq("organization_id", organizationId)
    .eq("actor_profile_id", actorProfileId)
    .eq("request_id", requestId)
    .maybeSingle();
  raise(error);
  return (data as AiDemoAttempt | null) ?? null;
}

export async function loadAttempt(admin: AdminClient, organizationId: string, id: string): Promise<AiDemoAttempt | null> {
  const { data, error } = await admin.from(TABLE).select().eq("organization_id", organizationId).eq("id", id).maybeSingle();
  raise(error);
  return (data as AiDemoAttempt | null) ?? null;
}

export async function loadActive(admin: AdminClient, organizationId: string): Promise<AiDemoAttempt | null> {
  const { data, error } = await admin
    .from(TABLE)
    .select()
    .eq("organization_id", organizationId)
    .in("state", [...AI_DEMO_OPEN_STATES])
    .maybeSingle();
  raise(error);
  return (data as AiDemoAttempt | null) ?? null;
}

/**
 * The only way a row changes state.
 *
 * `from` lists the states the caller believes the row is in. A `null` return
 * means it was not one of them, which is always a legitimate outcome: the
 * caller was slower than a competing webhook, and the event it is holding has
 * already been accounted for.
 */
export async function transitionAttempt(
  admin: AdminClient,
  id: string,
  from: readonly AiDemoState[],
  patch: AttemptPatch,
): Promise<AiDemoAttempt | null> {
  const { data, error } = await admin
    .from(TABLE)
    .update(patch)
    .eq("id", id)
    .in("state", [...from])
    .select()
    .maybeSingle();
  raise(error);
  return (data as AiDemoAttempt | null) ?? null;
}

/** An unconditional patch for facts that are true regardless of state (provider ids, timestamps). */
export async function patchAttempt(admin: AdminClient, id: string, patch: AttemptPatch): Promise<AiDemoAttempt | null> {
  const { data, error } = await admin.from(TABLE).update(patch).eq("id", id).select().maybeSingle();
  raise(error);
  return (data as AiDemoAttempt | null) ?? null;
}

/**
 * Compare-and-set on a counter.
 *
 * Two concurrent cleanups must produce one increment, not two, or the "at most
 * two OpenAI hangup attempts" rule becomes "as many as there were webhooks".
 */
export async function casCounter(
  admin: AdminClient,
  id: string,
  column: "openai_hangup_attempts" | "cleanup_attempts",
  expected: number,
  patch: AttemptPatch = {},
): Promise<AiDemoAttempt | null> {
  const { data, error } = await admin
    .from(TABLE)
    .update({ ...patch, [column]: expected + 1 })
    .eq("id", id)
    .eq(column, expected)
    .select()
    .maybeSingle();
  raise(error);
  return (data as AiDemoAttempt | null) ?? null;
}

/**
 * Records the provider ids of a leg from whichever event arrives first.
 *
 * `call.initiated` usually beats the dial response, and after a request timeout
 * it may be the only place the `call_control_id` ever appears — which makes it
 * the difference between a leg we can hang up and one we cannot.
 */
export async function adoptLeg(
  admin: AdminClient,
  id: string,
  leg: AiDemoLeg,
  ids: { callControlId?: string | null; callLegId?: string | null; callSessionId?: string | null },
  extra: AttemptPatch = {},
): Promise<AiDemoAttempt | null> {
  const patch: AttemptPatch = { ...extra };
  const ccColumn = leg === "sip" ? "telnyx_sip_call_control_id" : "telnyx_mobile_call_control_id";
  const legColumn = leg === "sip" ? "telnyx_sip_call_leg_id" : "telnyx_mobile_call_leg_id";
  if (ids.callControlId) patch[ccColumn] = ids.callControlId;
  if (ids.callLegId) patch[legColumn] = ids.callLegId;
  if (ids.callSessionId) patch.telnyx_call_session_id = ids.callSessionId;
  if (Object.keys(patch).length === 0) return null;
  try {
    return await patchAttempt(admin, id, patch);
  } catch (error) {
    // Another attempt already owns this call_control_id: the id is unique, so
    // this row is not the one the event belongs to. Nothing to record.
    if (error instanceof AiDemoQueryError && error.code === "23505") return null;
    throw error;
  }
}

/** Marks a leg as gone so cleanup knows it must not be hung up again. */
export async function markLegGone(admin: AdminClient, id: string, leg: AiDemoLeg, cause: string | null, at: Date): Promise<AiDemoAttempt | null> {
  return patchAttempt(admin, id, {
    ...(leg === "sip"
      ? { sip_hangup_cause: cause, sip_hangup_done_at: at.toISOString() }
      : { mobile_hangup_cause: cause, mobile_hangup_done_at: at.toISOString() }),
  });
}

export type PendingLookup = { now: Date; sessionId: string; fromHeader: string | null };
export type PendingMatch =
  | { match: AiDemoAttempt; reason: "same_session" | "pending_dial" }
  | { ignored: "no_pending" | "window_expired" | "from_mismatch" };

/**
 * Finds the attempt an OpenAI `live.transport.incoming` belongs to.
 *
 * Two stages, in this order:
 *
 *  1. `openai_session_id` already recorded — a redelivered webhook. Returning
 *     the same row is what makes a second accept a no-op instead of a second
 *     session.
 *  2. Exactly one attempt in `sip_dialing` inside the correlation window.
 *
 * The `From` display name is only ever a *negative* filter. The docs are
 * explicit that SIP headers are untrusted call metadata, so a matching token
 * grants nothing; a mismatching one is simply proof the INVITE was not ours.
 */
export async function findPendingForIncoming(admin: AdminClient, organizationId: string, lookup: PendingLookup): Promise<PendingMatch> {
  const bySession = await admin.from(TABLE).select().eq("organization_id", organizationId).eq("openai_session_id", lookup.sessionId).maybeSingle();
  raise(bySession.error);
  if (bySession.data) return { match: bySession.data as AiDemoAttempt, reason: "same_session" };

  const since = new Date(lookup.now.getTime() - AI_DEMO_LIMITS.pendingWindowMs).toISOString();
  const pending = await admin
    .from(TABLE)
    .select()
    .eq("organization_id", organizationId)
    .eq("state", "sip_dialing")
    .gte("sip_dialed_at", since)
    .limit(2);
  raise(pending.error);

  const rows = (pending.data as AiDemoAttempt[] | null) ?? [];
  if (rows.length !== 1) {
    if (rows.length === 0) {
      const anyDialing = await admin.from(TABLE).select("id").eq("organization_id", organizationId).eq("state", "sip_dialing").limit(1);
      raise(anyDialing.error);
      return { ignored: (anyDialing.data ?? []).length > 0 ? "window_expired" : "no_pending" };
    }
    return { ignored: "no_pending" };
  }

  const candidate = rows[0];
  const token = tokenFromHeader(lookup.fromHeader);
  if (token !== null && token !== candidate.correlation_token) return { ignored: "from_mismatch" };
  // A `From` that carries no token at all is not evidence either way: header
  // retention on OpenAI's side is unverified, so only a *different* token
  // rejects the match.
  if (token === null && lookup.fromHeader !== null && AI_DEMO_TOKEN_PATTERN.test(lookup.fromHeader)) return { ignored: "from_mismatch" };
  return { match: candidate, reason: "pending_dial" };
}

/** Open attempts the cron should look at, oldest first. */
export async function findDue(admin: AdminClient, organizationId: string, limit: number): Promise<AiDemoAttempt[]> {
  const { data, error } = await admin
    .from(TABLE)
    .select()
    .eq("organization_id", organizationId)
    .in("state", [...AI_DEMO_OPEN_STATES])
    .order("requested_at", { ascending: true })
    .limit(limit);
  raise(error);
  return (data as AiDemoAttempt[] | null) ?? [];
}

export async function countToday(admin: AdminClient, organizationId: string, since: Date): Promise<number> {
  const { data, error } = await admin.from(TABLE).select("id").eq("organization_id", organizationId).gte("requested_at", since.toISOString());
  raise(error);
  return (data ?? []).length;
}

export async function listRecent(admin: AdminClient, organizationId: string, limit: number): Promise<AiDemoAttempt[]> {
  const { data, error } = await admin
    .from(TABLE)
    .select()
    .eq("organization_id", organizationId)
    .order("requested_at", { ascending: false })
    .limit(limit);
  raise(error);
  return (data as AiDemoAttempt[] | null) ?? [];
}

/** Does the table exist? Used by the preflight so the tab can say so plainly. */
export async function migrationApplied(admin: AdminClient): Promise<boolean> {
  const { error } = await admin.from(TABLE).select("id").limit(1);
  if (!error) return true;
  if (error.code && MIGRATION_MISSING_CODES.has(error.code)) return false;
  throw new Error(error.message ?? "ai_demo_query_failed");
}
