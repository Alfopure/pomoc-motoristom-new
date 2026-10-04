import { describe, expect, it } from "vitest";
import type { IncomingFlow } from "@/lib/telephony/incoming-flow";
import { PROFILES } from "@/test/telephony-harness";
import { materialiseIncomingFlow } from "./incoming-flow";
import { memberKey, planRingStep, resolvePersonalRingMembers } from "./ring-plan";

const now = new Date("2026-09-03T08:00:00.000Z");
const flow: IncomingFlow = { version: 1, ending: "hangup", steps: [
  { id: "ring", type: "ring", seconds: 20, people: [{ profileId: PROFILES.o1, application: true, personalNumber: "+421910988882" }] },
  { id: "wait", type: "wait", minutes: 15 },
  { id: "retry", type: "repeat", stepIds: ["ring"], times: 2 },
  { id: "backup", type: "external", number: "+421900000000", seconds: 30 },
] };
const presence = [{ profileId: PROFILES.o1, status: "available" as const }];
const web = { profileId: PROFILES.o1, sipUsername: "web", deviceSeenAt: now.toISOString(), registrationState: "registered" };
const mobile = { ...web, sipUsername: "app" };

describe("incoming flow compilation", () => {
  it("gives every repeated offer a distinct execution index without legacy row references", () => {
    const plan = materialiseIncomingFlow(flow, now);
    expect(plan).toMatchObject({ source: "incoming_flow", planId: null, fallback: { kind: "hangup", number: null } });
    expect(plan.steps.map(step => [step.index, step.kind, step.sourceId])).toEqual([[0, "ring", "ring"], [1, "wait", "wait"], [2, "ring", "ring"], [3, "ring", "ring"], [4, "ring", "backup"]]);
    expect(plan.steps.every(step => step.groupId === null)).toBe(true);
    expect(plan.steps[1]).toMatchObject({ waitMinutes: 15, members: [] });
    expect(plan.steps[0].members).toEqual([
      expect.objectContaining({ kind: "operator", application: true, profileId: PROFILES.o1 }),
      expect.objectContaining({ kind: "external_number", ownerProfileId: PROFILES.o1, provenance: "personal_mobile", externalNumber: "+421910988882" }),
    ]);
    const changed = structuredClone(flow);
    const frozen = materialiseIncomingFlow(changed, now);
    if (changed.steps[0].type === "ring") changed.steps[0].people[0].personalNumber = "+421911111111";
    expect(frozen.steps[0].members[1].externalNumber).toBe("+421910988882");
  });

  it("counts app web, mobile app and personal number separately against capacity", () => {
    const step = materialiseIncomingFlow(flow, now).steps[0];
    const input = { sessionId: "call", now, presence, devices: [web], mobileDevices: [mobile], openOffers: [], attempted: new Set<string>(), ownedPstnEnabled: true };
    const planned = planRingStep(step, input);
    expect(planned.attempts.map(attempt => [attempt.applicationDevice ?? null, attempt.externalNumber])).toEqual([["web", null], ["mobile", null], [null, "+421910988882"]]);
    expect(new Set(planned.members.map(memberKey)).size).toBe(3);
    expect(planRingStep(step, { ...input, maxConcurrentLegs: 2, activeLegCount: 1 }).attempts).toHaveLength(1);
    expect(planRingStep(step, { ...input, maxFanout: 2 }).attempts).toHaveLength(2);
    const remaining = planRingStep(step, { ...input, attempted: new Set([memberKey({ profileId: PROFILES.o1, externalNumber: null })]) });
    expect(remaining.attempts.map(attempt => attempt.applicationDevice ?? attempt.externalNumber)).toEqual(["mobile", "+421910988882"]);
  });

  it("allows mobile-only app registration without requiring a live web device", () => {
    const step = materialiseIncomingFlow(flow, now).steps[0];
    const planned = planRingStep(step, { sessionId: "call", now, presence, devices: [], mobileDevices: [mobile], openOffers: [], attempted: new Set(), ownedPstnEnabled: true });
    expect(planned.attempts.map(attempt => attempt.applicationDevice ?? attempt.externalNumber)).toEqual(["mobile", "+421910988882"]);
    expect(planned.skipped.map(skip => [skip.member.applicationDevice, skip.reason])).toEqual([["web", "no_device"]]);
    const paused = planRingStep(step, { sessionId: "call", now, presence: [{ ...presence[0], status: "paused" }], devices: [web], mobileDevices: [mobile], openOffers: [], attempted: new Set(), ownedPstnEnabled: true });
    expect(paused.attempts).toEqual([]);
  });

  it("does not replace an explicit app choice with legacy personal delivery mode", () => {
    const member = materialiseIncomingFlow(flow, now).steps[0].members[0];
    expect(resolvePersonalRingMembers([member], [{ profile_id: PROFILES.o1, default_mobile_number: "+421910988882", delivery_mode: "personal_mobile" }], ["SK"], true)).toEqual([member]);
  });

  it("freezes a paused operator's nominated colleague without moving their personal number", () => {
    const plan = materialiseIncomingFlow(flow, now, {
      pausedProfileIds: new Set([PROFILES.o1]), destinationAllowlist: ["SK"],
      routing: [{ profileId: PROFILES.o1, mode: "operator", defaultMobileNumber: "+421910988882", forwardProfileId: PROFILES.o2, forwardNumber: null }],
    });
    expect(plan.steps[0].members).toEqual([
      expect.objectContaining({ kind: "operator", profileId: PROFILES.o2, application: true, externalNumber: null }),
      expect.objectContaining({ kind: "external_number", profileId: PROFILES.o1, ownerProfileId: PROFILES.o1, externalNumber: "+421910988882" }),
    ]);
    const planned = planRingStep(plan.steps[0], { sessionId: "call", now,
      presence: [{ profileId: PROFILES.o1, status: "paused" }, { profileId: PROFILES.o2, status: "available" }],
      devices: [{ ...web, profileId: PROFILES.o2 }], mobileDevices: [{ ...mobile, profileId: PROFILES.o2 }],
      openOffers: [], attempted: new Set(), ownedPstnEnabled: true });
    expect(planned.attempts.map(attempt => [attempt.profileId, attempt.applicationDevice])).toEqual([[PROFILES.o2, "web"], [PROFILES.o2, "mobile"]]);
    expect(planned.skipped.find(skip => skip.member.externalNumber)?.reason).toBe("paused");
  });
});
