import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import { sessionOwnership } from "./ownership";
import { endWrapUp, setPresence } from "./presence-service";
import { recoverOwnEndedSessionPresence } from "./presence-recovery";
import { closeOrphanLegs, closeStaleRingAttempts } from "./routing/ring-plan";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function harness() {
  vi.stubEnv("TELEPHONY_FENCING_V2_ENABLED", "false");
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
  const h = createTelephonyHarness();
  const claims: string[] = [];
  h.db.registerRpc("motorist_session_lease_acquire_v2", args => {
    expect(sessionOwnership.getStore()).toBeUndefined();
    claims.push(String(args.p_session_id));
    return { generation: claims.length, contract: 2 };
  });
  h.db.registerRpc("motorist_session_lease_release_v2", () => true);
  h.db.registerRpc("motorist_session_lease_renew_v2", () => true);
  const session = (state = "ended") => String(h.db.insert("motorist_call_sessions", { organization_id: ORG, writer_contract: 2, state, ended_at: state === "ended" ? h.now().toISOString() : null })[0].id);
  return { ...h, claims, newSession: session };
}

describe("standalone projection ownership", () => {
  it("manual cancellation and wrap-up completion write under their captured session owner", async () => {
    const h = harness();
    const sessionId = h.newSession("ringing");
    h.setPresence(PROFILES.o1, { status: "ringing", current_session_id: sessionId, offer_token: null });
    const owners: Array<string | undefined> = [];
    const update = h.db.update.bind(h.db);
    vi.spyOn(h.db, "update").mockImplementation((table, patch, filter) => {
      if (table === "motorist_operator_presence") owners.push(sessionOwnership.getStore()?.sessionId);
      return update(table, patch, filter);
    });
    await setPresence(h.deps, { organizationId: ORG, profileId: PROFILES.o1, status: "paused" });
    expect(owners).toEqual([sessionId]);
    expect(sessionOwnership.getStore()).toBeUndefined();
    h.setPresence(PROFILES.o1, { status: "after_call_work", current_session_id: sessionId, offer_token: null });
    owners.length = 0;
    await endWrapUp(h.deps, { organizationId: ORG, profileId: PROFILES.o1 });
    expect(owners).toEqual([sessionId]);
    expect(h.claims).toEqual([sessionId, sessionId]);
  });

  it("does not clear a different owner that appeared while waiting for the lease", async () => {
    const h = harness();
    const first = h.newSession("ringing");
    const replacement = h.newSession("ringing");
    h.setPresence(PROFILES.o1, { status: "ringing", current_session_id: first });
    h.db.registerRpc("motorist_session_lease_acquire_v2", () => {
      h.setPresence(PROFILES.o1, { status: "ringing", current_session_id: replacement });
      return { generation: 1, contract: 2 };
    });
    await expect(setPresence(h.deps, { organizationId: ORG, profileId: PROFILES.o1, status: "paused" })).rejects.toMatchObject({ status: 409 });
    expect(h.presence(PROFILES.o1).current_session_id).toBe(replacement);
  });

  it("rechecks ended sessions and releases presence inside ownership", async () => {
    const h = harness();
    const sessionId = h.newSession();
    h.setPresence(PROFILES.o1, { status: "ringing", current_session_id: sessionId, offer_token: null, presence_revision: 2 });
    h.db.registerRpc("motorist_presence_transition_v1", () => {
      expect(sessionOwnership.getStore()?.sessionId).toBe(sessionId);
      return { applied: true, presence: h.presence(PROFILES.o1) };
    });
    const result = await recoverOwnEndedSessionPresence(h.deps, PROFILES.o1);
    expect(result).toMatchObject({ scanned: 1, released: 1, errors: [] });
    expect(h.claims).toEqual([sessionId]);
  });

  it("orphan and stale-attempt sweeps release each session before owning the next", async () => {
    const h = harness();
    const ids = [h.newSession(), h.newSession()];
    for (const sessionId of ids) {
      h.db.insert("motorist_call_legs", { organization_id: ORG, session_id: sessionId, telnyx_call_control_id: `orphan:${sessionId}`, initiated_at: h.now().toISOString(), ended_at: null });
      h.db.insert("motorist_ring_attempts", { organization_id: ORG, session_id: sessionId, profile_id: null, result: "offered", offered_at: h.now().toISOString() });
    }
    const writtenOwners: string[] = [];
    const update = h.db.update.bind(h.db);
    vi.spyOn(h.db, "update").mockImplementation((table, patch, filter) => {
      if (table === "motorist_call_legs" || table === "motorist_ring_attempts") {
        const owner = sessionOwnership.getStore()?.sessionId;
        expect(owner).toBeTruthy();
        for (const row of h.db.rows(table).filter(filter)) expect(row.session_id).toBe(owner);
        writtenOwners.push(owner!);
      }
      return update(table, patch, filter);
    });
    expect(await closeOrphanLegs(h.admin, { organizationId: ORG, now: h.now() })).toHaveLength(2);
    expect(await closeStaleRingAttempts(h.admin, { organizationId: ORG, now: h.now() })).toHaveLength(2);
    expect(writtenOwners).toEqual([...ids, ...ids]);
    expect(h.claims).toEqual([...ids, ...ids]);
    expect(sessionOwnership.getStore()).toBeUndefined();
  });
});
