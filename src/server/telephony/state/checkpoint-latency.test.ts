import { describe, expect, it } from "vitest";
import { createTelephonyHarness, ORG } from "@/test/telephony-harness";
import { sessionOwnership, type Ownership } from "../ownership";
import { effectsDeps } from "../session-runner";
import { checkpointEffects, readPendingEffects, type EffectContinuation } from "./continuation";
import { emptyTransition, toJson, type SessionRow } from "./types";

function fixture() {
  const h = createTelephonyHarness({ sweepAfterEvent: false });
  const entry: EffectContinuation = {
    id: "effect", generation: 0, createdAt: h.now().toISOString(),
    event: { kind: "app", type: "sweep", id: "effect", actorProfileId: null, occurredAt: h.now().toISOString() },
    stateBefore: "received", previousConferenceId: null, branch: "main", transition: emptyTransition(), commands: [],
    compensations: [], databaseCursor: 0, completedCommands: [], attempts: 0, lastError: null, auditComplete: false,
  };
  const [row] = h.db.insert("motorist_call_sessions", { organization_id: ORG, direction: "inbound", state: "received",
    writer_contract: 2, version: 4, pending_effects: toJson({ version: 1, entries: [entry] }) });
  const known = structuredClone(row) as SessionRow;
  const owner: Ownership = { admin: h.admin, organizationId: ORG, sessionId: known.id, contract: 2,
    token: "owner", generation: 1, deadline: Date.now() + 24_000, acquiredAt: 0 };
  const checkpoint = (snapshot = known, ownership: Ownership | null = owner) => {
    const run = () => checkpointEffects(effectsDeps(h.deps), known.id, { ...entry, databaseCursor: 1 }, entry.id, snapshot);
    return ownership ? sessionOwnership.run(ownership, run) : run();
  };
  return { h, known, owner, entry, checkpoint };
}

describe("fenced checkpoint latency", () => {
  it("uses the returned owned row for one fenced compare-and-set instead of reading it again", async () => {
    const t = fixture();
    const updated = await t.checkpoint();
    expect(t.h.db.log.filter(row => row.table === "motorist_call_sessions").map(row => row.operation)).toEqual(["update"]);
    expect(updated.version).toBe(5);
    expect(readPendingEffects(updated).entries[0].databaseCursor).toBe(1);
  });

  it("falls back after stale CAS and preserves another newly queued obligation", async () => {
    const t = fixture();
    const other = { ...t.entry, id: "later-effect" };
    t.h.db.update("motorist_call_sessions", { version: 5, pending_effects: toJson({ version: 1, entries: [t.entry, other] }) }, row => row.id === t.known.id);
    const updated = await t.checkpoint();
    expect(t.h.db.log.filter(row => row.table === "motorist_call_sessions").map(row => row.operation)).toEqual(["update", "select", "update"]);
    expect(readPendingEffects(updated).entries).toEqual([{ ...t.entry, databaseCursor: 1 }, other]);
    expect(updated.version).toBe(6);
  });

  it("does not resurrect an entry that a newer version has completed", async () => {
    const t = fixture();
    t.h.db.update("motorist_call_sessions", { version: 5, pending_effects: null }, row => row.id === t.known.id);
    const updated = await t.checkpoint();
    expect(updated.version).toBe(5);
    expect(readPendingEffects(updated).entries).toEqual([]);
    expect(t.h.db.log.filter(row => row.table === "motorist_call_sessions").map(row => row.operation)).toEqual(["update", "select"]);
  });

  it("preserves a concurrent termination flag written without changing the queue version", async () => {
    const t = fixture();
    const terminatedAt = t.h.now().toISOString();
    t.h.db.update("motorist_call_sessions", { termination_requested_at: terminatedAt, termination_next_attempt_at: terminatedAt }, row => row.id === t.known.id);
    const updated = await t.checkpoint();
    expect(updated).toMatchObject({ termination_requested_at: terminatedAt, termination_next_attempt_at: terminatedAt, version: 5 });
  });

  it.each(["missing", "wrong-session", "compatibility", "different-admin"] as const)("retains fresh reads for %s ownership", async kind => {
    const t = fixture();
    const owner = kind === "missing" ? null : { ...t.owner,
      ...(kind === "wrong-session" ? { sessionId: "different-session" } : {}),
      ...(kind === "compatibility" ? { contract: 1 } : {}),
      ...(kind === "different-admin" ? { admin: createTelephonyHarness().admin } : {}),
    };
    await t.checkpoint(t.known, owner);
    expect(t.h.db.log.filter(row => row.table === "motorist_call_sessions").map(row => row.operation)).toEqual(["select", "update"]);
  });

  it("reads the current queue when the supplied snapshot has no matching entry", async () => {
    const t = fixture();
    await t.checkpoint({ ...t.known, pending_effects: null });
    expect(t.h.db.log.filter(row => row.table === "motorist_call_sessions").map(row => row.operation)).toEqual(["select", "update"]);
  });

  it("does not retry or bypass a rejected fenced update", async () => {
    const t = fixture();
    t.h.db.failNext("motorist_call_sessions", "update", { code: "PT409", message: "telephony ownership lost", details: null, hint: null });
    await expect(t.checkpoint()).rejects.toThrow("telephony ownership lost");
    expect(readPendingEffects(t.h.session(t.known.id) as SessionRow).entries[0].databaseCursor).toBe(0);
    expect(t.h.db.log.filter(row => row.table === "motorist_call_sessions")).toHaveLength(1);
  });
});
