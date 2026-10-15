import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { MobileCallContext, MobileCallContextTarget } from "@/lib/mobile-call-context";
import { caseStatusLabels, isMobileCaseStatus } from "@/lib/mobile-case-filters";
import { isUuid } from "@/lib/telephony/uuid";
import { isHistoryTimestamp } from "@/lib/telephony/call-history-query";
import { resolveAppEnvironment } from "@/lib/app-environment";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { MOBILE_ROLES } from "./auth";

type Row = Record<string, unknown>;
type Table = keyof Database["public"]["Tables"];
const CALL_FIELDS = "id,organization_id,session_id,direction,status,caller_number,called_number,destination_number,caller_name,line_id,operator_id,case_id,started_at,created_at,answered_at,ended_at,duration_seconds";
const SESSION_FIELDS = "id,organization_id,direction,state,caller_number,called_number,line_id,answered_by_profile_id,case_id,started_at,answered_at,ended_at";
function unavailable(): never { throw new MutationError("Údaje hovoru sa nepodarilo overiť.", 503); }
function missing(): never { throw new MutationError("Hovor sa nenašiel.", 404); }
function text(value: unknown, max: number, multiline = false): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return unavailable();
  const clean = value.replace(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, "").trim();
  // Never return an incomplete UTF-16 pair at the presentation bound.
  const bounded = clean.slice(0, max).replace(/[\ud800-\udbff]$/, "");
  try { encodeURIComponent(bounded); } catch { return unavailable(); }
  return bounded || null;
}
function identifier(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !isUuid(value)) return unavailable();
  return value.toLowerCase();
}
function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !isHistoryTimestamp(value)) return unavailable();
  return value;
}
function direction(value: unknown): MobileCallContext["call"]["direction"] {
  if (value !== "inbound" && value !== "outbound" && value !== "internal") return unavailable();
  return value;
}
function number(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 80) return null;
  const result = value.trim();
  // A SIP address or malformed stored endpoint is not a transferable customer number.
  return result && /^\+?[0-9][0-9 ()-]{1,78}[0-9]$/.test(result) ? result : null;
}

export function parseCallContextTarget(id: string, params: URLSearchParams): MobileCallContextTarget {
  if (!isUuid(id) || [...params.keys()].some(key => key !== "source") || params.getAll("source").length !== 1) {
    throw new MutationError("Neplatný odkaz na hovor.", 400);
  }
  const kind = params.get("source");
  if (kind !== "call" && kind !== "session") throw new MutationError("Neplatný zdroj hovoru.", 400);
  return { kind, id: id.toLowerCase() };
}

/** Read-only projection. History visibility is organization-wide; console sessions need own current evidence. */
export async function getMobileCallContext(actor: MotoristActor, target: MobileCallContextTarget, signal?: AbortSignal,
  admin: SupabaseClient<Database> = createSupabaseAdminClient()): Promise<Pick<MobileCallContext, "target" | "call" | "linkedCase" | "linkState">> {
  if (!(MOBILE_ROLES as readonly string[]).includes(actor.role)) throw new MutationError("Nemáte prístup k hovorom.", 403);
  target = parseCallContextTarget(target.id, new URLSearchParams({ source: target.kind }));
  const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000);
  const environment = resolveAppEnvironment() === "production" ? "production" : "development";
  async function read(table: Table, columns: string, filters: Record<string, string | null>, limit = 1) {
    abort.throwIfAborted();
    let query = admin.from(table).select(columns).eq("organization_id" as never, actor.organizationId as never);
    for (const [key, value] of Object.entries(filters)) query = value === null ? query.is(key as never, null) : query.eq(key as never, value as never);
    if (table === "motorist_call_sessions") query = query.contains("metadata" as never, { environment });
    const { data, error } = await query.limit(limit).abortSignal(abort);
    abort.throwIfAborted();
    if (error || !Array.isArray(data) || data.length > limit) return unavailable();
    const rows = data as unknown as Row[];
    if (rows.some(row => row.organization_id !== actor.organizationId || !identifier(row.id))) return unavailable();
    return rows;
  }
  const byId = async (table: Table, columns: string, id: unknown) => {
    const key = identifier(id);
    if (!key) return null;
    const row = (await read(table, columns, { id: key }))[0] ?? null;
    if (row && identifier(row.id) !== key) return unavailable();
    return row;
  };
  async function requireOwnSession(session: Row) {
    if (session.answered_by_profile_id === actor.profileId) return;
    // Matches console.mine: any current actor leg (including consult/external
    // operator endpoints) or offered attempt, not an arbitrary org session.
    const [legs, offers] = await Promise.all([
      read("motorist_call_legs", "id,organization_id", { session_id: target.id, profile_id: actor.profileId, ended_at: null }),
      read("motorist_ring_attempts", "id,organization_id", { session_id: target.id, profile_id: actor.profileId, result: "offered" }),
    ]);
    if (!legs.length && !offers.length) return missing();
  }
  let call: Row | null = null, session: Row | null = null, ambiguous = false;
  if (target.kind === "call") {
    call = await byId("motorist_calls", CALL_FIELDS, target.id);
    if (!call) return missing();
    if (call.session_id) {
      session = await byId("motorist_call_sessions", SESSION_FIELDS, call.session_id);
      if (!session) ambiguous = true;
    }
  } else {
    session = await byId("motorist_call_sessions", SESSION_FIELDS, target.id);
    if (!session) return missing();
    await requireOwnSession(session);
    const calls = await read("motorist_calls", CALL_FIELDS, { session_id: target.id }, 2);
    ambiguous = calls.length > 1;
    call = calls.length === 1 ? calls[0] : null;
  }
  const primary = target.kind === "call" ? call! : session!;
  if (call && session && call.direction !== session.direction) return unavailable();
  const dir = direction(primary.direction);
  const operatorId = target.kind === "call" ? primary.operator_id : primary.answered_by_profile_id;
  const [line, operator] = await Promise.all([
    byId("motorist_telephony_lines", "id,organization_id,label", primary.line_id),
    byId("motorist_profiles", "id,organization_id,display_name", operatorId),
  ]);
  const start = timestamp(primary.started_at) ?? (target.kind === "call" ? timestamp(primary.created_at) : null);
  if (!start) return unavailable();
  const status = text(target.kind === "call" ? primary.status : primary.state, 80);
  if (!status) return unavailable();
  const duration = target.kind === "call" ? primary.duration_seconds : null;
  if (duration !== null && duration !== undefined && (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 0)) return unavailable();
  const projection: MobileCallContext["call"] = {
    id: call ? identifier(call.id) : null, sessionId: session ? identifier(session.id) : null,
    direction: dir, status, number: dir === "internal" ? null : number(dir === "outbound" ? (target.kind === "call" ? primary.destination_number || primary.called_number : primary.called_number) : primary.caller_number),
    name: dir === "internal" ? null : text(call?.caller_name, 200), lineLabel: text(line?.label, 200), operatorName: text(operator?.display_name, 200),
    startedAt: start, answeredAt: timestamp(primary.answered_at), endedAt: timestamp(primary.ended_at), durationSeconds: typeof duration === "number" ? duration : null,
  };
  const callCase = identifier(call?.case_id), sessionCase = identifier(session?.case_id);
  if (call && session && callCase !== sessionCase) ambiguous = true;
  const caseId = callCase ?? sessionCase;
  let linkedCase: MobileCallContext["linkedCase"] = null;
  let linkState: MobileCallContext["linkState"] = ambiguous ? "unavailable" : caseId ? "unavailable" : "unlinked";
  if (!ambiguous && caseId) {
    // Same case visibility as loadCaseDetailSnapshot, but no events/notes/attachments or locations read.
    const row = await byId("motorist_cases", "id,organization_id,case_number,status,summary,contact_id,vehicle_id,owner_id,updated_at", caseId);
    if (row) {
      const [contact, vehicle, owner] = await Promise.all([
        byId("motorist_contacts", "id,organization_id,name", row.contact_id),
        byId("motorist_vehicles", "id,organization_id,license_plate", row.vehicle_id),
        byId("motorist_profiles", "id,organization_id,display_name", row.owner_id),
      ]);
      const verified = await byId("motorist_cases", "id,organization_id,updated_at", caseId);
      if (!verified || verified.updated_at !== row.updated_at) return unavailable();
      if (!isMobileCaseStatus(row.status)) return unavailable();
      const caseNumber = text(row.case_number, 120);
      if (!caseNumber) return unavailable();
      linkedCase = { id: caseId, caseNumber, status: row.status, statusLabel: caseStatusLabels[row.status], summary: text(row.summary, 2000, true) ?? "",
        contactName: text(contact?.name, 200), licensePlate: text(vehicle?.license_plate, 32), ownerName: text(owner?.display_name, 200) };
      linkState = "linked";
    }
  }
  // Linking is an existing multi-row write. Never publish a case card assembled
  // across a concurrent relink or a call/session projection change.
  if (call) {
    const verified = await byId("motorist_calls", "id,organization_id,session_id,case_id", call.id);
    if (!verified || verified.session_id !== call.session_id || verified.case_id !== call.case_id) return unavailable();
  }
  if (session) {
    const verified = await byId("motorist_call_sessions", "id,organization_id,case_id,answered_by_profile_id", session.id);
    if (!verified || verified.case_id !== session.case_id || verified.answered_by_profile_id !== session.answered_by_profile_id) return unavailable();
    if (target.kind === "session") await requireOwnSession(verified);
  }
  return { target, call: projection, linkedCase, linkState };
}
