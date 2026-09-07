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
