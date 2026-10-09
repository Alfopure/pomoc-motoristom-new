import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { reconciledHangupEvent } from "./call-reconciliation";
import { assertOwnership, DATABASE_REQUEST_MS, ownershipRpc, sessionOwnership } from "./ownership";
import { payloadFingerprint } from "./provider-journal";
import { commandEvidenceCandidate } from "./provider-event-evidence";
import { SessionLeaseLostError } from "./service-errors";
import type { SessionRunnerDeps } from "./session-runner";
import { checkpointEffects, readPendingEffects } from "./state/continuation";
import { commandKey, type LegRow, type SessionEvent, type SessionRow } from "./state/types";
import { uuidV5 } from "./telnyx/command-id";
import { getTestProviderSafety, hasTestCallProvenance, TestProviderSafetyError } from "./telnyx/test-safety";

const RETRY_INTERVAL_MS = 30_000;
const RECOVERY_SLOTS = [1, 2] as const;
export type InboundHangupRecovery = {
  status: "skipped" | "terminal_confirmed" | "provider_unknown" | "backoff" | "retry_pending" | "retry_exhausted" | "rejected" | "unavailable";
  attemptCount: number;
  pendingAgeMs: number;
};
export type InboundHangupRecoveryResult = {
  recovery: InboundHangupRecovery;
  session: SessionRow;
  deferredCommandIds: Set<string>;
  /** Internal reducer input, never log the provider's control token. */
  terminal?: { callControlId: string; observedAt: string };
};
type JournalRow = {
  session_id: string; command_id: string; method: string; path: string; fingerprint: string;
  request_payload: Record<string, unknown>; correlation_state: string | null;
  dispatch_generation: number; dispatch_token: string; first_dispatched_at: string;
  outcome: "unknown" | "accepted" | "rejected" | "rate_limited";
  next_attempt_at: string | null;
};
type JournalDatabase = {
  public: Omit<Database["public"], "Tables"> & {
    Tables: Database["public"]["Tables"] & {
      motorist_provider_commands: { Row: JournalRow; Insert: never; Update: never; Relationships: [] };
    };
  };
};
type Snapshot = { session: SessionRow; legs: LegRow[] };
const recoveryId = (sessionId: string, originalId: string, slot: number) =>
  uuidV5(JSON.stringify(["inbound-hangup-recovery-v1", sessionId, originalId, slot]));
const micros = (value: string) => BigInt(Date.parse(value)) * BigInt(1000) +
  BigInt(/\.(\d+)(?:Z|[+-]\d\d:\d\d)$/.exec(value)?.[1].padEnd(6, "0").slice(3, 6) ?? "000");

/** Recovered requests get two separate journal slots, retaining the original
 * wire ID/body. A persisted incomplete prepared customer hangup is itself the
 * durable obligation: even a late HTTP 2xx cannot retire it before terminal proof.
 */
export async function recoverUnknownInboundHangup(deps: SessionRunnerDeps, snapshot: Snapshot, event: SessionEvent,
  verifiedStatus?: InboundHangupRecoveryResult["terminal"]): Promise<InboundHangupRecoveryResult> {
  const session = snapshot.session;
  const deferredCommandIds = new Set<string>();
  let attemptCount = 0, pendingAgeMs = 0;
  const report = (status: InboundHangupRecovery["status"], terminal?: InboundHangupRecoveryResult["terminal"]): InboundHangupRecoveryResult => {
    if (status !== "skipped") deps.logger?.({ scope: "termination", code: `inbound_hangup_${status}`, sessionId: session.id,
      environment: deps.environment, attemptCount, pendingAgeMs });
    return { recovery: { status, attemptCount, pendingAgeMs }, session, deferredCommandIds, ...(terminal ? { terminal } : {}) };
  };
  const owner = sessionOwnership.getStore();
  if (owner?.contract !== 2 || owner.admin !== deps.admin || owner.organizationId !== deps.organizationId || owner.sessionId !== session.id ||
    session.writer_contract !== 2 || session.organization_id !== deps.organizationId || session.direction !== "inbound" || !session.termination_requested_at) return report("skipped");
  const customer = snapshot.legs.find(leg => leg.id === session.customer_leg_id && leg.role === "customer" &&
    leg.organization_id === deps.organizationId && leg.session_id === session.id);
  if (!customer?.telnyx_call_control_id) return report("skipped");
  const commands = readPendingEffects(session).entries.flatMap(entry =>
    entry.event.kind === "app" && entry.event.type === "hangup"
      ? entry.commands.filter(command => command.kind === "hangup" && command.reason === "app_hangup" &&
        command.leg.callControlId === customer.telnyx_call_control_id && !entry.completedCommands.includes(commandKey(command))) : []);
  const originalIds = [...new Set(commands.flatMap(command => "commandId" in command ? [command.commandId] : []))];
  if (!originalIds.length) return report("skipped");
  // Fail closed if the journal cannot be read: do not let a cached accepted
  // original dispose of the last persisted obligation after an ambiguous send.
  for (const id of originalIds) deferredCommandIds.add(id);
  const now = () => (deps.now ?? (() => new Date()))();
  pendingAgeMs = Math.max(0, now().getTime() - Date.parse(session.termination_requested_at));
  const recoveryOwner = { ...owner, deadline: owner.deadline - 2 * DATABASE_REQUEST_MS };
  if (Date.now() >= recoveryOwner.deadline) return report("unavailable");
  try {
    return await sessionOwnership.run(recoveryOwner, async () => {
      await assertOwnership();
      const journal = deps.admin as unknown as SupabaseClient<JournalDatabase>;
      const load = async (ids: string[]) => {
        const result = await journal.from("motorist_provider_commands")
          .select("session_id,command_id,method,path,fingerprint,request_payload,correlation_state,dispatch_generation,dispatch_token,first_dispatched_at,outcome,next_attempt_at")
          .eq("session_id", session.id).in("command_id", ids);
        if (result.error) throw new Error("inbound hangup journal unavailable");
        return result.data ?? [];
      };
      const originals = await load(originalIds);
      // No prepared request means ordinary first dispatch remains eligible.
      for (const id of originalIds) if (!originals.some(row => row.command_id === id)) deferredCommandIds.delete(id);
      if (!originals.length) return report("skipped");
      const path = `/calls/${encodeURIComponent(customer.telnyx_call_control_id)}/actions/hangup`;
      const valid = (row: JournalRow, wireId: string) => row.session_id === session.id && row.method === "POST" && row.path === path &&
        row.request_payload && !Array.isArray(row.request_payload) && typeof row.request_payload === "object" && row.request_payload.command_id === wireId &&
        row.fingerprint === payloadFingerprint({ method: "POST", path, body: row.request_payload }) &&
        row.correlation_state === (typeof row.request_payload.client_state === "string" ? row.request_payload.client_state : null) &&
        Number.isFinite(Date.parse(row.first_dispatched_at)) && Number.isSafeInteger(row.dispatch_generation) &&
        typeof row.dispatch_token === "string" && row.dispatch_token.length > 0;
      if (!originals.every(row => valid(row, row.command_id))) return report("unavailable");
      // PostgreSQL does not promise SELECT ordering. Keep one stable wire ID
      // and two-slot budget even if older data contains duplicate end intents.
      originals.sort((a, b) => micros(a.first_dispatched_at) < micros(b.first_dispatched_at) ? -1
        : micros(a.first_dispatched_at) > micros(b.first_dispatched_at) ? 1 : a.command_id.localeCompare(b.command_id));
      const original = originals[0], originalId = original.command_id;
      const ids = [originalId, ...RECOVERY_SLOTS.map(slot => recoveryId(session.id, originalId, slot))];
      let rows = await load(ids);
      const sameRequest = (row: JournalRow) => valid(row, originalId) && row.fingerprint === original.fingerprint;
      if (!rows.every(sameRequest)) return report("unavailable");
      attemptCount = rows.filter(row => row.command_id !== originalId).length;
      const pending = (row: JournalRow) => ({ commandId: row.command_id, fingerprint: row.fingerprint, path: row.path, payload: row.request_payload,
        dispatchGeneration: row.dispatch_generation, dispatchToken: row.dispatch_token, firstDispatchedAt: row.first_dispatched_at, correlationState: row.correlation_state });
      const currentTerminal = event.kind === "telnyx" && event.type === "call.hangup" && event.callControlId === customer.telnyx_call_control_id &&
        event.payload.reconciled !== true && originals.every(row => commandEvidenceCandidate(pending(row), session.id, event));
      const strictStatus = event.kind === "telnyx" && event.type === "call.hangup" && verifiedStatus?.callControlId === customer.telnyx_call_control_id &&
        verifiedStatus.observedAt === event.occurredAt;

      const settleTerminal = async (observedAt: string, source: "provider_status" | "verified_webhook"): Promise<InboundHangupRecoveryResult> => {
        const observation = reconciledHangupEvent(customer.telnyx_call_control_id, new Date(observedAt), true);
        // Keep the provider's full timestamp precision; the constructor is
        // normally used for millisecond status observations.
        observation.occurredAt = observedAt;
        const followsDispatch = (row: JournalRow) => commandEvidenceCandidate(pending(row), session.id, observation);
        if (!originals.every(followsDispatch)) return report("unavailable");
        rows = await load(ids);
        if (!rows.every(sameRequest)) return report("unavailable");
        for (const row of rows) {
          if (row.outcome !== "unknown" || !followsDispatch(row)) continue;
          await assertOwnership();
          const adopted = await ownershipRpc<boolean>(deps.admin, "motorist_provider_command_result_v2", {
            p_session_id: session.id, p_command_id: row.command_id, p_fingerprint: row.fingerprint,
            p_generation: row.dispatch_generation, p_token: row.dispatch_token, p_status: 200,
            p_result: { data: { result: "ok", evidence: { source, observedAt, effectSatisfied: true } } },
          });
          if (!adopted) {
            const fresh = (await load([row.command_id]))[0];
            // A late real response can already have settled this exact row.
            // A still-unknown or absent row means the evidence was not adopted.
            if (!fresh || !sameRequest(fresh) || fresh.outcome === "unknown") return report("unavailable");
          }
        }
        // Keep the original obligation until the runner stages the terminal
        // leg fact. A crash between marking it complete and that stage must
        // not strand the database leg without any scheduled recovery.
        return report("terminal_confirmed", { callControlId: customer.telnyx_call_control_id, observedAt });
      };
      if (currentTerminal) return settleTerminal(event.occurredAt!, "verified_webhook");
      if (strictStatus) return settleTerminal(verifiedStatus!.observedAt, "provider_status");
      if (!deps.telnyx) return report("unavailable");
      const client = deps.telnyx, config = client.config;
      const safety = config.testSafety ?? getTestProviderSafety();
      if (safety.restricted && (!safety.deploymentAllowed || !await hasTestCallProvenance({ ...config, safety }, customer.telnyx_call_control_id,
        { admin: deps.admin, organizationId: deps.organizationId }))) throw new TestProviderSafetyError();
      const observe = async (): Promise<"alive" | "ended" | "unknown"> => {
        await assertOwnership();
        const status = await client.retrieveCall(customer.telnyx_call_control_id), raw = status.raw;
        if (!status.known || raw?.call_control_id !== customer.telnyx_call_control_id || typeof raw.is_alive !== "boolean" ||
          raw.call_leg_id != null && customer.telnyx_call_leg_id && raw.call_leg_id !== customer.telnyx_call_leg_id ||
          raw.call_session_id != null && session.telnyx_session_id && raw.call_session_id !== session.telnyx_session_id) return "unknown";
        return raw.is_alive ? "alive" : "ended";
      };
      const observed = await observe();
      if (observed === "ended") return settleTerminal(now().toISOString(), "provider_status");
      if (observed === "unknown") return report("provider_unknown");
      if (rows.some(row => row.outcome === "rejected")) return report("rejected");
      const at = now().getTime();
      if (rows.some(row => row.outcome === "rate_limited" && (!row.next_attempt_at || !Number.isFinite(Date.parse(row.next_attempt_at)) || Date.parse(row.next_attempt_at) > at)) ||
        rows.some(row => at - Date.parse(row.first_dispatched_at) < RETRY_INTERVAL_MS)) return report("backoff");
      const nextId = ids.slice(1).find(id => !rows.some(row => row.command_id === id));
      if (!nextId) return report("retry_exhausted");
      await assertOwnership();
      try {
        // A 429 consumes the slot: never trigger the normal client's immediate
        // retry, and never allocate a new identity before Retry-After expires.
        await client.request("POST", path, { journalCommandId: nextId, commandId: originalId, body: original.request_payload, retryRateLimits: false });
      } catch (error) {
        if (error instanceof SessionLeaseLostError) throw error;
        rows = await load(ids);
        attemptCount = rows.filter(row => row.command_id !== originalId).length;
        return report(rows.some(row => row.outcome === "rejected") ? "rejected" : "retry_pending");
      }
      attemptCount += 1;
      if (Date.now() + DATABASE_REQUEST_MS >= recoveryOwner.deadline) return report("retry_pending");
      return await observe() === "ended" ? settleTerminal(now().toISOString(), "provider_status") : report("retry_pending");
    });
  } catch (error) {
    if (error instanceof SessionLeaseLostError) throw error;
    return report("unavailable");
  }
}

/** Called only after the verified terminal fact passed the owned reducer. The
 * actual persisted leg close is required before retiring the old obligation.
 */
export async function completeVerifiedInboundHangup(deps: SessionRunnerDeps, recovery: InboundHangupRecoveryResult): Promise<SessionRow | null> {
  if (!recovery.terminal || !recovery.deferredCommandIds.size) return null;
  const owner = sessionOwnership.getStore(), sessionId = recovery.session.id;
  if (owner?.contract !== 2 || owner.sessionId !== sessionId || owner.organizationId !== deps.organizationId || owner.admin !== deps.admin) throw new SessionLeaseLostError();
  await assertOwnership();
  const [current, leg] = await Promise.all([
    deps.admin.from("motorist_call_sessions").select("*").eq("organization_id", deps.organizationId).eq("id", sessionId).single(),
    deps.admin.from("motorist_call_legs").select("id,ended_at").eq("organization_id", deps.organizationId).eq("session_id", sessionId)
      .eq("id", recovery.session.customer_leg_id!).eq("telnyx_call_control_id", recovery.terminal.callControlId).maybeSingle(),
  ]);
  if (current.error || leg.error || !current.data || !leg.data?.ended_at) return null;
  let session = current.data;
  for (const entry of readPendingEffects(session).entries) {
    const proved = entry.commands.filter(command => command.kind === "hangup" && command.leg.callControlId === recovery.terminal!.callControlId &&
      recovery.deferredCommandIds.has(command.commandId));
    if (!proved.length) continue;
    const updated = { ...entry, completedCommands: [...new Set([...entry.completedCommands, ...proved.map(commandKey)])] };
    session = await checkpointEffects({ ...deps, now: deps.now ?? (() => new Date()) }, session.id, updated, entry.id, session);
  }
  recovery.deferredCommandIds.clear();
  return session;
}
