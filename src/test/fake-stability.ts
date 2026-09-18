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
export function registerProviderJournalRpcs(db: FakeDatabase): void {
  const session = (id: unknown) => db.storage("motorist_call_sessions").find((row) => row.id === id);
  // `20260929200000:227-230`: once a termination is committed the journal
  // refuses every new provider command except teardown.
  const TEARDOWN = /\/(hangup|record_stop|leave|stop)$/;
  db.registerRpc("motorist_provider_command_prepare_v2", (args) => {
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
