import { describe, expect, it } from "vitest";
import type { MobileBranchExecution, MobileBranchRequest } from "../../../src/lib/mobile-api";
import { branchActions, branchState, branchStateLabels, branchStateTones, executors, sortRequests, waiting } from "./model";

const id = (n: number) => `98000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const GROUP = id(1);
function request(patch: Partial<MobileBranchRequest> = {}): MobileBranchRequest {
  return { id: id(2), kind: "delivery", status: "queued", revision: 1, groupId: GROUP, groupName: "Žilina", caseNumber: null, customer: null, vehicle: null, pickup: "A", destination: "B",
    dueAt: null, note: "", routedAt: "2026-10-28T08:00:00Z", claimedByMe: false, claimedByName: null, claimedAt: null, execution: null, ...patch };
}
const execution = (patch: Partial<MobileBranchExecution> = {}): MobileBranchExecution => ({ owner: "logistics", status: "assigned", revision: 2, assigneeId: id(3), assignee: "Pavol",
  scheduledAt: null, plannedEndAt: null, confirmedAt: null, startedAt: null, finishedAt: null, done: false, cancelled: false, ...patch });

describe("Pobočka model", () => {
  it("lets a lead claim, then assign or release only own claims", () => {
    expect(branchActions(request(), false)).toMatchObject({ claim: true, release: false, assign: null });
    expect(branchActions(request({ status: "claimed", claimedByMe: false }), true)).toMatchObject({ claim: false, release: false, assign: null, createTow: false });
    expect(branchActions(request({ status: "claimed", claimedByMe: true }), false)).toMatchObject({ release: true, assign: "materialize" });
    expect(branchActions(request({ status: "claimed", claimedByMe: true, kind: "tow" }), false)).toMatchObject({ assign: null, createTow: false, towOfficeOnly: true });
    expect(branchActions(request({ status: "claimed", claimedByMe: true, kind: "tow" }), true)).toMatchObject({ createTow: true });
  });
  it("reassigns only work that has not started and reopens a cancelled one", () => {
    expect(branchActions(request({ status: "assigned", execution: execution() }), false).assign).toBe("reassign");
    expect(branchActions(request({ status: "assigned", execution: execution({ startedAt: "2026-10-28T09:00:00Z" }) }), false).assign).toBeNull();
    expect(branchActions(request({ status: "assigned", execution: execution({ owner: "towing_order" }) }), false).assign).toBeNull();
    expect(branchActions(request({ status: "assigned", execution: execution({ cancelled: true }) }), false)).toMatchObject({ reopen: true, assign: null });
    expect(branchState(request({ status: "assigned", execution: execution({ startedAt: "2026-10-28T09:00:00Z" }) }))).toBe("in_progress");
    expect(branchState(request({ status: "assigned", execution: execution({ done: true }) }))).toBe("done");
  });
  it("shows the executor's acceptance between Pridelené and Prebieha", () => {
    const accepted = request({ status: "assigned", execution: execution({ status: "accepted" }) });
    expect(branchState(request({ status: "assigned", execution: execution() }))).toBe("assigned");
    expect(branchState(accepted)).toBe("accepted");
    expect([branchStateLabels.accepted, branchStateTones.accepted]).toEqual(["Prijaté vykonávateľom", "green"]);
    expect(waiting(accepted)).toBe(false);
    expect(branchActions(accepted, false).assign).toBe("reassign");
    expect(branchState(request({ status: "assigned", execution: execution({ status: "en_route", startedAt: "2026-10-28T09:00:00Z" }) }))).toBe("in_progress");
    expect(branchState(request({ status: "assigned", execution: execution({ status: "accepted", cancelled: true }) }))).toBe("cancelled");
  });
  it("offers only group members who deliver, never for an odťah", () => {
    const groups = [{ id: GROUP, name: "Žilina", receivesNew: true, counts: { queued: 0, claimed: 0, active: 0, overdue: 0 },
      members: [{ id: id(4), name: "Pristavovač", role: "member" as const, canDeliver: true, canDrive: false }, { id: id(5), name: "Vodič", role: "member" as const, canDeliver: false, canDrive: true }] }];
    expect(executors(groups, request()).map(member => member.id)).toEqual([id(4)]);
    expect(executors(groups, request({ kind: "tow" }))).toEqual([]);
    expect(executors(groups, request({ groupId: id(9) }))).toEqual([]);
  });
  it("puts the queue first, by term", () => {
    const sorted = sortRequests([request({ id: id(6), status: "assigned", execution: execution() }), request({ id: id(7), dueAt: "2026-10-28T12:00:00Z" }), request({ id: id(8), dueAt: "2026-10-28T10:00:00Z" })]);
    expect(sorted.map(item => item.id)).toEqual([id(8), id(7), id(6)]);
  });
});
