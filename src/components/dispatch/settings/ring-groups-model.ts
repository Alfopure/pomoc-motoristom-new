/**
 * Pure model behind `RingGroupsEditor.tsx` (design §2.6, plan "Fáza 3").
 *
 * The editor never decides anything itself: drafting, drag-and-drop reordering,
 * the payload sent to `PUT /api/telephony/config/ring-groups` and the local
 * mirror of the server validation all live here, so the repo's node-only Vitest
 * setup can test them without a DOM.
 *
 * The local validation is a *mirror*, not the authority: the server validates
 * the merged routing world again (`validateRoutingReplace`) and stays the last
 * word. Mirroring it here only means the manager sees "táto skupina nemá
 * člena" while typing instead of after a round trip.
 */

import { isDestinationAllowed } from "@/lib/telephony/destinations";
import { normalizeE164 } from "@/lib/telephony/normalize-e164";
import type {
  RingGroupDoc,
  RingGroupInput,
  RingMemberKind,
  RingPlanDoc,
  ValidationIssue,
} from "@/server/telephony/config-service";

/** Mirrors the CHECK constraints and `config-service.ts`. */
export const MIN_RING_SECS = 5;
export const MAX_RING_SECS = 120;

/**
 * Used when the reader is not allowed to see the organisation settings. Writing
 * requires manager/admin, and those always get the real allowlist, so this only
 * keeps the preview honest for a read-only screen.
 */
export const FALLBACK_DESTINATION_ALLOWLIST = ["SK", "CZ"];

export type MemberDraft = {
  /** Stable identity of the row for React keys and dnd-kit; not a database id. */
  key: string;
  id: string | null;
  memberKind: RingMemberKind;
  profileId: string | null;
  externalNumber: string;
  /** Empty string = "use the step timeout". */
  ringSecs: string;
};

export type GroupDraft = {
  key: string;
  id: string | null;
  name: string;
  description: string;
  active: boolean;
  members: MemberDraft[];
};

let draftCounter = 0;

/** Monotonic key for a freshly added row (never leaves the browser). */
export function nextDraftKey(prefix: string): string {
  draftCounter += 1;
  return `${prefix}-${draftCounter}`;
}

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

export function groupDraftsFromDocument(groups: readonly RingGroupDoc[]): GroupDraft[] {
  return groups.map((group) => ({
    key: `group-${group.id}`,
    id: group.id,
    name: group.name,
    description: group.description ?? "",
    active: group.active,
    members: [...group.members]
      .sort((left, right) => left.position - right.position)
      .map((member) => ({
        key: `member-${member.id}`,
        id: member.id,
        memberKind: member.memberKind,
        profileId: member.profileId,
        externalNumber: member.externalNumber ?? "",
        ringSecs: member.ringSecs === null ? "" : String(member.ringSecs),
      })),
  }));
}

export function newGroupDraft(name = ""): GroupDraft {
  return { key: nextDraftKey("group"), id: null, name, description: "", active: true, members: [] };
}

export function newMemberDraft(memberKind: RingMemberKind): MemberDraft {
  return { key: nextDraftKey("member"), id: null, memberKind, profileId: null, externalNumber: "", ringSecs: "" };
}

// ---------------------------------------------------------------------------
// List operations (the component only forwards events)
// ---------------------------------------------------------------------------

export function addGroup(groups: readonly GroupDraft[]): GroupDraft[] {
  return [...groups, newGroupDraft()];
}

export function updateGroup(groups: readonly GroupDraft[], groupKey: string, patch: Partial<Omit<GroupDraft, "key" | "id" | "members">>): GroupDraft[] {
  return groups.map((group) => (group.key === groupKey ? { ...group, ...patch } : group));
}

export function addMember(groups: readonly GroupDraft[], groupKey: string, memberKind: RingMemberKind): GroupDraft[] {
  return groups.map((group) => (group.key === groupKey ? { ...group, members: [...group.members, newMemberDraft(memberKind)] } : group));
}

export function removeMember(groups: readonly GroupDraft[], groupKey: string, memberKey: string): GroupDraft[] {
  return groups.map((group) => (group.key === groupKey ? { ...group, members: group.members.filter((member) => member.key !== memberKey) } : group));
}

export function updateMember(groups: readonly GroupDraft[], groupKey: string, memberKey: string, patch: Partial<Omit<MemberDraft, "key" | "id">>): GroupDraft[] {
  return groups.map((group) =>
    group.key === groupKey ? { ...group, members: group.members.map((member) => (member.key === memberKey ? { ...member, ...patch } : member)) } : group,
  );
}

/**
 * Drag-and-drop reorder inside one group. Positions are derived from the array
 * order when the payload is built, so moving a row is a plain array move; the
 * member id travels with it and the server keeps `last_offered_at` per id, so
 * the `ordered` strategy does not forget who rang last.
 */
export function moveMember(members: readonly MemberDraft[], activeKey: string, overKey: string): MemberDraft[] {
  if (activeKey === overKey) return [...members];
  const from = members.findIndex((member) => member.key === activeKey);
  const to = members.findIndex((member) => member.key === overKey);
  if (from < 0 || to < 0) return [...members];
  const next = [...members];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function moveMemberInGroups(groups: readonly GroupDraft[], groupKey: string, activeKey: string, overKey: string): GroupDraft[] {
  return groups.map((group) => (group.key === groupKey ? { ...group, members: moveMember(group.members, activeKey, overKey) } : group));
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export function ringGroupsPayload(groups: readonly GroupDraft[]): RingGroupInput[] {
  return groups.map((group) => ({
    id: group.id,
    name: group.name.trim(),
    description: group.description.trim() ? group.description.trim() : null,
    active: group.active,
    members: group.members.map((member, index) => ({
      id: member.id,
      memberKind: member.memberKind,
      profileId: member.memberKind === "operator" ? member.profileId : null,
      externalNumber: member.memberKind === "external_number" ? normalizeE164(member.externalNumber) ?? member.externalNumber.trim() : null,
      position: index,
      ringSecs: parseRingSecs(member.ringSecs),
    })),
  }));
}

/** `""` means "no per-member time"; anything unparsable is reported by the validator. */
export function parseRingSecs(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
}

export function ringGroupsDirty(groups: readonly GroupDraft[], original: readonly RingGroupDoc[]): boolean {
  return JSON.stringify(ringGroupsPayload(groups)) !== JSON.stringify(ringGroupsPayload(groupDraftsFromDocument(original)));
}

// ---------------------------------------------------------------------------
// Validation mirror
// ---------------------------------------------------------------------------

export type GroupValidationContext = {
  /** Profile ids of the organisation's operators (`document.operators`). */
  operatorIds: readonly string[];
  destinationAllowlist: readonly string[];
  /** Plans as stored; a plan step keeps a group alive and demands a member. */
  plans: readonly RingPlanDoc[];
};

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

/**
 * Local mirror of `validateRoutingReplace`'s group half. Paths are draft keys
 * (group key or member key) so the editor can hang the message on the row that
 * caused it.
 */
export function validateRingGroupDrafts(groups: readonly GroupDraft[], context: GroupValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const operatorIds = new Set(context.operatorIds);
  const names = new Set<string>();
  const keptIds = new Set(groups.map((group) => group.id).filter((id): id is string => Boolean(id)));

  for (const group of groups) {
    const name = group.name.trim();
    if (!name) issues.push(issue(group.key, "name_required", "Skupina potrebuje názov."));
    const nameKey = name.toLocaleLowerCase("sk");
    if (nameKey && names.has(nameKey)) issues.push(issue(group.key, "duplicate_name", `Skupina s názvom „${name}" už existuje.`));
    names.add(nameKey);

    const seenProfiles = new Set<string>();
    const seenNumbers = new Set<string>();

    for (const member of group.members) {
      const ringSecs = parseRingSecs(member.ringSecs);
      if (ringSecs !== null && !Number.isFinite(ringSecs)) {
        issues.push(issue(member.key, "ring_secs_invalid", "Čas zvonenia musí byť celé číslo v sekundách."));
      } else if (ringSecs !== null && ringSecs < MIN_RING_SECS) {
        issues.push(issue(member.key, "ring_secs_too_low", `Čas zvonenia člena musí byť aspoň ${MIN_RING_SECS} s.`));
      } else if (ringSecs !== null && ringSecs > MAX_RING_SECS) {
        issues.push(issue(member.key, "ring_secs_too_high", `Čas zvonenia člena môže byť najviac ${MAX_RING_SECS} s.`));
      }

      if (member.memberKind === "operator") {
        if (!member.profileId) {
          issues.push(issue(member.key, "profile_required", "Vyber operátora."));
          continue;
        }
        if (!operatorIds.has(member.profileId)) {
          issues.push(issue(member.key, "profile_foreign", "Operátor nepatrí do tejto organizácie."));
          continue;
        }
        if (seenProfiles.has(member.profileId)) issues.push(issue(member.key, "duplicate_member", "Operátor je v skupine dvakrát."));
        seenProfiles.add(member.profileId);
        continue;
      }

      const normalized = normalizeE164(member.externalNumber);
      if (!normalized) {
        issues.push(issue(member.key, "number_invalid", "Externé číslo nie je platné (formát E.164, napr. +421900123456)."));
        continue;
      }
      if (!isDestinationAllowed(normalized, context.destinationAllowlist)) {
        issues.push(issue(member.key, "number_not_allowed", `Číslo ${normalized} nie je v povolených cieľoch organizácie.`));
      }
      if (seenNumbers.has(normalized)) issues.push(issue(member.key, "duplicate_member", "Číslo je v skupine dvakrát."));
      seenNumbers.add(normalized);
    }
  }

  // A group that a plan step uses may neither disappear nor lose its last member.
  for (const plan of context.plans) {
    for (const step of plan.steps) {
      if (!keptIds.has(step.ringGroupId)) {
        issues.push(issue("", "group_in_use", `Skupina sa nedá odstrániť: používa ju plán „${plan.name}".`));
        continue;
      }
      const group = groups.find((candidate) => candidate.id === step.ringGroupId);
      if (group && group.members.length === 0) {
        issues.push(issue(group.key, "group_empty", `Skupina nemá žiadneho člena, ale používa ju plán „${plan.name}".`));
      }
    }
  }

  return issues;
}

/** Names of the plans that use a saved group; the editor shows it as a note. */
export function plansUsingGroup(groupId: string | null, plans: readonly RingPlanDoc[]): string[] {
  if (!groupId) return [];
  return plans.filter((plan) => plan.steps.some((step) => step.ringGroupId === groupId)).map((plan) => plan.name);
}

/**
 * Sentence under the group header. Switching a group off is allowed even when a
 * plan uses it — that is how a shift is taken out of the rota for a while — but
 * `materialiseRingPlan` then skips the whole step, so the editor has to say so
 * out loud instead of letting the manager believe the group still rings.
 */
export function groupUsageNote(group: GroupDraft, plans: readonly RingPlanDoc[]): string | null {
  const used = plansUsingGroup(group.id, plans);
  if (used.length === 0) return group.active ? null : "Skupina je vypnutá a zatiaľ ju nepoužíva žiadny plán.";
  const list = used.join(", ");
  return group.active
    ? `Používajú ju plány: ${list}.`
    : `Skupina je vypnutá, v týchto plánoch sa krok preskočí: ${list}.`;
}

/** Steps that use this group, with the strategy each of them rings with. */
export function stepsUsingGroup(groupId: string | null, plans: readonly RingPlanDoc[]): Array<{ planName: string; strategy: string }> {
  if (!groupId) return [];
  return plans.flatMap((plan) => plan.steps.filter((step) => step.ringGroupId === groupId).map((step) => ({ planName: plan.name, strategy: step.strategy })));
}

/**
 * Amber note when the group has more members than the organisation lets ring at
 * once.
 *
 * `planRingStep` sorts by position, keeps `eligible.slice(0, maxFanout)` and
 * marks the rest `fanout`; for the `all` strategy `remainingAfter` is 0, so the
 * step is finished after that single fan-out and the members past the cap are
 * never dialled in it. "Zvoní všetkým" would be a lie.
 */
export function groupFanoutNote(group: GroupDraft, plans: readonly RingPlanDoc[], maxRingFanout: number | undefined): string | null {
  if (!maxRingFanout || maxRingFanout <= 0) return null;
  if (group.members.length <= maxRingFanout) return null;
  const usedByAll = stepsUsingGroup(group.id, plans).some((step) => step.strategy === "all");
  if (!usedByAll) return null;
  return `Skupina má ${group.members.length} členov, ale organizácia dovolí zvoniť naraz najviac ${maxRingFanout}. V kroku „všetkým naraz" sa na zvyšných v tomto kroku nedostane.`;
}

/**
 * Amber note when the per-member ring time cannot do anything.
 *
 * `planRingStep` builds every attempt with
 * `ringSecs: step.strategy === "ordered" ? member.ringSecs : step.timeoutSecs`,
 * so in an `all` step the member's own time is dropped and the phone rings for
 * the step timeout.
 */
export function memberRingSecsNote(group: GroupDraft, plans: readonly RingPlanDoc[]): string | null {
  const steps = stepsUsingGroup(group.id, plans);
  if (steps.length === 0) return null;
  if (steps.some((step) => step.strategy === "ordered")) return null;
  if (!group.members.some((member) => member.ringSecs.trim())) return null;
  return `Vlastný čas zvonenia člena sa použije len v kroku „postupne". Túto skupinu používajú len kroky „všetkým naraz", kde platí čas kroku.`;
}

/** Groups the issues by the draft key they belong to (`""` = whole form). */
export function issuesByPath(issues: readonly ValidationIssue[]): Map<string, ValidationIssue[]> {
  const map = new Map<string, ValidationIssue[]>();
  for (const item of issues) {
    const bucket = map.get(item.path);
    if (bucket) bucket.push(item);
    else map.set(item.path, [item]);
  }
  return map;
}
