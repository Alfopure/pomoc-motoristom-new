import type { MobileBranchGroup, MobileBranchKind, MobileBranchRequest } from "../../../src/lib/mobile-api";
import type { TagTone } from "../design/detail";

/** Pobočka without any screen: the state of a request and what the local lead may do with it. */
export const branchKindLabels: Record<MobileBranchKind, string> = { delivery: "Pristavenie", collection: "Odvoz vozidla", transfer: "Presun", tow: "Odťah" };
export type BranchState = "queued" | "claimed" | "assigned" | "in_progress" | "done" | "cancelled";
export const branchStateLabels: Record<BranchState, string> = { queued: "Čaká na prevzatie", claimed: "Prevzaté", assigned: "Pridelené", in_progress: "Prebieha", done: "Hotové", cancelled: "Zrušené" };
export const branchStateTones: Record<BranchState, TagTone> = { queued: "orange", claimed: "yellow", assigned: "blue", in_progress: "blue", done: "gray", cancelled: "gray" };

/** As on the web: once an execution exists, its state wins. */
export function branchState(request: Pick<MobileBranchRequest, "status" | "execution">): BranchState {
  if (request.status === "cancelled" || request.execution?.cancelled) return "cancelled";
  if (request.execution?.done) return "done";
  if (request.execution?.startedAt) return "in_progress";
  return request.status === "assigned" ? "assigned" : request.status;
}
export function waiting(request: Pick<MobileBranchRequest, "status" | "execution">): boolean {
  const state = branchState(request);
  return state === "queued" || state === "claimed";
}

export type BranchActions = {
  claim: boolean; release: boolean;
  /** Prideliť vykonávateľa: a claimed logistics request (materialize) or a not started jazda (operate assign). */
  assign: "materialize" | "reassign" | null;
  /** A claimed odťah becomes a towing order; the driver is assigned in the towing office. */
  createTow: boolean; towOfficeOnly: boolean; reopen: boolean;
};
export function branchActions(request: MobileBranchRequest, canOperateTowing: boolean): BranchActions {
  const mine = request.status === "claimed" && request.claimedByMe, execution = request.execution;
  return {
    claim: request.status === "queued",
    release: mine,
    assign: mine && request.kind !== "tow" ? "materialize"
      : request.status === "assigned" && execution?.owner === "logistics" && !execution.startedAt && !execution.done && !execution.cancelled ? "reassign" : null,
    createTow: mine && request.kind === "tow" && canOperateTowing,
    towOfficeOnly: mine && request.kind === "tow" && !canOperateTowing,
    reopen: request.status === "assigned" && Boolean(execution?.cancelled),
  };
}
/** Who can take a jazda/odvoz/presun: active members of the request's group with `deliver`. */
export function executors(groups: readonly MobileBranchGroup[], request: Pick<MobileBranchRequest, "groupId" | "kind">): MobileBranchGroup["members"] {
  if (request.kind === "tow") return [];
  return (groups.find(group => group.id === request.groupId)?.members ?? []).filter(member => member.canDeliver);
}
/** Queue first (oldest routing first), then running work by its term. */
export function sortRequests(requests: readonly MobileBranchRequest[]): MobileBranchRequest[] {
  const term = (request: MobileBranchRequest) => request.dueAt ? Date.parse(request.dueAt) : Number.POSITIVE_INFINITY;
  return [...requests].sort((a, b) => Number(waiting(b)) - Number(waiting(a)) || term(a) - term(b) || Date.parse(a.routedAt) - Date.parse(b.routedAt) || a.id.localeCompare(b.id));
}
