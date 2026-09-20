import { sessionOwnership } from "@/server/telephony/ownership";
import type { FakeDatabase, FakeRow } from "./fake-supabase";

/** Workflow adapter; locking and transaction boundaries are tested in PostgreSQL. */
export function registerStabilityRpcs(db: FakeDatabase): void {
  db.registerRpc("motorist_stage_transition_v1", async (args) => {
    const session = db.storage("motorist_call_sessions").find((row) => row.id === args.p_session_id && row.organization_id === args.p_organization_id);
    if (!session) throw new Error("session not found");
    const main = args.p_main as { sessionPatch: FakeRow; entry: FakeRow };
    const previous = session.pending_effects as { version: 1; entries: FakeRow[] } | null;
    if (previous?.entries.some((entry) => entry.id === main.entry.id)) return { applied: true, session: structuredClone(session) };
    if (session.version !== args.p_expected_version) return { applied: false };
    let choice = main;
    const guard = args.p_guard as { profileId: string; offerToken?: string } | null;
    if (guard) {
      const handler = db.rpcHandlers.get("motorist_presence_transition_v1")!;
      const reservation = await handler({ p_organization_id: args.p_organization_id, p_session_id: args.p_session_id, p_profile_id: guard.profileId,
        p_expected_token: guard.offerToken, p_action: "answer" }, db) as { applied: boolean };
      if (!reservation.applied) choice = args.p_rejected as typeof main;
    }
    Object.assign(session, structuredClone(choice.sessionPatch), { version: Number(session.version) + 1,
      pending_effects: { version: 1, entries: [...(previous?.entries ?? []), structuredClone(choice.entry)] }, effects_next_attempt_at: db.nowIso() });
    return { applied: true, session: structuredClone(session) };
  });
}

/**
 * Contract 2: generation leases and the fenced provider journal. Production has
 * run on this since 12 Sep, so the deduplications that are gated on it — the
 * reused checkpoint row, the reused session row — are only reachable in a test
 * that registers these. The locking and the fence triggers themselves are
 * tested in PostgreSQL; this is the workflow adapter.
 */
export function registerContractTwoRpcs(db: FakeDatabase): void {
  const session = (id: unknown) => db.storage("motorist_call_sessions").find((row) => row.id === id);
  const held = (row: FakeRow, args: Record<string, unknown>) =>
    row.lease_token === args.p_token && Number(row.lease_generation ?? 0) === Number(args.p_generation);

  db.registerRpc("motorist_session_lease_acquire_v2", (args) => {
    const row = session(args.p_session_id);
    if (!row) return null;
    const nowMs = db.now().getTime();
    const until = row.lease_until ? Date.parse(String(row.lease_until)) : null;
    if (until !== null && until >= nowMs && row.lease_token !== args.p_token) return null;
    const ttl = Math.max(250, Math.min(Number(args.p_ttl_ms ?? 15_000), 30_000));
    row.lease_token = String(args.p_token);
    row.lease_until = new Date(nowMs + ttl).toISOString();
    row.lease_generation = Number(row.lease_generation ?? 0) + 1;
    return { generation: row.lease_generation, contract: 2 };
  });

  db.registerRpc("motorist_session_lease_renew_v2", (args) => {
    const row = session(args.p_session_id);
    if (!row || !held(row, args)) return false;
    row.lease_until = new Date(db.now().getTime() + Math.max(250, Number(args.p_ttl_ms ?? 15_000))).toISOString();
    return true;
  });

  db.registerRpc("motorist_session_lease_release_v2", (args) => {
    const row = session(args.p_session_id);
    if (!row || !held(row, args)) return false;
    row.lease_token = null;
    row.lease_until = null;
    return true;
  });

  db.registerRpc("motorist_session_terminate_v2", (args) => {
    const row = session(args.p_session_id);
    if (!row) return false;
    row.termination_requested_at = row.termination_requested_at ?? db.nowIso();
    return true;
  });

  registerCriticalWriteRpcs(db);
  registerProviderJournalRpcs(db);
}

/**
 * The fenced provider journal: `prepare_v2` before every voice command and
 * `result_v2` after it.
 *
 * Split out from the lease RPCs because a test may want its own lease
 * behaviour — contention tests hand-build theirs — and still needs the journal,
 * since the provider double now goes through it exactly as the real client
 * does. Registering the leases without these leaves every command failing on a
 * missing function.
 */
/**
 * `motorist_telephony_fence`, as the double can see it.
 *
 * In production the fence compares request headers against the session row.
 * Those headers are written from the ambient owner in
 * `telephonyDatabaseFetch`, and the double never goes through HTTP — so the
 * ambient owner *is* the header content, and comparing it is the same
 * comparison the database makes.
 *
 * Without this the double let an old owner keep working after a takeover, and
 * the only thing refusing them was the lease renew. Every guarantee resting on
 * the fence was therefore untestable, and a renew that is pure duplication
 * could not be removed because nothing else could be shown to refuse.
 */
export function fenceSession(db: FakeDatabase, sessionId: unknown): void {
  const row = db.storage("motorist_call_sessions").find((entry) => entry.id === sessionId);
  if (!row || Number(row.writer_contract ?? 1) !== 2) return;
  const owner = sessionOwnership.getStore();
  const live = row.lease_token && row.lease_until && Date.parse(String(row.lease_until)) > db.now().getTime();
  const held = Boolean(owner) && owner!.sessionId === row.id && owner!.token === row.lease_token &&
    Number(owner!.generation) === Number(row.lease_generation ?? 0);
  if (!live || !held) {
    throw { code: "PT409", message: "telephony ownership lease or writer contract rejected", details: null, hint: null };
  }
}

export function registerProviderJournalRpcs(db: FakeDatabase): void {
  const session = (id: unknown) => db.storage("motorist_call_sessions").find((row) => row.id === id);
  // `20260929200000:227-230`: once a termination is committed the journal
  // refuses every new provider command except teardown.
  const TEARDOWN = /\/(hangup|record_stop|leave|stop)$/;
  db.registerRpc("motorist_provider_command_prepare_v2", (args) => {
    fenceSession(db, args.p_session_id);
    const row = session(args.p_session_id);
    if (!row) throw Object.assign(new Error("session not found"), { code: "PT409" });
    const terminal = Boolean(row.termination_requested_at) || Boolean(row.ended_at) || ["ended", "failed"].includes(String(row.state));
    if (terminal && !TEARDOWN.test(String(args.p_path))) {
      throw { code: "PT409", message: "telephony termination blocks new provider command", details: null, hint: null };
    }
    const journal = (db.storage("motorist_provider_commands") ?? []);
    const existing = journal.find((entry) => entry.command_id === args.p_command_id);
    if (existing && existing.fingerprint === args.p_fingerprint && existing.outcome) {
      return { dispatch: false, outcome: String(existing.outcome), result: existing.result, http_status: Number(existing.http_status ?? 200) };
    }
    if (!existing) db.insert("motorist_provider_commands", { session_id: args.p_session_id, command_id: args.p_command_id,
      fingerprint: args.p_fingerprint, method: args.p_method, path: args.p_path, outcome: null, http_status: null, result: null });
    return { dispatch: true };
  });

  // Evidence reconciliation, dial observation and termination compensation have
  // their own tests with a hand-built owner scope. Here they answer "nothing
  // outstanding" so the ordinary happy path can run end to end.
  db.registerRpc("motorist_provider_pending_commands_v2", () => []);
  db.registerRpc("motorist_provider_observe_dial_v2", () => true);
  db.registerRpc("motorist_provider_termination_legs_v2", () => []);
  db.registerRpc("motorist_provider_termination_checkpoint_v2", () => ({ pending: false }));
  db.registerRpc("motorist_provider_command_lookup_v2", (args) => {
    const entry = db.storage("motorist_provider_commands").find((row) => row.command_id === args.p_command_id);
    return entry?.outcome ? { outcome: String(entry.outcome) } : null;
  });

  // The same two functions over an array: one fence, one pass, a decision per
  // command. What a caller that already holds the whole group reaches for.
  db.registerRpc("motorist_provider_command_prepare_batch_v2", (args) => {
    const single = db.rpcHandlers.get("motorist_provider_command_prepare_v2")!;
    const items = (args.p_commands ?? []) as Array<Record<string, unknown>>;
    return items.map((item) => single({
      p_session_id: args.p_session_id, p_command_id: item.command_id, p_fingerprint: item.fingerprint,
      p_method: item.method, p_path: item.path, p_correlation_state: item.correlation_state, p_payload: item.payload,
    }, db));
  });

  db.registerRpc("motorist_provider_command_result_batch_v2", (args) => {
    const single = db.rpcHandlers.get("motorist_provider_command_result_v2")!;
    const items = (args.p_results ?? []) as Array<Record<string, unknown>>;
    return items.map((item) => single({
      p_session_id: args.p_session_id, p_command_id: item.command_id, p_fingerprint: item.fingerprint,
      p_generation: args.p_generation, p_token: args.p_token, p_status: item.status,
      p_result: item.result, p_retry_after_ms: item.retry_after_ms,
    }, db));
  });

  db.registerRpc("motorist_provider_command_result_v2", (args) => {
    const entry = db.storage("motorist_provider_commands").find((row) => row.command_id === args.p_command_id);
    if (entry) {
      entry.outcome = Number(args.p_status) < 400 ? "accepted" : "rejected";
      entry.http_status = args.p_status;
      entry.result = args.p_result ?? null;
    }
    return true;
  });
}


/**
 * The critical row writes of a transition, in one call.
 *
 * Split out for the same reason the journal is: a test may hand-build its
 * leases and still need this, because the reducer reaches for it on every
 * contract-2 transition that touches a leg or an attempt.
 */
export function registerCriticalWriteRpcs(db: FakeDatabase): void {
  const session = (id: unknown) => db.storage("motorist_call_sessions").find((row) => row.id === id);
  db.registerRpc("motorist_apply_critical_v2", (args) => {
    const row = session(args.p_session_id);
    if (!row) throw new Error("session not found");
    if (args.p_expected_version !== null && args.p_expected_version !== undefined && row.version !== args.p_expected_version) {
      return { applied: false };
    }
    const patch = (args.p_patch ?? {}) as FakeRow;
    Object.assign(row, patch, { version: Number(args.p_expected_version ?? row.version) + 1 });

    for (const item of (args.p_legs ?? []) as Array<{ callControlId: string; values: FakeRow }>) {
      const leg = db.storage("motorist_call_legs").find((entry) => entry.session_id === row.id && entry.telnyx_call_control_id === item.callControlId);
      if (!leg) continue;
      const values = { ...item.values };
      // An ended leg keeps its ending: a late patch may add detail, never reopen.
      if (leg.ended_at && !("ended_at" in values)) { delete values.state; delete values.ended_at; }
      Object.assign(leg, values);
    }

    for (const item of (args.p_attempts ?? []) as Array<{ id: string; values: FakeRow; openOnly?: boolean }>) {
      const attempt = db.storage("motorist_ring_attempts").find((entry) => entry.id === item.id && entry.session_id === row.id);
      if (!attempt) continue;
      if (item.openOnly && attempt.ended_at) continue;
      Object.assign(attempt, item.values);
    }

    return { applied: true, session: structuredClone(row) };
  });

}
