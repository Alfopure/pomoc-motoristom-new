import { describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";

import { effectivePresenceStatus, endWrapUp, getPresence, PresenceServiceError, setPresence } from "./presence-service";

describe("presence service", () => {
  it("sets a pause with a reason and mirrors the change into the status history", async () => {
    const h = createTelephonyHarness();
    const deps = { admin: h.admin, now: () => h.now() };
    const paused = await setPresence(deps, { organizationId: ORG, profileId: PROFILES.o1, status: "paused", pauseReasonId: "00000000-0000-4000-8000-000000002501" });
    expect(paused).toMatchObject({ status: "paused", pause_reason_id: "00000000-0000-4000-8000-000000002501", current_session_id: null, status_since: h.now().toISOString() });

    h.advance(60_000);
    const back = await setPresence(deps, { organizationId: ORG, profileId: PROFILES.o1, status: "available", source: "api" });
    expect(back).toMatchObject({ status: "available", pause_reason_id: null });
    const history = h.rows("motorist_operator_statuses").filter((row) => row.profile_id === PROFILES.o1);
    expect(history.map((row) => [row.status, row.reason, row.source, Boolean(row.ended_at)])).toEqual([
      ["paused", "Obed", "dispatch_console", true],
      ["available", null, "api", false],
    ]);
    // No-op when nothing changes.
    await setPresence(deps, { organizationId: ORG, profileId: PROFILES.o1, status: "available" });
    expect(h.rows("motorist_operator_statuses").filter((row) => row.profile_id === PROFILES.o1)).toHaveLength(2);
  });

  it("creates a missing presence row and rejects invalid input", async () => {
    const h = createTelephonyHarness();
    const deps = { admin: h.admin, now: () => h.now() };
    h.db.delete("motorist_operator_presence", (row) => row.profile_id === PROFILES.o5);
    expect(await getPresence(deps, { organizationId: ORG, profileId: PROFILES.o5 })).toBeNull();
    await expect(setPresence(deps, { organizationId: ORG, profileId: PROFILES.o5, status: "offline" })).resolves.toMatchObject({ status: "offline" });
    await expect(setPresence(deps, { organizationId: ORG, profileId: PROFILES.o5, status: "paused", pauseReasonId: "00000000-0000-4000-8000-00000000dead" })).rejects.toMatchObject({ status: 400 });
    await expect(setPresence(deps, { organizationId: ORG, profileId: PROFILES.o5, status: "on_call" as never })).rejects.toBeInstanceOf(PresenceServiceError);
  });

  it("refuses manual changes during a call but clears a stale ring pointer", async () => {
    const h = createTelephonyHarness();
    const deps = { admin: h.admin, now: () => h.now() };
    h.setPresence(PROFILES.o1, { status: "on_call", current_session_id: "00000000-0000-4000-8000-00000000ffff" });
    await expect(setPresence(deps, { organizationId: ORG, profileId: PROFILES.o1, status: "available" })).rejects.toMatchObject({ status: 409 });
    h.setPresence(PROFILES.o2, { status: "ringing", current_session_id: "00000000-0000-4000-8000-00000000ffff" });
    await expect(setPresence(deps, { organizationId: ORG, profileId: PROFILES.o2, status: "paused" })).resolves.toMatchObject({ status: "paused", current_session_id: null });
  });

  it("refuses a foreign session pointer without acquiring or changing it", async () => {
    const h = createTelephonyHarness();
    const sessionId = String(h.db.insert("motorist_call_sessions", { organization_id: "foreign-org", writer_contract: 2, state: "ringing" })[0].id);
    h.setPresence(PROFILES.o2, { status: "ringing", current_session_id: sessionId });
    const before = h.presence(PROFILES.o2);
    await expect(setPresence(h.deps, { organizationId: ORG, profileId: PROFILES.o2, status: "paused" })).rejects.toMatchObject({ status: 409 });
    expect(h.presence(PROFILES.o2)).toEqual(before);
    expect(h.db.log.filter(row => row.table === "motorist_session_lease_acquire_v2")).toEqual([]);
  });

  it("does not clear a new pointer that replaces a dangling pointer before the CAS", async () => {
    const h = createTelephonyHarness();
    const stale = "00000000-0000-4000-8000-00000000ffff";
    h.setPresence(PROFILES.o2, { status: "ringing", current_session_id: stale });
    const update = h.db.update.bind(h.db);
    const spy = vi.spyOn(h.db, "update").mockImplementation((table, patch, filter) => {
      if (table === "motorist_operator_presence" && patch.status === "paused") {
        update(table, { current_session_id: "new-owner" }, row => row.profile_id === PROFILES.o2);
      }
      return update(table, patch, filter);
    });
    try {
      await expect(setPresence(h.deps, { organizationId: ORG, profileId: PROFILES.o2, status: "paused" })).rejects.toMatchObject({ status: 409 });
      expect(h.presence(PROFILES.o2)).toMatchObject({ status: "ringing", current_session_id: "new-owner" });
    } finally { spy.mockRestore(); }
  });

  it("ends wrap-up early and treats an expired wrap-up as available", async () => {
    const h = createTelephonyHarness();
    const deps = { admin: h.admin, now: () => h.now() };
    const until = new Date(h.now().getTime() + 30_000).toISOString();
    h.setPresence(PROFILES.o1, { status: "after_call_work", wrap_up_until: until });
    expect(effectivePresenceStatus({ status: "after_call_work", wrap_up_until: until }, h.now())).toBe("after_call_work");
    h.advance(31_000);
    expect(effectivePresenceStatus({ status: "after_call_work", wrap_up_until: until }, h.now())).toBe("available");
    const ended = await endWrapUp(deps, { organizationId: ORG, profileId: PROFILES.o1 });
    expect(ended).toMatchObject({ status: "available", wrap_up_until: null });
    expect(h.rows("motorist_operator_statuses").at(-1)).toMatchObject({ profile_id: PROFILES.o1, status: "available", reason: "wrap-up ukončený" });
    await expect(endWrapUp(deps, { organizationId: ORG, profileId: PROFILES.o2 })).resolves.toMatchObject({ status: "available" });
  });
});
