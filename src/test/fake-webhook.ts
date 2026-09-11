import type { FakeDatabase, FakeRow } from "./fake-supabase";

const TABLE = "motorist_telnyx_webhook_events";
const ms = (value: unknown) => typeof value === "string" ? Date.parse(value) : 0;

/** Workflow fake only; PostgreSQL contract tests independently verify locks and writer fences. */
export function registerWebhookRpcs(db: FakeDatabase): void {
  db.registerRpc("motorist_telnyx_claim_webhook_event_v2", (args) => {
    const now = db.now().getTime();
    let row = db.storage(TABLE).find((item) => item.event_id === args.p_event_id);
    if (!row) {
      row = { event_id: args.p_event_id, event_type: args.p_event_type, organization_id: args.p_organization_id,
        call_session_id: args.p_call_session_id ?? null, call_leg_id: args.p_call_leg_id ?? null,
        call_control_id: args.p_call_control_id ?? null, connection_id: args.p_connection_id ?? null,
        payload: args.p_payload, occurred_at: args.p_occurred_at ?? null, received_at: db.nowIso(),
        status: "queued", attempts: 0, claimed_at: null, processed_at: null, error: null, contract_version: 2,
        delivery_count: 0, deferral_count: 0, effect_failure_count: 0, retry_state: "ready", next_attempt_at: null, terminal_reason: null };
      db.storage(TABLE).push(row);
    }
    if (row.organization_id && row.organization_id !== args.p_organization_id) throw new Error("Webhook organization mismatch");
    if (row.event_type !== args.p_event_type || (row.call_control_id && row.call_control_id !== args.p_call_control_id) || (row.connection_id && row.connection_id !== args.p_connection_id)) throw new Error("Webhook identity mismatch");
    row.delivery_count = Number(row.delivery_count ?? 0) + (args.p_delivery === false ? 0 : 1);
    let outcome: string;
    if (row.status === "processed") outcome = "duplicate";
    else if (row.retry_state === "dead_letter") outcome = "terminal";
    else if (ms(row.claimed_at) > now - Math.max(1000, Number(args.p_stale_after_ms ?? 30000))) outcome = "busy";
    else if (row.retry_state === "awaiting_correlation" && ms(row.received_at) <= now - 60_000) {
      Object.assign(row, { contract_version: 2, status: "failed", retry_state: "dead_letter", terminal_reason: "awaiting_correlation_expired", claimed_at: null, next_attempt_at: null });
      outcome = "terminal";
    } else if (ms(row.next_attempt_at) > now && !(args.p_correlation && row.retry_state === "awaiting_correlation")) outcome = "busy";
    else {
      Object.assign(row, { contract_version: 2, organization_id: row.organization_id ?? args.p_organization_id,
        claimed_at: new Date(Math.max(now, ms(row.claimed_at) + 1)).toISOString(), attempts: Number(row.attempts ?? 0) + 1,
        payload: row.payload ?? args.p_payload, next_attempt_at: null });
      outcome = "claimed";
    }
    return [{ outcome, event_status: row.status, event_attempts: row.attempts, event_claimed_at: row.claimed_at,
      event_received_at: row.received_at, event_retry_state: row.retry_state ?? "ready", event_terminal_reason: row.terminal_reason ?? null }];
  });
  db.registerRpc("motorist_telnyx_finish_webhook_event_v2", (args) => {
    const row = db.storage(TABLE).find((item) => item.event_id === args.p_event_id && item.claimed_at === args.p_claimed_at && item.contract_version === 2);
    if (!row || !args.p_claimed_at || row.status === "processed" || row.retry_state === "dead_letter") return false;
    const result = args.p_result;
    const now = db.now().getTime();
    const failures = Number(row.effect_failure_count ?? 0);
    const deferrals = Number(row.deferral_count ?? 0);
    const terminal = result === "awaiting_correlation" && ms(row.received_at) <= now - 60_000 ? "awaiting_correlation_expired"
      : result === "failed" && failures + 1 >= 5 ? "effect_failure_limit"
        : result === "deferred" && ms(row.received_at) <= now - 86_400_000 ? "deferral_age_limit" : null;
    const delay = result === "failed" ? Math.min(120_000, 30_000 * 2 ** Math.min(failures, 2)) : Math.min(5000, 500 * 2 ** Math.min(deferrals, 4));
    Object.assign(row, { status: result === "processed" ? "processed" : "failed", processed_at: result === "processed" ? db.nowIso() : null,
      claimed_at: null, error: result === "processed" ? null : String(args.p_error ?? "").slice(0, 2000),
      deferral_count: deferrals + (result === "deferred" || result === "awaiting_correlation" ? 1 : 0),
      effect_failure_count: failures + (result === "failed" ? 1 : 0),
      retry_state: terminal ? "dead_letter" : result === "processed" || result === "failed" ? "ready" : result,
      terminal_reason: terminal, next_attempt_at: terminal || result === "processed" ? null : new Date(now + delay).toISOString() } satisfies FakeRow);
    return true;
  });
}
