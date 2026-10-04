import { describe, expect, it } from "vitest";
import { DEFAULT_OPERATOR_SETTINGS } from "@/lib/telephony/operator-settings";
import type { OperatorDoc } from "@/server/telephony/config-service";
import { ringGroupsPayload, type GroupDraft, type MemberDraft } from "./ring-groups-model";
import { ringPeopleRows, setPersonDevice, type RingPeopleContext, type RingPerson } from "./ring-people-model";

const operator: OperatorDoc = { profileId: "martin", displayName: "Martin Novák", active: true, role: "dispatcher", device: null, settings: { ...DEFAULT_OPERATOR_SETTINGS, deliveryMode: "web", defaultMobileNumber: "+421900000001" } };
const other: OperatorDoc = { ...operator, profileId: "jana", displayName: "Jana Nováková", settings: null };
const web: MemberDraft = { key: "web", id: "stored-web", memberKind: "operator", profileId: operator.profileId, externalNumber: "", ringSecs: "31" };
const mobile: MemberDraft = { key: "mobile", id: "stored-mobile", memberKind: "external_number", profileId: null, externalNumber: "+421900000001", ownerProfileId: operator.profileId, ringSecs: "17" };
const between: MemberDraft = { ...web, key: "between", id: "stored-between", profileId: other.profileId, ringSecs: "23" };
const context: RingPeopleContext = { operators: [operator, other], mobileAvailable: true, destinationAllowlist: ["SK", "CZ"], canReadDelivery: true };
function group(members: MemberDraft[] = [web, between, mobile]): GroupDraft {
  return { key: "g", id: "stored-g", name: "Pomoc", active: true, description: "", members };
}
function person(members: MemberDraft[], ctx = context) {
  return ringPeopleRows(members, ctx).find((row): row is RingPerson => row.kind === "person" && row.operator.profileId === operator.profileId)!;
}

describe("person presentation of simultaneous ringing", () => {
  it("groups nonadjacent devices without rewriting their position, ids, ownership or hidden times", () => {
    const draft = group();
    const before = ringGroupsPayload([draft]);
    const rows = ringPeopleRows(draft.members, context);
    expect(rows.map(row => row.kind === "person" ? row.operator.profileId : row.key)).toEqual(["martin", "jana"]);
    expect(person(draft.members)).toMatchObject({ web, mobile });
    expect(ringGroupsPayload([draft])).toEqual(before);
    expect(draft.members).toEqual([web, between, mobile]);
  });

  it("groups a uniquely inferred owner but leaves ambiguous and unknown ownership explicit", () => {
    const inferred = { ...mobile, ownerProfileId: null };
    expect(person([web, inferred]).mobile).toEqual(inferred);
    const ambiguousContext = { ...context, operators: [operator, { ...other, settings: operator.settings }] };
    expect(ringPeopleRows([inferred], ambiguousContext)).toEqual([{ kind: "member", key: mobile.key, member: inferred }]);
    const unknown = { ...mobile, ownerProfileId: "deleted-operator" };
    expect(ringPeopleRows([unknown], context)[0].kind).toBe("member");
    // Explicit ownership wins over coincident defaults, just as in the router.
    expect(person([web, mobile], ambiguousContext).mobile).toBe(mobile);
  });

  it("does not simplify duplicates, invalid rows or personal-mobile replacement into Web controls", () => {
    const duplicate = { ...mobile, key: "another-mobile", id: "another", externalNumber: "+421900000002" };
    expect(ringPeopleRows([web, mobile, duplicate], context).every(row => row.kind === "member")).toBe(true);
    expect(ringPeopleRows([web, { ...web, key: "duplicate" }], context).every(row => row.kind === "member")).toBe(true);
    expect(ringPeopleRows([web, mobile], { ...context, invalidMemberKeys: new Set([mobile.key]) }).every(row => row.kind === "member")).toBe(true);
    expect(ringPeopleRows([web, mobile], { ...context, operators: [{ ...operator, settings: { ...operator.settings!, deliveryMode: "personal_mobile" } }] }).every(row => row.kind === "member")).toBe(true);
  });

  it("does not guess redacted operator delivery and retains unsupported existing mobile endpoints", () => {
    expect(ringPeopleRows([between], { ...context, canReadDelivery: false })[0].kind).toBe("member");
    const unavailable = person([web, mobile], { ...context, mobileAvailable: false });
    expect(unavailable.mobile).toBe(mobile);
    expect(unavailable.mobileUnavailable).toContain("nie je dostupné");
  });
});

describe("explicit device changes", () => {
  it("restores the same hidden times, member ids and interleaved order when toggled back", () => {
    for (const device of ["web", "mobile"] as const) {
      const draft = group();
      const removed = setPersonDevice(draft, operator.profileId, device, false, context);
      expect(removed.group.members).toEqual(device === "web" ? [between, mobile] : [web, between]);
      expect(removed.detached?.member).toBe(device === "web" ? web : mobile);
      const restored = setPersonDevice(removed.group, operator.profileId, device, true, context, removed.detached);
      expect(ringGroupsPayload([restored.group])).toEqual(ringGroupsPayload([draft]));
      expect(restored.group.members.map(member => member.key)).toEqual(["web", "between", "mobile"]);
    }
  });

  it("restores a custom owned number even when no personal default is configured", () => {
    const ctx = { ...context, operators: [{ ...operator, settings: null }, other] };
    const removed = setPersonDevice(group(), operator.profileId, "mobile", false, ctx);
    const retained = new Map([[`${operator.profileId}:mobile`, removed.detached!]]);
    const withRetained = { ...ctx, detachedDevices: retained };
    expect(person(removed.group.members, withRetained)).toMatchObject({ mobileNumber: mobile.externalNumber, mobileUnavailable: null });
    const restored = setPersonDevice(removed.group, operator.profileId, "mobile", true, withRetained, removed.detached);
    expect(restored.group.members).toEqual(group().members);
  });

  it("adds only an explicitly owned mobile at the end and leaves every existing member unchanged", () => {
    const draft = group([web, between]);
    const added = setPersonDevice(draft, operator.profileId, "mobile", true, context).group;
    expect(added.members.slice(0, 2)).toEqual(draft.members);
    expect(added.members[2]).toMatchObject({ id: null, memberKind: "external_number", externalNumber: "+421900000001", ownerProfileId: "martin", ringSecs: "" });
    expect(ringGroupsPayload([added])[0].members.map(member => member.position)).toEqual([0, 1, 2]);
  });

  it("keeps the final device until the person is explicitly removed", () => {
    for (const device of ["web", "mobile"] as const) {
      const draft = group([device === "web" ? web : mobile]);
      expect(setPersonDevice(draft, operator.profileId, device, false, context).group).toBe(draft);
    }
  });

  it("keeps Web when an existing mobile is unavailable instead of leaving only a skipped endpoint", () => {
    const draft = group([web, mobile]);
    expect(setPersonDevice(draft, operator.profileId, "web", false, { ...context, mobileAvailable: false }).group).toBe(draft);
  });

  it("refuses unavailable, disallowed, ambiguous or already-used mobile additions", () => {
    const ambiguous = { ...other, settings: operator.settings };
    for (const ctx of [
      { ...context, mobileAvailable: false },
      { ...context, destinationAllowlist: ["CZ"] },
      { ...context, operators: [{ ...operator, settings: null }] },
      { ...context, operators: [operator, ambiguous] },
    ]) {
      const draft = group([web]);
      expect(person(draft.members, ctx).mobileUnavailable).toBeTruthy();
      expect(setPersonDevice(draft, operator.profileId, "mobile", true, ctx).group).toBe(draft);
    }
    const conflicting = group([web, { ...mobile, ownerProfileId: other.profileId }]);
    expect(setPersonDevice(conflicting, operator.profileId, "mobile", true, context).group).toBe(conflicting);
  });

  it("restores relative to retained neighbours after an unrelated recipient is removed", () => {
    const removed = setPersonDevice(group(), operator.profileId, "mobile", false, context);
    const withoutBetween = { ...removed.group, members: [web] };
    const restored = setPersonDevice(withoutBetween, operator.profileId, "mobile", true, context, removed.detached);
    expect(restored.group.members).toEqual([web, mobile]);
  });
});
