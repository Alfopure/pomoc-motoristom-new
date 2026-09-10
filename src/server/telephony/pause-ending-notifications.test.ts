import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";

const sendPauseEndingPush = vi.fn(async () => ({ sent: 1, failed: 0 }));
const pauseEndingNotificationEnabled = vi.fn(async (supabase: Parameters<typeof import("@/server/web-push").pauseEndingNotificationEnabled>[0], actor: Parameters<typeof import("@/server/web-push").pauseEndingNotificationEnabled>[1]) => {
  const result = await supabase.from("motorist_call_notification_preferences").select("pause_ending_enabled")
    .eq("organization_id", actor.organizationId).eq("profile_id", actor.profileId).maybeSingle();
  if (result.error) throw result.error;
  return result.data?.pause_ending_enabled !== false;
});
vi.mock("@/server/web-push", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/web-push")>();
  return {
    ...actual,
    pauseEndingNotificationEnabled: (...args: Parameters<typeof actual.pauseEndingNotificationEnabled>) => pauseEndingNotificationEnabled(...args),
    sendPauseEndingPush: (...args: unknown[]) => sendPauseEndingPush(...(args as [])),
  };
});

import { materializeDuePauseEndingNotifications, materializePauseEndingNotification } from "./pause-ending-notifications";

const PAUSE_REASON_ID = "00000000-0000-4000-8000-000000002501";

describe("pause ending notifications", () => {
  beforeEach(() => {
    sendPauseEndingPush.mockClear();
    pauseEndingNotificationEnabled.mockClear();
  });

  it("creates one private in-app warning and pushes it once in the final minute", async () => {
    const h = createTelephonyHarness();
    const startedAt = new Date(h.now().getTime() - 44 * 60_000).toISOString();
    h.setPresence(PROFILES.o1, { status: "paused", pause_reason_id: PAUSE_REASON_ID, status_since: startedAt });

    const first = await materializePauseEndingNotification(h.admin, {
      organizationId: ORG, profileId: PROFILES.o1, expectedPauseStartedAt: startedAt, now: h.now(),
    });
    expect(first).toMatchObject({ status: "delivered", delivered: true, phase: "warning", plannedEndAt: new Date(h.now().getTime() + 60_000).toISOString() });
    expect(h.rows("motorist_notifications")).toHaveLength(1);
    expect(h.rows("motorist_notifications")[0]).toMatchObject({
      organization_id: ORG,
      recipient_profile_id: PROFILES.o1,
      visibility: "private",
      kind: "system",
      severity: "warning",
      status: "unread",
      title: "Plánovaný koniec pauzy o 1 minútu",
      dedupe_key: `pause-ending:${PROFILES.o1}:${startedAt}`,
    });
    expect(sendPauseEndingPush).toHaveBeenCalledOnce();

    const duplicate = await materializePauseEndingNotification(h.admin, {
      organizationId: ORG, profileId: PROFILES.o1, expectedPauseStartedAt: startedAt, now: h.now(),
    });
    expect(duplicate).toMatchObject({ status: "duplicate", delivered: false, phase: "warning" });
    expect(h.rows("motorist_notifications")).toHaveLength(1);
    expect(sendPauseEndingPush).toHaveBeenCalledOnce();
  });

  it("honours opt-out, current pause identity and the strict warning window", async () => {
    const h = createTelephonyHarness();
    const startedAt = h.now().toISOString();
    h.setPresence(PROFILES.o1, { status: "paused", pause_reason_id: PAUSE_REASON_ID, status_since: startedAt });

    await expect(materializePauseEndingNotification(h.admin, {
      organizationId: ORG, profileId: PROFILES.o1, expectedPauseStartedAt: "2026-09-03T07:00:00.000Z", now: h.now(),
    })).resolves.toMatchObject({ status: "stale", delivered: false });
    await expect(materializePauseEndingNotification(h.admin, {
      organizationId: ORG, profileId: PROFILES.o1, expectedPauseStartedAt: startedAt, now: h.now(),
    })).resolves.toMatchObject({ status: "early", delivered: false });

    h.db.seed("motorist_call_notification_preferences", [{ organization_id: ORG, profile_id: PROFILES.o1, pause_ending_enabled: false }]);
    h.advance(44 * 60_000);
    await expect(materializePauseEndingNotification(h.admin, {
      organizationId: ORG, profileId: PROFILES.o1, expectedPauseStartedAt: startedAt, now: h.now(),
    })).resolves.toMatchObject({ status: "disabled", delivered: false });
    expect(h.rows("motorist_notifications")).toEqual([]);
    expect(sendPauseEndingPush).not.toHaveBeenCalled();
  });

  it("reports an overdue pause once after the planned end, independently of the warning", async () => {
    const h = createTelephonyHarness();
    // A two-minute pause (the tester's "Obed") whose whole warning window fell
    // between two cron runs: the overdue notice still arrives.
    h.db.update("motorist_pause_reasons", { max_minutes: 2 }, (row) => row.id === PAUSE_REASON_ID);
    const startedAt = new Date(h.now().getTime() - 7 * 60_000).toISOString();
    h.setPresence(PROFILES.o1, { status: "paused", pause_reason_id: PAUSE_REASON_ID, status_since: startedAt });

    const overdue = await materializePauseEndingNotification(h.admin, {
      organizationId: ORG, profileId: PROFILES.o1, expectedPauseStartedAt: startedAt, now: h.now(),
    });
    expect(overdue).toMatchObject({ status: "delivered", delivered: true, phase: "overdue", plannedEndAt: new Date(h.now().getTime() - 5 * 60_000).toISOString() });
    expect(h.rows("motorist_notifications")).toEqual([expect.objectContaining({
      recipient_profile_id: PROFILES.o1,
      title: "Plánovaný čas pauzy uplynul",
      dedupe_key: `pause-overdue:${PROFILES.o1}:${startedAt}`,
      payload: expect.objectContaining({ source: "pause_overdue", planned_end_at: new Date(h.now().getTime() - 5 * 60_000).toISOString() }),
    })]);
    expect(h.rows("motorist_notifications")[0].body).toContain("mala skončiť o");
    expect(sendPauseEndingPush).toHaveBeenCalledOnce();

    await expect(materializePauseEndingNotification(h.admin, {
      organizationId: ORG, profileId: PROFILES.o1, expectedPauseStartedAt: startedAt, now: h.now(),
    })).resolves.toMatchObject({ status: "duplicate", delivered: false, phase: "overdue" });
    expect(h.rows("motorist_notifications")).toHaveLength(1);
  });

  it("stays silent for an untimed pause and for one abandoned half a day ago", async () => {
    const h = createTelephonyHarness();
    const startedAt = new Date(h.now().getTime() - 13 * 60 * 60_000).toISOString();
    h.setPresence(PROFILES.o1, { status: "paused", pause_reason_id: PAUSE_REASON_ID, status_since: startedAt });
    await expect(materializePauseEndingNotification(h.admin, {
      organizationId: ORG, profileId: PROFILES.o1, expectedPauseStartedAt: startedAt, now: h.now(),
    })).resolves.toMatchObject({ status: "expired", delivered: false });

    h.db.update("motorist_pause_reasons", { max_minutes: null }, (row) => row.id === PAUSE_REASON_ID);
    h.setPresence(PROFILES.o1, { status_since: h.now().toISOString() });
    await expect(materializePauseEndingNotification(h.admin, {
      organizationId: ORG, profileId: PROFILES.o1, now: h.now(),
    })).resolves.toMatchObject({ status: "untimed", delivered: false });
    expect(h.rows("motorist_notifications")).toEqual([]);
    expect(sendPauseEndingPush).not.toHaveBeenCalled();
  });

  it("lets an opt-out racing the final claim suppress both deliveries", async () => {
    const h = createTelephonyHarness();
    const startedAt = new Date(h.now().getTime() - 44 * 60_000).toISOString();
    h.setPresence(PROFILES.o1, { status: "paused", pause_reason_id: PAUSE_REASON_ID, status_since: startedAt });
    pauseEndingNotificationEnabled.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(materializePauseEndingNotification(h.admin, {
      organizationId: ORG, profileId: PROFILES.o1, expectedPauseStartedAt: startedAt, now: h.now(),
    })).resolves.toMatchObject({ status: "disabled", delivered: false });
    expect(h.rows("motorist_notifications")).toEqual([]);
    expect(sendPauseEndingPush).not.toHaveBeenCalled();
  });

  it("lets the existing cron scan all paused operators while each notice remains idempotent", async () => {
    const h = createTelephonyHarness();
    h.setPresence(PROFILES.o1, { status: "paused", pause_reason_id: PAUSE_REASON_ID, status_since: new Date(h.now().getTime() - 44 * 60_000).toISOString() });
    h.setPresence(PROFILES.o2, { status: "paused", pause_reason_id: PAUSE_REASON_ID, status_since: new Date(h.now().getTime() - 50 * 60_000).toISOString() });
    h.setPresence(PROFILES.o5, { status: "paused", pause_reason_id: PAUSE_REASON_ID, status_since: h.now().toISOString() });
    const result = await materializeDuePauseEndingNotifications(h.admin, ORG, h.now());
    expect(result).toMatchObject({ checked: 3, delivered: 2, overdue: 1, early: 1 });
    expect(h.rows("motorist_notifications").map((row) => row.dedupe_key)).toEqual([
      expect.stringMatching(`^pause-overdue:${PROFILES.o2}:`),
      expect.stringMatching(`^pause-ending:${PROFILES.o1}:`),
    ]);

    const again = await materializeDuePauseEndingNotifications(h.admin, ORG, h.now());
    expect(again).toMatchObject({ checked: 3, delivered: 0, duplicate: 2, early: 1 });
  });
});
