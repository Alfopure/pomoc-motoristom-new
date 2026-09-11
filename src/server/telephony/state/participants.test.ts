import { describe, expect, it } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import { observeParticipants, participantManifest } from "./participants";
import { readMeta, toJson, type SessionRow } from "./types";
import { createTelephonyHarness, PROFILES } from "@/test/telephony-harness";

type Interval = Database["public"]["Tables"]["motorist_call_participant_intervals"]["Row"];
const startedAt = "2026-09-06T12:00:05.000Z", endedAt = "2026-09-06T12:02:00.000Z";
const session = { started_at: "2026-09-06T12:00:00.000Z", ended_at: endedAt, metadata: { recording: { policy: { channelMappingVerified: true }, noticeCompletedAt: "2026-09-06T12:00:04.000Z", suppressionReason: null, recorders: [{ id: "recorder", error: null }] } } } as unknown as SessionRow;
function interval(role: string, channel: number | null): Interval {
  return { leg_id: role, profile_id: role === "operator" ? "authenticated-profile" : null, role, started_at: "2026-09-06T12:00:06.000Z", ended_at: endedAt,
    audible_to_customer: true, reason: "customer_bridge", channel, verified: true, source_event_id: `bridged-${role}` } as Interval;
}
const proof = { session, startedAt, endedAt, recorderId: "recorder" };

describe("participant evidence", () => {
  it("keeps recording interval work off a frozen silent call's control path", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound();
    const silent = h.session(call.sessionId) as SessionRow;
    expect(readMeta(silent).recording?.policy.enabled).toBe(false);
    h.db.log.length = 0;
    await observeParticipants(h.admin, silent, "silent-answer", h.now().toISOString(), true);
    expect(h.db.log).toEqual([]);
  });

  it("closes existing recorded evidence even when the call's policy is now disabled", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound();
    const leg = h.legFor(call.sessionId, PROFILES.o1)!;
    const original = h.session(call.sessionId) as SessionRow;
    h.db.insert("motorist_call_participant_intervals", { id: "open-evidence", organization_id: original.organization_id,
      call_id: h.call(call.sessionId)!.id, session_id: original.id, leg_id: leg.id, profile_id: PROFILES.o1,
      role: "operator", started_at: h.now().toISOString(), ended_at: null, topology_epoch: 0, verified: true });
    const ended = { ...original, state: "ended", ended_at: h.now().toISOString(), metadata: toJson({ ...readMeta(original),
      recording: { ...readMeta(original).recording!, recorders: [{ id: "past-capture", epoch: 0, observed: "stopped", desired: "stopped" }] } }) } as SessionRow;
    await observeParticipants(h.admin, ended, "hangup", h.now().toISOString(), true);
    expect(h.rows("motorist_call_participant_intervals")[0].ended_at).toBe(h.now().toISOString());
  });

  it("permits completeness only for observed, mapped, fully covered intervals", () => {
    const manifest = participantManifest([interval("operator", 1), interval("customer", 0)], 0, proof);
    expect(manifest).toMatchObject({ coverage: "verified", channelMappingVerified: true, openingComplete: true, conversationComplete: true, closingComplete: true, gaps: [] });
    expect(manifest.intervals.every((item) => item.identityVerified)).toBe(true);
  });

  it("does not guess speakers in a conference mix or from row order", () => {
    const manifest = participantManifest([interval("operator", null), interval("customer", null)], 1, proof);
    expect(manifest).toMatchObject({ coverage: "unverified", conversationComplete: false, openingComplete: false, closingComplete: false });
    expect(manifest.intervals.map((item) => item.channel)).toEqual([null, null]);
    expect(manifest.gaps).toEqual([{ startSeconds: 5, endSeconds: 120, reason: "participant_identity_unverified" }]);
  });

  it("preserves missing opening/end and objection barriers", () => {
    const rows = [interval("customer", 0), interval("operator", 1)];
    expect(participantManifest(rows, 0, { ...proof, startedAt: "2026-09-06T12:00:10.000Z" })).toMatchObject({ openingComplete: false, conversationComplete: false });
    expect(participantManifest(rows.map((row) => ({ ...row, ended_at: null })), 0, proof)).toMatchObject({ closingComplete: false, conversationComplete: false });
    const suppressed = { ...session, metadata: { recording: { ...(session.metadata as { recording: object }).recording, suppressionReason: "objection" } } } as unknown as SessionRow;
    expect(participantManifest(rows, 0, { ...proof, session: suppressed }).conversationComplete).toBe(false);
  });

  it("requires server channel proof even for rows containing plausible channel labels", () => {
    const unproven = { ...session, metadata: { recording: { ...(session.metadata as { recording: object }).recording, policy: { channelMappingVerified: false } } } } as unknown as SessionRow;
    expect(participantManifest([interval("customer", 0), interval("operator", 1)], 0, { ...proof, session: unproven })).toMatchObject({ channelMappingVerified: false, coverage: "unverified", conversationComplete: false });
  });
});
