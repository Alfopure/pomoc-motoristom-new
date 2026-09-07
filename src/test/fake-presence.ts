import { randomUUID } from "node:crypto";
import { effectivePresenceStatus, readPauseReturn } from "@/lib/telephony/presence-policy";
import type { OperatorPresenceStatus } from "@/lib/supabase/database.types";
import type { FakeDatabase, FakeRow } from "./fake-supabase";

/** Workflow fake only; PostgreSQL locking/rollback evidence is in tests/postgres. */
export function registerPresenceRpcs(db: FakeDatabase): void {
  db.registerRpc("motorist_presence_transition_v1", async (args) => {
    if (args.p_action === "acquire") {
      const handler = db.rpcHandlers.get("motorist_presence_transition_v1")!;
      const dispatched = await handler({ ...args, p_action: "dispatch" }, db) as FakeRow;
      if (!dispatched.applied) return dispatched;
      const answered = await handler({ ...args, p_action: "answer", p_expected_revision: dispatched.revision, p_expected_token: dispatched.offerToken }, db) as FakeRow;
      return { ...answered, reused: dispatched.reused ?? false };
    }
    const p = db.storage("motorist_operator_presence").find((r) => r.profile_id === args.p_profile_id && r.organization_id === args.p_organization_id);
    const action = args.p_action;
    const sessionId = ["manual", "end_wrap_up"].includes(String(action)) ? p?.current_session_id : args.p_session_id;
    const session = db.storage("motorist_call_sessions").find((r) => r.id === sessionId && r.organization_id === args.p_organization_id);
    if (!p) return { applied: false, reason: "no_presence" };
    if (sessionId && !session) throw new Error("session organization mismatch");
    let cancellationSessionId: string | null = null;
    const result = (applied: boolean, reason?: string, reused?: boolean) => ({ applied, reason, reused, cancellationSessionId, revision: Number(p.presence_revision ?? 0), offerToken: p.offer_token ?? null, presence: structuredClone(p) });
    if (args.p_expected_revision != null && Number(p.presence_revision ?? 0) !== args.p_expected_revision ||
      args.p_expected_token != null && p.offer_token !== args.p_expected_token) return result(false, "stale_owner");
    const same = Boolean(sessionId && p.current_session_id === sessionId);
    const originalToken = p.offer_token;
    const effective = effectivePresenceStatus({ status: p.status as OperatorPresenceStatus, wrap_up_until: p.wrap_up_until as string | null, pause_return: p.pause_return }, db.now());
    let changedAt = db.nowIso();
    let status = String(p.status);
    let reason = p.pause_reason_id;
    let context = readPauseReturn(p.pause_return);
    let token = p.offer_token;
    if (action === "manual") {
      if (p.status === "on_call" && p.current_session_id) return result(false, "on_call");
      status = String(args.p_status); reason = args.p_pause_reason_id; context = null; token = null;
    } else if (action === "dispatch" || action === "pickup") {
      if (!session || ["ended", "failed"].includes(String(session.state))) return result(false, "session_ended");
      if (action === "pickup" && session.presence_pickup && (session.presence_pickup as FakeRow).profileId !== args.p_profile_id) return result(false, "pickup_owned");
      if (same && ["ringing", "on_call"].includes(status) && token) {
        if (action === "pickup" && !session.presence_pickup) {
          session.presence_pickup = { v: 1, profileId: args.p_profile_id, offerToken: token, requestedAt: db.nowIso(), expiresAt: new Date(db.now().getTime() + 60_000).toISOString() };
          return result(true, undefined, false);
        }
        return result(true, undefined, true);
      }
      if (p.current_session_id || !(effective === "available" || action === "pickup" && effective === "paused")) return result(false, "unavailable");
      token = randomUUID().replaceAll("-", "").slice(0, 12);
      if (action === "pickup" && effective === "paused") context = { v: 1, sessionId: String(sessionId), profileId: String(args.p_profile_id),
        pauseReasonId: (p.pause_reason_id ?? context?.pauseReasonId ?? null) as string | null, pausedSince: String(p.status_since), ownerToken: String(token) };
      if (action === "pickup") session.presence_pickup = { v: 1, profileId: args.p_profile_id, offerToken: token, requestedAt: db.nowIso(), expiresAt: new Date(db.now().getTime() + 60_000).toISOString() };
      status = "ringing";
    } else if (action === "answer") {
      if (token && args.p_expected_token == null) return result(false, "not_owner");
      if (!same || !["ringing", "on_call"].includes(status) || !session || ["ended", "failed"].includes(String(session.state)) || token && (session.presence_cancellations as FakeRow ?? {})[String(token)]) return result(false, "not_owner");
      if (status === "on_call") return result(true, undefined, true);
      status = "on_call";
    } else if (action === "release") {
      if (!same) return result(false, "not_owner");
      status = String(args.p_status);
      const activeWrapUp = status === "after_call_work" && args.p_wrap_up_until && Date.parse(String(args.p_wrap_up_until)) > db.now().getTime();
      if (context && context.ownerToken === token && context.sessionId === sessionId && !activeWrapUp) { status = "paused"; reason = context.pauseReasonId; context = null; }
      else if (status === "after_call_work" && !activeWrapUp) status = "available";
      if (!context) token = null;
    } else if (action === "end_wrap_up") {
      if (status !== "after_call_work") return result(false, "not_wrap_up");
      if (args.p_source === "cron") {
        if (p.wrap_up_until && Date.parse(String(p.wrap_up_until)) > db.now().getTime()) return result(false, "not_due");
        changedAt = String(p.wrap_up_until ?? p.status_since);
      }
      status = context && context.ownerToken === token ? "paused" : "available";
      reason = context?.pauseReasonId; context = null; token = null;
    } else throw new Error("invalid presence action");
    if (["manual", "release"].includes(String(action)) && p.status === "ringing" && session) {
        cancellationSessionId = String(sessionId);
        session.cancellations_next_attempt_at = db.nowIso();
        session.presence_cancellations = { ...(session.presence_cancellations as FakeRow ?? {}), [String(p.offer_token ?? `legacy:${args.p_profile_id}`)]:
          { profileId: args.p_profile_id, requestedAt: db.nowIso(), reason: "manual_presence" } };
        for (const a of db.storage("motorist_ring_attempts")) {
          if (a.session_id === sessionId && a.profile_id === args.p_profile_id && ["pending", "offered"].includes(String(a.result))) Object.assign(a, { result: "cancelled", ended_at: db.nowIso() });
        }
      }

    if (["manual", "release"].includes(String(action)) && session && (session.presence_pickup as FakeRow)?.offerToken === originalToken) session.presence_pickup = null;
    Object.assign(p, { status, current_session_id: ["dispatch", "pickup", "answer"].includes(String(action)) ? sessionId : null,
      pause_reason_id: status === "paused" ? reason ?? null : context?.pauseReasonId ?? null, pause_return: context, offer_token: token,
      wrap_up_until: status === "after_call_work" ? args.p_wrap_up_until : null, presence_revision: Number(p.presence_revision ?? 0) + 1,
      status_since: changedAt, updated_at: db.nowIso() });
    for (const h of db.storage("motorist_operator_statuses")) if (h.organization_id === args.p_organization_id && h.profile_id === args.p_profile_id && !h.ended_at) h.ended_at = changedAt;
    db.insert("motorist_operator_statuses", { organization_id: args.p_organization_id, profile_id: args.p_profile_id, status,
      reason: status === "paused" && action !== "manual" ? db.find("motorist_pause_reasons", r => r.id === p.pause_reason_id)?.label ?? args.p_reason ?? null : args.p_reason ?? db.find("motorist_pause_reasons", r => r.id === p.pause_reason_id)?.label ?? null,
      source: args.p_source ?? "telephony", started_at: changedAt, ended_at: null });
    return result(true);
  });
}
