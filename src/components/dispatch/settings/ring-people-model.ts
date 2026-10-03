import { isDestinationAllowed } from "@/lib/telephony/destinations";
import { normalizeE164 } from "@/lib/telephony/normalize-e164";
import type { OperatorDoc } from "@/server/telephony/config-service";

import { newMemberDraft, type GroupDraft, type MemberDraft } from "./ring-groups-model";

export type PersonDevice = "web" | "mobile";
export type RingPeopleContext = {
  operators: readonly OperatorDoc[];
  mobileAvailable: boolean;
  destinationAllowlist: readonly string[];
  /** A read-only response can redact the delivery setting. Do not guess Web. */
  canReadDelivery: boolean;
  invalidMemberKeys?: ReadonlySet<string>;
  detachedDevices?: ReadonlyMap<string, DetachedPersonDevice>;
};
export type RingPerson = {
  kind: "person";
  key: string;
  operator: OperatorDoc;
  web: MemberDraft | null;
  mobile: MemberDraft | null;
  mobileNumber: string | null;
  mobileUnavailable: string | null;
};
export type RingPeopleRow = RingPerson | { kind: "member"; key: string; member: MemberDraft };
export type DetachedPersonDevice = { member: MemberDraft; beforeKeys: string[]; afterKeys: string[] };
export type DetachedPersonDevices = Map<string, Map<string, DetachedPersonDevice>>;

function ownerOf(member: MemberDraft, context: RingPeopleContext): OperatorDoc | null {
  if (member.memberKind === "operator") return context.operators.find(operator => operator.profileId === member.profileId) ?? null;
  if (member.ownerProfileId) return context.operators.find(operator => operator.profileId === member.ownerProfileId) ?? null;
  const number = normalizeE164(member.externalNumber);
  if (!number) return null;
  const matching = context.operators.filter(operator => normalizeE164(operator.settings?.defaultMobileNumber) === number);
  return matching.length === 1 ? matching[0] : null;
}

function usesPersonalMobile(operator: OperatorDoc, context: RingPeopleContext) {
  const number = normalizeE164(operator.settings?.defaultMobileNumber);
  return context.mobileAvailable && operator.settings?.deliveryMode === "personal_mobile" && number && isDestinationAllowed(number, context.destinationAllowlist);
}

/** A presentation only: never sort, rewrite or coalesce the underlying endpoints. */
export function ringPeopleRows(members: readonly MemberDraft[], context: RingPeopleContext): RingPeopleRow[] {
  const candidates = new Map<string, { operator: OperatorDoc; members: MemberDraft[] }>();
  for (const member of members) {
    const operator = ownerOf(member, context);
    if (!operator) continue;
    const candidate = candidates.get(operator.profileId) ?? { operator, members: [] };
    candidate.members.push(member);
    candidates.set(operator.profileId, candidate);
  }
  const people = new Map<string, RingPerson>();
  for (const { operator, members: endpoints } of candidates.values()) {
    const web = endpoints.filter(member => member.memberKind === "operator");
    const mobile = endpoints.filter(member => member.memberKind === "external_number");
    // The simple controls must not hide invalid rows, duplicate devices or a
    // personal-mobile setting that replaces Web on the operator endpoint.
    if (web.length > 1 || mobile.length > 1 || usesPersonalMobile(operator, context)) continue;
    if (!context.canReadDelivery && !operator.settings) continue;
    if (endpoints.some(member => context.invalidMemberKeys?.has(member.key))) continue;
    if (mobile.some(member => !normalizeE164(member.externalNumber) || !isDestinationAllowed(normalizeE164(member.externalNumber)!, context.destinationAllowlist))) continue;
    const detachedMobile = context.detachedDevices?.get(`${operator.profileId}:mobile`)?.member;
    const number = normalizeE164(mobile[0]?.externalNumber || detachedMobile?.externalNumber || operator.settings?.defaultMobileNumber);
    const matchingDefaults = number ? context.operators.filter(candidate => normalizeE164(candidate.settings?.defaultMobileNumber) === number) : [];
    const usedElsewhere = number && members.some(member => member.memberKind === "external_number" && !endpoints.includes(member) && normalizeE164(member.externalNumber) === number);
    const unavailable = !context.mobileAvailable ? "Zvonenie na osobné čísla tu nie je dostupné."
      : !number ? "Operátor nemá nastavené platné osobné číslo."
      : !isDestinationAllowed(number, context.destinationAllowlist) ? "Osobné číslo nie je v povolených destináciách."
      : !mobile.length && !detachedMobile?.ownerProfileId && matchingDefaults.length > 1 ? "Osobné číslo patrí viacerým operátorom. Najprv vyjasni jeho vlastníctvo."
      : !mobile.length && usedElsewhere ? "Toto číslo už má samostatný záznam v skupine."
      : null;
    const person: RingPerson = { kind: "person", key: `person-${operator.profileId}`, operator, web: web[0] ?? null, mobile: mobile[0] ?? null, mobileNumber: number, mobileUnavailable: unavailable };
    for (const member of endpoints) people.set(member.key, person);
  }
  const seen = new Set<string>();
  return members.flatMap<RingPeopleRow>(member => {
    const person = people.get(member.key);
    if (!person) return [{ kind: "member" as const, key: member.key, member }];
    if (seen.has(person.key)) return [];
    seen.add(person.key);
    return [person];
  });
}

/** Only an explicit toggle changes membership. A toggle back restores the exact draft. */
export function setPersonDevice(
  group: GroupDraft,
  profileId: string,
  device: PersonDevice,
  enabled: boolean,
  context: RingPeopleContext,
  retained?: DetachedPersonDevice,
): { group: GroupDraft; detached?: DetachedPersonDevice } {
  const person = ringPeopleRows(group.members, context).find((row): row is RingPerson => row.kind === "person" && row.operator.profileId === profileId);
  if (!person) return { group };
  const current = person[device];
  if (Boolean(current) === enabled) return { group };
  if (!enabled && current) {
    // Removing a person is a separate explicit action, so a last device cannot
    // disappear and leave its unchecked control impossible to find again.
    if (!person[device === "web" ? "mobile" : "web"] || (device === "web" && person.mobileUnavailable)) return { group };
    const index = group.members.indexOf(current);
    return {
      group: { ...group, members: group.members.filter(member => member.key !== current.key) },
      detached: { member: current, beforeKeys: group.members.slice(0, index).map(member => member.key), afterKeys: group.members.slice(index + 1).map(member => member.key) },
    };
  }
  if (device === "mobile" && person.mobileUnavailable) return { group };
  const member = retained?.member ?? (device === "web"
    ? { ...newMemberDraft("operator"), profileId }
    : { ...newMemberDraft("external_number"), externalNumber: person.mobileNumber!, ownerProfileId: profileId });
  // A detached item can only be restored for the same person and channel. All
  // candidates still go through the normal routing validation before saving.
  if (ownerOf(member, context)?.profileId !== profileId || (member.memberKind === "operator") !== (device === "web")) return { group };
  if (device === "mobile") {
    const number = normalizeE164(member.externalNumber);
    if (!number || !isDestinationAllowed(number, context.destinationAllowlist) || group.members.some(candidate => candidate.memberKind === "external_number" && normalizeE164(candidate.externalNumber) === number)) return { group };
  }
  const members = [...group.members];
  const nextKey = retained?.afterKeys.find(key => members.some(candidate => candidate.key === key));
  const previousKey = retained?.beforeKeys.findLast(key => members.some(candidate => candidate.key === key));
  const index = nextKey ? members.findIndex(candidate => candidate.key === nextKey) : previousKey ? members.findIndex(candidate => candidate.key === previousKey) + 1 : members.length;
  members.splice(index, 0, member);
  return { group: { ...group, members } };
}
