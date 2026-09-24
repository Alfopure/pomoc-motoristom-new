import { describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { reconcileTermination } from "./termination";
import { SessionLeaseLostError } from "./service-errors";
import { sessionOwnership, type Ownership } from "./ownership";
import { TelnyxCommandError, type TelnyxClient } from "./telnyx/client";

type Leg = { commandId: string; callControlId: string };
const DEFAULT_LEGS: Leg[] = [{ commandId: "dial-a", callControlId: "leg-a" }, { commandId: "dial-b", callControlId: "leg-b" }];

function harness(failure?: Error, legs: Leg[] = DEFAULT_LEGS) {
  const fake = createFakeSupabase({ now: () => new Date("2026-09-21T17:21:00.000Z") });
  const { db } = fake;
  const completed = new Set<string>();
  db.registerRpc("motorist_provider_termination_legs_v2", () => legs.filter(row => !completed.has(row.commandId)));
  db.registerRpc("motorist_provider_termination_checkpoint_v2", (args) => {
    for (const id of args.p_completed_commands as string[]) completed.add(id);
    return { pending: completed.size !== legs.length };
  });
  const hangup = vi.fn(async ({ callControlId }: { callControlId: string }) => {
    if (callControlId === legs[0].callControlId && failure) throw failure;
    return { status: "executed" };
  });
  const logger = vi.fn();
  return { db, completed, hangup, logger, deps: { admin: fake.admin, organizationId: "org",
    telnyx: { hangup } as unknown as TelnyxClient, logger } };
}

const hungUp = (h: ReturnType<typeof harness>) => h.hangup.mock.calls.map(([input]) => input.callControlId);
const evidenceReads = (h: ReturnType<typeof harness>) =>
  h.db.log.filter(entry => entry.kind === "query" && ["motorist_provider_commands", "motorist_telnyx_webhook_events"].includes(entry.table));
const owner = (h: ReturnType<typeof harness>): Ownership => ({ admin: h.deps.admin, sessionId: "session", organizationId: "org", token: "t",
  generation: 1, contract: 2, deadline: Date.now() + 24_000, acquiredAt: 0 });

/** A received `call.hangup` for the leg, whatever the ledger did with it. */
function ledgerHangup(h: ReturnType<typeof harness>, callControlId: string, row: Record<string, unknown> = {}) {
  h.db.insert("motorist_telnyx_webhook_events", { organization_id: "org", event_id: `h-${callControlId}`, event_type: "call.hangup",
    status: "failed", retry_state: "deferred", call_control_id: callControlId, received_at: h.db.nowIso(), occurred_at: h.db.nowIso(), payload: {}, ...row });
}

/** A journalled `/actions/hangup` for the leg, encoded the way the client writes it. */
function journalHangup(h: ReturnType<typeof harness>, callControlId: string, row: Record<string, unknown> = {}) {
  h.db.insert("motorist_provider_commands", { session_id: "session", command_id: `earlier-hangup-${callControlId}`, fingerprint: "f", method: "POST",
    path: `/calls/${encodeURIComponent(callControlId)}/actions/hangup`, outcome: "accepted", http_status: 200, ...row });
}

describe("durable termination cleanup", () => {
  it("continues another accepted leg when the first hangup has an unknown result", async () => {
    const h = harness(new Error("accepted hangup response lost"));
    expect(await reconcileTermination(h.deps, "session")).toBe(true);
    expect(h.hangup.mock.calls.map(([input]) => input.callControlId)).toEqual(["leg-a", "leg-b"]);
    expect([...h.completed]).toEqual(["dial-b"]);
    // A future pass retains only the unresolved obligation; the accepted B
    // result/checkpoint prevents another physical command for B.
    h.hangup.mockClear();
    expect(await reconcileTermination(h.deps, "session")).toBe(true);
    expect(h.hangup.mock.calls.map(([input]) => input.callControlId)).toEqual(["leg-a"]);
  });

  it("dispatches the legs together under contract 2 instead of one behind the other", async () => {
    const h = harness();
    let inFlight = 0; let peak = 0;
    h.hangup.mockImplementation(async () => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return { status: "executed" };
    });

    const owner: Ownership = { admin: h.deps.admin, sessionId: "session", organizationId: "org", token: "t",
      generation: 1, contract: 2, deadline: Date.now() + 24_000, acquiredAt: 0 };
    expect(await sessionOwnership.run(owner, () => reconcileTermination(h.deps, "session"))).toBe(false);

    // The customer's leg no longer waits behind an operator leg whose provider
    // response is still outstanding.
    expect(peak).toBe(2);
    expect([...h.completed].sort()).toEqual(["dial-a", "dial-b"]);
  });

  it("keeps a leg with an unknown result from blocking the other under contract 2", async () => {
    const h = harness(new Error("accepted hangup response lost"));
    const owner: Ownership = { admin: h.deps.admin, sessionId: "session", organizationId: "org", token: "t",
      generation: 1, contract: 2, deadline: Date.now() + 24_000, acquiredAt: 0 };

    expect(await sessionOwnership.run(owner, () => reconcileTermination(h.deps, "session"))).toBe(true);

    expect(h.hangup.mock.calls.map(([input]) => input.callControlId).sort()).toEqual(["leg-a", "leg-b"]);
    expect([...h.completed]).toEqual(["dial-b"]);
  });

  it("still reports a lost lease under contract 2, with nothing checkpointed", async () => {
    const h = harness(new SessionLeaseLostError());
    const owner: Ownership = { admin: h.deps.admin, sessionId: "session", organizationId: "org", token: "t",
      generation: 1, contract: 2, deadline: Date.now() + 24_000, acquiredAt: 0 };

    await expect(sessionOwnership.run(owner, () => reconcileTermination(h.deps, "session")))
      .rejects.toBeInstanceOf(SessionLeaseLostError);

    // Both were already in flight, but `prepare_v2` fences each on its own
    // generation, so a command from a lease we no longer hold never reaches the
    // provider. Nothing is recorded as done.
    expect(h.completed.size).toBe(0);
  });

  it("aborts later commands after lease loss", async () => {
    const h = harness(new SessionLeaseLostError());
    await expect(reconcileTermination(h.deps, "session")).rejects.toBeInstanceOf(SessionLeaseLostError);
    expect(h.hangup).toHaveBeenCalledTimes(1);
    expect(h.completed.size).toBe(0);
  });

  it("accepts explicit call-gone evidence but retains an unexplained HTTP 404", async () => {
    const gone = harness(new TelnyxCommandError({ code: "90018", status: 422 }));
    expect(await reconcileTermination(gone.deps, "session")).toBe(false);
    const missing = harness(new TelnyxCommandError({ code: "http_404", status: 404 }));
    expect(await reconcileTermination(missing.deps, "session")).toBe(true);
    expect([...missing.completed]).toEqual(["dial-b"]);
  });

  it("clears the retry obligation after all exact legs have confirmed cleanup", async () => {
    const h = harness();
    expect(await reconcileTermination(h.deps, "session")).toBe(false);
    expect(await reconcileTermination(h.deps, "session")).toBe(false);
    expect(h.hangup).toHaveBeenCalledTimes(2);
  });

  // M19: 10 of the incident's 11 termination-compensation hangups hit legs the
  // provider had ended more than 5 s earlier and came back 422/90018. The
  // provider's own word — a received `call.hangup` or an accepted hangup it
  // answered — retires the obligation without another command.
  it.each([
    { status: "failed", retry_state: "deferred" },
    { status: "processed", retry_state: null },
    { status: "failed", retry_state: "dead_letter" },
  ])("does not re-hang a leg whose call.hangup is already in the ledger (%o)", async (row) => {
    const h = harness();
    ledgerHangup(h, "leg-a", row);

    expect(await reconcileTermination(h.deps, "session")).toBe(false);

    // What we did with the row does not change that the leg ended.
    expect(hungUp(h)).toEqual(["leg-b"]);
    expect([...h.completed].sort()).toEqual(["dial-a", "dial-b"]);
    expect(h.logger).toHaveBeenCalledWith(expect.objectContaining({ code: "termination_legs_provider_ended", count: 1 }));
  });

  it("does not re-hang a leg with an accepted hangup in the journal", async () => {
    const h = harness();
    journalHangup(h, "leg-a");
    // A rejected hangup is not the provider confirming the end of the leg…
    journalHangup(h, "leg-b", { command_id: "rejected-hangup", outcome: "rejected", http_status: 422 });
    // …and another session's accepted hangup is about another session's leg.
    journalHangup(h, "leg-b", { command_id: "other-session-hangup", session_id: "other" });

    expect(await reconcileTermination(h.deps, "session")).toBe(false);

    expect(hungUp(h)).toEqual(["leg-b"]);
    expect([...h.completed].sort()).toEqual(["dial-a", "dial-b"]);
    expect(h.logger).toHaveBeenCalledWith(expect.objectContaining({ code: "termination_legs_provider_ended", count: 1 }));
  });

  it("matches the journal on the encoded path the client writes", async () => {
    const h = harness(undefined, [{ commandId: "dial-a", callControlId: "v3:leg-a" }, { commandId: "dial-b", callControlId: "v3:leg-b" }]);
    journalHangup(h, "v3:leg-a");
    expect(h.db.rows("motorist_provider_commands")[0].path).toBe("/calls/v3%3Aleg-a/actions/hangup");

    expect(await reconcileTermination(h.deps, "session")).toBe(false);

    expect(hungUp(h)).toEqual(["v3:leg-b"]);
    expect([...h.completed].sort()).toEqual(["dial-a", "dial-b"]);
  });

  it("still hangs up a leg with no provider evidence", async () => {
    const h = harness();
    // App-side `ended_at` is not the provider speaking (M19): a synthetic close
    // from a step timeout must not stop the compensation hangup.
    h.db.insert("motorist_call_legs", { organization_id: "org", session_id: "session", telnyx_call_control_id: "leg-a",
      role: "operator", state: "ended", ended_at: h.db.nowIso(), hangup_cause: "step_timeout" });

    expect(await reconcileTermination(h.deps, "session")).toBe(false);

    expect(hungUp(h)).toEqual(["leg-a", "leg-b"]);
    expect([...h.completed].sort()).toEqual(["dial-a", "dial-b"]);
    expect(h.logger).not.toHaveBeenCalledWith(expect.objectContaining({ code: "termination_legs_provider_ended" }));
  });

  it("falls back to hanging up everything when an evidence read fails", async () => {
    const h = harness();
    ledgerHangup(h, "leg-a");
    h.db.failNext("motorist_provider_commands", "select", "unavailable");

    expect(await reconcileTermination(h.deps, "session")).toBe(false);

    // Today's behaviour is the fallback: an unreadable journal must not leave
    // a leg ringing, even one the ledger already reports as ended.
    expect(hungUp(h)).toEqual(["leg-a", "leg-b"]);
    expect([...h.completed].sort()).toEqual(["dial-a", "dial-b"]);
    expect(h.logger).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", code: "termination_evidence_unavailable" }));
    expect(evidenceReads(h).some(entry => entry.table === "motorist_provider_commands")).toBe(true);
  });

  it("reads no evidence when the journal lists no leg", async () => {
    const h = harness(undefined, []);

    expect(await reconcileTermination(h.deps, "session")).toBe(false);

    expect(h.hangup).not.toHaveBeenCalled();
    expect(evidenceReads(h)).toEqual([]);
    expect(h.db.log.map(entry => entry.table)).toEqual(["motorist_provider_termination_legs_v2", "motorist_provider_termination_checkpoint_v2"]);
  });

  it("reads the two evidence tables in one round under contract 2", async () => {
    const h = harness();
    ledgerHangup(h, "leg-a");
    let readsBeforeHangup = -1;
    h.hangup.mockImplementation(async () => { readsBeforeHangup = evidenceReads(h).length; return { status: "executed" }; });

    expect(await sessionOwnership.run(owner(h), () => reconcileTermination(h.deps, "session"))).toBe(false);

    expect(hungUp(h)).toEqual(["leg-b"]);
    expect([...h.completed].sort()).toEqual(["dial-a", "dial-b"]);
    // Both reads were issued before the first command went out.
    expect(readsBeforeHangup).toBe(2);
    expect(evidenceReads(h)).toHaveLength(2);
  });
});
